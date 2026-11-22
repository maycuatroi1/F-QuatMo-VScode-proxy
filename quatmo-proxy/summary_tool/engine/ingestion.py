# -*- coding: utf-8 -*-
"""
Ingestion and M0 Preprocessing module for PhaseSUMMARY Engine.
Implements Spec 01 (M0) and 'đặc tả chuyển đổi log F-VSCode' (Version 3.0, 30/10/2026):
- Architecture Notice: In F-VSCode, the log collector is integrated directly into the
  VS Code Workbench core (src/vs/workbench/), NOT as an external extension.
- Discovering and loading student sessions from exam ZIP archives
- Extracting task configuration (starter_files, statement_paragraphs) from snapshot_start.zip
- Filtering multi-day practice clusters and trimming trailing UI-only noise (PP 5.1)
- Synchronizing server AI proxy logs (<student>.json) and enriching terminal runs (A10, A11)
- Deduplicating and pairing typing_chunk, paste, and edit_detected events with replacement ranges
- Preserving suffix characters when typing_chunk wraps a paste event
- Reconstructing code state S' = S[0:p] + x + S[p+d:] and character-level provenance Spans (PP 5.3)
- Handling Undo/Redo provenance restoration (3.3a), Cancelled pairs within 30s (3.3b, U28),
  and Repaste families within 5m (3.3c, U29)
- Extracting checkpoints from AI request context (A5, N3)
- Computing Data Quality Report DQ1 - DQ8 (PP 5.4, Spec 01 Section 4)
"""

import os
import io
import re
import json
import base64
import zipfile
import difflib
import datetime
from typing import Dict, List, Any, Optional, Set, Tuple
from .constants import DEFAULT_PARAMS, TASK_DIRS
from .session_window import resolve_window, select_records, request_time, exclude_request_conflicts


TASK_DIR_RE = re.compile(r"(?:^|[\\/\s])(" + "|".join(TASK_DIRS) + r")(?=[\\/>\s]|$)", re.IGNORECASE)


def task_dir_of(*texts: Any) -> Optional[str]:
    """Thư mục bài (Q1, Q2) trong chuỗi đường dẫn hoặc lệnh đầu tiên có nhắc tới, lấy lần nhắc cuối của chuỗi đó."""
    for text in texts:
        hits = TASK_DIR_RE.findall(str(text or ""))
        if hits:
            return hits[-1].upper()
    return None


def normalize_rel_path(uri_or_path: str) -> str:
    """Normalizes a VSCode file URI or Windows/POSIX path into a clean workspace-relative path."""
    if not uri_or_path:
        return ""
    s = uri_or_path.strip().replace("\\", "/")
    # Strip scheme if file://
    if s.startswith("file:///"):
        s = s[len("file:///"):]
    elif s.startswith("file://"):
        s = s[len("file://"):]
    # Remove URL encoding like %20 if present
    try:
        import urllib.parse
        s = urllib.parse.unquote(s)
    except Exception:
        pass
    # Q1/app.py và Q2/app.py là hai file khác nhau, phải giữ thư mục bài (B3)
    parts = [p for p in s.split("/") if p]
    for i, seg in enumerate(parts[:-1]):
        if seg.upper() in TASK_DIRS:
            return "/".join([seg.upper()] + parts[i + 1:])
    # Look for common project root markers
    for marker in ["/Lab1-Student/", "/Lab1/", "/student/", "/project/", "/workspace/"]:
        idx = s.find(marker)
        if idx != -1:
            return s[idx + len(marker):].lstrip("/")
    # Fallback: if path has templates/ or data/ or static/, keep from there
    if len(parts) >= 2 and parts[-2] in ("templates", "data", "static", "src", "tests", "routes", "models"):
        return f"{parts[-2]}/{parts[-1]}"
    return parts[-1] if parts else s


# Khối do khung chat F-VSCode tự nối vào sau phần sinh viên viết (xem trên log SS-QLHK, SS-6X47):
# danh sách file đính kèm, file đang mở, chỉ dẫn cho AI và danh sách tab. Mỗi khối bắt đầu ở đầu một dòng.
PROMPT_ATTACH_RE = re.compile(
    r"^(?:Attached Target Workspace Files:|--- ATTACHED TARGET FILE:|--- ACTIVE OPEN EDITOR FILE:"
    r"|\[TARGET FILE DIRECTIVE\]|\[ACTIVE FILE DIRECTIVE\]|\[Open Editor Tabs\])",
    re.MULTILINE,
)
PROMPT_FILE_RE = re.compile(r"^--- (?:ATTACHED TARGET|ACTIVE OPEN EDITOR) FILE: (.+?) \(Path:", re.MULTILINE)


def split_user_prompt(content: str) -> Tuple[str, List[str]]:
    """Tách phần sinh viên viết khỏi các khối khung chat tự thêm. Trả (phần sinh viên viết, các file đính kèm)."""
    content = str(content or "")
    m = PROMPT_ATTACH_RE.search(content)
    cut = m.start() if m else len(content)
    return content[:cut].strip(), PROMPT_FILE_RE.findall(content[cut:])


def is_non_code_uri(uri_or_path: str) -> bool:
    """Returns True if the URI belongs to IDE internal UI, chat input, settings, or non-code assets."""
    if not uri_or_path:
        return True
    s = uri_or_path.lower().replace("\\", "/").lstrip("/")
    ignore_prefixes = (
        "chatsessioninput:",
        "vscode-chat-code-block:",
        "vscode-terminal:",
        "vscode-userdata:",
        "untitled:",          # tab nháp chưa lưu, không phải file của bài
        "vscode-settings:",
        "walkthrough:",
        "webview-panel:",
        "output:",
        "debug:",
        ".venv/",
        "venv/",
        ".git/",
        "node_modules/",
        "site-packages/",
    )
    if s.startswith(ignore_prefixes):
        return True
    # Ô tìm kiếm, trang cài đặt hay trang extension của IDE (settingseditor:, extensions:, …).
    # Chỉ file: và ổ đĩa Windows (một chữ cái, d:) là file thật.
    scheme = re.match(r"^([a-z][a-z0-9+.-]+):", s)
    if scheme and scheme.group(1) != "file":
        return True
    ignore_substrings = (
        "settings.json",
        "walkthrough",
        "chatsessioninput",
        "vscode-chat-code-block",
        "terminal_cmd.log",
        "/.venv/",
        "/venv/",
        "/site-packages/",
        "site-packages",
        "/__pycache__/",
        "__pycache__",
        "/.git/",
        "/node_modules/",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".ico",
        ".zip",
    )
    if any(sub in s for sub in ignore_substrings):
        return True
    base = s.split("/")[-1]
    if base in ("readme.md", "assignment.md", "terminal_cmd.log", "package-lock.json"):
        return True
    return False


def is_task_doc_uri(uri_or_path: str) -> bool:
    """Returns True if the URI is a task description document (README.md, ASSIGNMENT.md)."""
    if not uri_or_path:
        return False
    base = uri_or_path.replace("\\", "/").split("/")[-1].lower()
    return base in ("readme.md", "assignment.md", "de_bai.md", "instructions.md")


def parse_iso_ms(iso_str: Any) -> int:
    """Parses ISO-8601 timestamp string or epoch int to milliseconds."""
    if not iso_str:
        return 0
    if isinstance(iso_str, (int, float)):
        return int(iso_str if iso_str > 1e11 else iso_str * 1000)
    if isinstance(iso_str, str):
        s = iso_str.strip()
        if s.isdigit():
            val = int(s)
            return val if val > 1e11 else val * 1000
        try:
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.datetime.fromisoformat(s)
            return int(dt.timestamp() * 1000)
        except Exception:
            return 0
    return 0


class Span:
    """Character-level provenance span (Spec 01 Section 3.2)."""
    __slots__ = ("length", "origin", "lineage", "ai_ref", "t_insert", "placed_by")

    def __init__(self, length: int, origin: str, lineage: str,
                 ai_ref: Optional[Dict[str, Any]] = None, t_insert: int = 0, placed_by: str = ""):
        self.length = length
        self.origin = origin
        self.lineage = lineage
        self.ai_ref = ai_ref
        self.t_insert = t_insert
        self.placed_by = placed_by or lineage

    def copy(self) -> "Span":
        return Span(self.length, self.origin, self.lineage,
                    dict(self.ai_ref) if self.ai_ref else None,
                    self.t_insert, self.placed_by)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "length": self.length,
            "origin": self.origin,
            "lineage": self.lineage,
            "ai_ref": self.ai_ref,
            "t_insert": self.t_insert,
            "placed_by": self.placed_by,
        }


class StudentSessionData:
    def __init__(self, student_id: str, session_code: str = "SS-UNKNOWN"):
        self.student_id = student_id
        self.session_code = session_code
        self.session_id = f"session_{student_id}"
        self.start_ts: int = 0
        self.end_ts: int = 0
        self.events: List[Dict[str, Any]] = []
        self.ai_interactions: List[Dict[str, Any]] = []
        self.prompts: List[Dict[str, Any]] = []
        # requestId -> phần tử log AI phía máy chủ đã ghép (M0.3), dùng cho nhãn I/M/E của TH7
        self.proxy_by_request: Dict[str, Dict[str, Any]] = {}
        # Standardized M0 outputs
        self.task_config: Dict[str, Any] = {
            "task_id": session_code,
            "statement_paragraphs": [],
            "starter_files": {},
            "language": "python",
            "run_patterns": {
                "test": [r"python3?\s+-m\s+pytest", r"\bpytest\b", r"\bunittest\b"],
                "run": [r"(?:python3?|py)\b.*\.py\b", r"\bflask\s+run\b", r"& .*(?:python|py).*\.exe.*\.py"],
                "build": [r"\bpip\s+install\b", r"\bjavac\b", r"\bgcc\b"],
            },
            "test_labels": {},
        }
        self.norm_events: List[Dict[str, Any]] = []
        self.edits: List[Dict[str, Any]] = []
        self.views: List[Dict[str, Any]] = []
        self.focus_events: List[Dict[str, Any]] = []
        self.provenance: Dict[str, Any] = {}
        self.dq_report: Dict[str, Any] = {}
        # Gốc thời gian (A16): examEndAt gốc của metadata và cách chọn đầu buổi
        self.meta_exam_end_at: int = 0
        self.login_info: Dict[str, Any] = {}
        self.state_snapshots: List[Tuple[int, Dict[str, str], Dict[str, int]]] = []
        self.spans_snapshots: List[Tuple[int, Dict[str, List[Span]]]] = []
        self.final_files: Dict[str, str] = {}
        self.final_spans: Dict[str, List[Span]] = {}
        self.line_edits_by_file: Dict[str, Dict[str, int]] = {}
        self.final_line_ids: Dict[str, List[str]] = {}
        self.raw_stats: Dict[str, Any] = {}

    def state_at(self, t_rel: int) -> Dict[str, str]:
        """Returns reconstructed file contents at relative time t_rel (ms from session start)."""
        if not self.state_snapshots:
            return dict(self.task_config.get("starter_files", {}))
        best_state = self.state_snapshots[0][1]
        for snap_t, state_map, _ in self.state_snapshots:
            if snap_t <= t_rel:
                best_state = state_map
            else:
                break
        return dict(best_state)

    def alive_chars_at(self, lineage: str, t_rel: int) -> int:
        """Returns alive character count for a given lineage at relative time t_rel."""
        if not self.state_snapshots:
            return 0
        best_alive = self.state_snapshots[0][2]
        for snap_t, _, alive_map in self.state_snapshots:
            if snap_t <= t_rel:
                best_alive = alive_map
            else:
                break
        return best_alive.get(lineage, 0)

    def spans_at(self, t_rel: int) -> Dict[str, List[Span]]:
        """Returns reconstructed file spans at relative time t_rel (ms from session start)."""
        if not self.spans_snapshots:
            starter = self.task_config.get("starter_files", {})
            return {f: [Span(len(c), "starter", "starter", None, 0, "starter")] for f, c in starter.items()}
        best_spans = self.spans_snapshots[0][1]
        for snap_t, spans_map in self.spans_snapshots:
            if snap_t <= t_rel:
                best_spans = spans_map
            else:
                break
        return {f: [s.copy() for s in sps] for f, sps in best_spans.items()}


class ZipSessionIngester:
    def __init__(self, zip_path: str, params: Optional[Dict[str, Any]] = None):
        self.zip_path = zip_path
        if not os.path.exists(zip_path):
            raise FileNotFoundError(f"Zip file not found: {zip_path}")
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)
        self._student_file_map: Dict[str, Dict[str, Any]] = {}
        self.session_code: str = self._detect_default_session_code()
        self._shared_starter_files: Dict[str, str] = {}
        self._shared_statement_paragraphs: List[str] = []
        self._shared_assignment_docs: Dict[str, str] = {}
        self._session_created_at: int = 0
        self._session_duration_min: int = 1440
        self._manifest_login: Dict[str, int] = self._read_manifest_data()
        self._discover()

    def _read_manifest_data(self) -> Dict[str, int]:
        """A16: session_manifest.json ghi loginTimestamp (giây) của từng sinh viên, createdAt và durationMinutes."""
        logins: Dict[str, int] = {}
        try:
            with zipfile.ZipFile(self.zip_path, 'r') as z:
                for name in z.namelist():
                    if os.path.basename(name) != "session_manifest.json":
                        continue
                    man = json.loads(z.read(name).decode('utf-8', errors='ignore'))
                    cr = man.get("createdAt") or 0
                    if cr:
                        self._session_created_at = int(cr if cr > 10 ** 11 else cr * 1000)
                    dur = man.get("durationMinutes") or 0
                    if dur:
                        self._session_duration_min = int(dur)
                    for s in man.get("students", []) or []:
                        ts = s.get("loginTimestamp") or 0
                        if s.get("studentId") and ts:
                            logins[s["studentId"]] = int(ts * 1000 if ts < 10 ** 11 else ts)
        except Exception:
            pass
        return logins

    def _detect_default_session_code(self) -> str:
        """Dynamically detect session code from upload_info, metadata, or zip filename."""
        try:
            with zipfile.ZipFile(self.zip_path, 'r') as z:
                for name in z.namelist():
                    if name.endswith('upload_info.json') or name.endswith('metadata.json'):
                        try:
                            data = json.loads(z.read(name).decode('utf-8', errors='ignore'))
                            code = data.get('sessionCode') or data.get('examSessionCode') or data.get('session_code')
                            if code and code != "SS-UNKNOWN":
                                return code
                        except Exception:
                            pass
        except Exception:
            pass

        base = os.path.basename(self.zip_path)
        m = re.search(r'(?:migrated_logs_|uploaded_logs_)?([A-Za-z0-9]+-[A-Za-z0-9]+)', base)
        if m:
            return m.group(1)

        clean_name = os.path.splitext(base)[0].replace("migrated_logs_", "").replace("uploaded_logs_", "").strip()
        return clean_name or "SESSION-LOGS"

    def _discover(self):
        """Scans the zip and identifies all student IDs and their corresponding files."""
        with zipfile.ZipFile(self.zip_path, 'r') as z:
            namelist = z.namelist()
            for name in namelist:
                if name.endswith('/'):
                    continue
                norm_name = name.replace('\\', '/')
                parts = [p for p in norm_name.split('/') if p]
                if not parts:
                    continue

                # Top-level prompt JSON: e.g. HE200473.json
                if len(parts) == 1 and parts[0].endswith('.json'):
                    s_id = parts[0][:-5]
                    if s_id.lower() not in ['session_manifest', 'manifest', 'upload_info', 'metadata', 'package', 'package-lock']:
                        self._ensure_student_entry(s_id)
                        self._student_file_map[s_id]['prompt_json'] = norm_name
                    continue

                s_id = None
                if 'exam_records' in parts:
                    idx = parts.index('exam_records')
                    if idx > 0:
                        s_id = parts[idx - 1]
                elif len(parts) >= 2:
                    s_id = parts[0]

                if not s_id or s_id.lower() in ['session_manifest', 'manifest', 'upload_info', 'metadata', '__macosx']:
                    continue

                self._ensure_student_entry(s_id)

                if norm_name.endswith('events.jsonl'):
                    self._student_file_map[s_id]['events'].append(norm_name)
                elif norm_name.endswith('ai_interactions.jsonl'):
                    self._student_file_map[s_id]['ai'].append(norm_name)
                elif norm_name.endswith('metadata.json'):
                    self._student_file_map[s_id]['meta'].append(norm_name)
                elif norm_name.endswith('upload_info.json'):
                    self._student_file_map[s_id]['upload_info'].append(norm_name)
                elif norm_name.endswith('snapshot_start.zip'):
                    self._student_file_map[s_id]['snapshot_start'].append(norm_name)
                elif norm_name.endswith('snapshot_end.zip'):
                    self._student_file_map[s_id]['snapshot_end'].append(norm_name)
                elif norm_name.endswith(f"{s_id}.json"):
                    self._student_file_map[s_id]['prompt_json'] = norm_name

            # Load shared starter files and task description from the first available snapshot_start.zip
            # A21: chỉ snapshot_start chụp lúc mở buổi này, và chỉ khi một sinh viên khác có code khởi đầu giống
            fresh: List[Tuple[str, str]] = []
            for s_id, f_map in self._student_file_map.items():
                prompts: List[Dict[str, Any]] = []
                if f_map.get('prompt_json'):
                    try:
                        raw_p = json.loads(z.read(f_map['prompt_json']).decode('utf-8', errors='ignore'))
                        prompts = raw_p if isinstance(raw_p, list) else []
                    except Exception:
                        pass
                first = self._first_anchor(s_id, prompts)
                fresh += [(s_id, sp) for sp in f_map['snapshot_start'] if self._is_fresh_snapshot(z, sp, first)]
            extracted: Dict[str, Tuple[Dict[str, str], List[str], Dict[str, str]]] = {}
            for s_id, sp in fresh:
                try:
                    extracted[sp] = self._extract_snapshot_zip(z, sp)
                except Exception:
                    pass

            def shared_ok(sp: str, s_id: str) -> bool:
                mine = extracted[sp][0]
                for o_id, osp in fresh:
                    if o_id == s_id or osp not in extracted:
                        continue
                    other = extracted[osp][0]
                    for rel, txt in mine.items():
                        if rel.endswith(".py") and rel in other and difflib.SequenceMatcher(
                                None, txt.splitlines(), other[rel].splitlines(), autojunk=False).ratio() >= 0.8:
                            return True
                return False

            for s_id, f_map in self._student_file_map.items():
                if f_map['snapshot_start']:
                    sp0 = f_map['snapshot_start'][0]
                    if sp0 not in extracted or not shared_ok(sp0, s_id):
                        continue
                    try:
                        starter, paras, docs = extracted[sp0]
                        if starter:
                            self._shared_starter_files = starter
                        if paras:
                            self._shared_statement_paragraphs = paras
                        if docs:
                            self._shared_assignment_docs = docs
                        if starter and paras and docs:
                            break
                    except Exception:
                        pass

            # Fallback: scan outer zip for any task markdown docs
            if not self._shared_assignment_docs:
                for fname in namelist:
                    if fname.endswith('/'):
                        continue
                    if is_task_doc_uri(fname):
                        try:
                            text = z.read(fname).decode('utf-8', errors='ignore').replace('\r\n', '\n')
                            base_name = fname.replace('\\', '/').split('/')[-1]
                            self._shared_assignment_docs[base_name] = text
                        except Exception:
                            pass

    def _ensure_student_entry(self, s_id: str):
        if s_id not in self._student_file_map:
            self._student_file_map[s_id] = {
                'events': [],
                'ai': [],
                'meta': [],
                'upload_info': [],
                'snapshot_start': [],
                'snapshot_end': [],
                'prompt_json': None,
            }

    def _extract_snapshot_zip(self, outer_zip: zipfile.ZipFile, inner_zip_path: str) -> Tuple[Dict[str, str], List[str], Dict[str, str]]:
        """Reads starter code files, task statement paragraphs, and full assignment docs from snapshot_start.zip."""
        starter_files: Dict[str, str] = {}
        paragraphs: List[str] = []
        assignment_docs: Dict[str, str] = {}
        images: Dict[str, str] = {}

        raw_bytes = outer_zip.read(inner_zip_path)
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as sz:
            # 1. Collect image assets to embed into Markdown docs
            for fname in sz.namelist():
                if fname.endswith(('.png', '.jpg', '.jpeg', '.svg', '.gif')):
                    try:
                        img_bytes = sz.read(fname)
                        b64 = base64.b64encode(img_bytes).decode('ascii')
                        ext = fname.split('.')[-1].lower()
                        mime = "image/svg+xml" if ext == "svg" else f"image/{'jpeg' if ext == 'jpg' else ext}"
                        data_uri = f"data:{mime};base64,{b64}"
                        norm_f = fname.replace('\\', '/')
                        images[norm_f] = data_uri
                        images[norm_f.split('/')[-1]] = data_uri
                        if '/screenshots/' in norm_f:
                            images['screenshots/' + norm_f.split('/screenshots/')[-1]] = data_uri
                    except Exception:
                        pass

            # 2. Extract task documents and starter code
            for fname in sz.namelist():
                if fname.endswith('/'):
                    continue
                if is_task_doc_uri(fname):
                    text = sz.read(fname).decode('utf-8', errors='ignore').replace('\r\n', '\n')
                    # Đoạn đề để so với prompt (cờ kèm đề bài, khớp đề ở TH4) lấy từ văn bản gốc, trước khi nhúng ảnh:
                    # ảnh base64 dài hàng chục nghìn ký tự làm đoạn có ảnh không bao giờ đạt độ phủ 0,80
                    for block in re.split(r'\n\s*\n', text):
                        clean_b = block.strip()
                        if len(clean_b) >= 40:
                            paragraphs.append(clean_b)
                    # Embed local images into Markdown
                    for img_ref, data_uri in images.items():
                        text = text.replace(f'({img_ref})', f'({data_uri})')
                        text = text.replace(f'("{img_ref}")', f'("{data_uri}")')

                    base_name = fname.replace('\\', '/').split('/')[-1]
                    assignment_docs[base_name] = text
                elif not is_non_code_uri(fname):
                    rel = normalize_rel_path(fname)
                    if rel:
                        content = sz.read(fname).decode('utf-8', errors='ignore').replace('\r\n', '\n')
                        starter_files[rel] = content
        return starter_files, paragraphs, assignment_docs

    def get_assignment_docs(self, student_id: Optional[str] = None) -> Dict[str, str]:
        """Returns assignment markdown docs for the given student or session."""
        if student_id and student_id in self._student_file_map:
            files = self._student_file_map[student_id]
            if files['snapshot_start']:
                try:
                    with zipfile.ZipFile(self.zip_path, 'r') as z:
                        _, _, docs = self._extract_snapshot_zip(z, files['snapshot_start'][0])
                        if docs:
                            return docs
                except Exception:
                    pass
        return dict(self._shared_assignment_docs)

    def get_students(self) -> List[str]:
        """Returns sorted list of discovered student IDs."""
        valid = []
        for s_id, files in self._student_file_map.items():
            if files['events'] or files['ai'] or files['prompt_json']:
                valid.append(s_id)
        return sorted(valid)

    def load_student(self, student_id: str) -> StudentSessionData:
        """Loads, normalizes, and runs full M0 pipeline for a given student ID."""
        if student_id not in self._student_file_map:
            raise ValueError(f"Student ID {student_id} not found in zip archive.")

        data = StudentSessionData(student_id, session_code=self.session_code)
        files = self._student_file_map[student_id]
        upload_ts_ms = 0

        with zipfile.ZipFile(self.zip_path, 'r') as z:
            data.start_ts, data.end_ts = resolve_window(z, student_id, files['upload_info'])
            window_begin, window_end = data.start_ts, data.end_ts
            # 1. Read upload_info or metadata
            for up_path in files['upload_info']:
                try:
                    up_info = json.loads(z.read(up_path).decode('utf-8', errors='ignore'))
                    code = up_info.get('sessionCode') or up_info.get('examSessionCode')
                    if code:
                        data.session_code = code
                        data.task_config["task_id"] = code
                    if up_info.get('uploadTimestamp'):
                        upload_ts_ms = parse_iso_ms(up_info.get('uploadTimestamp'))
                    elif up_info.get('uploadTimeISO'):
                        upload_ts_ms = parse_iso_ms(up_info.get('uploadTimeISO'))
                except Exception:
                    pass

            for meta_path in files['meta']:
                try:
                    meta = json.loads(z.read(meta_path).decode('utf-8', errors='ignore'))
                    if not data.start_ts and meta.get('examStartAt'):
                        data.start_ts = meta.get('examStartAt', 0)
                    if not data.end_ts and meta.get('examEndAt'):
                        data.end_ts = meta.get('examEndAt', 0)
                        data.meta_exam_end_at = meta.get('examEndAt', 0)
                    if meta.get('examSessionId'):
                        data.session_id = meta.get('examSessionId', data.session_id)
                except Exception:
                    pass

            # 2. Extract starter_files, statement_paragraphs, and assignment_docs
            starter_files = dict(self._shared_starter_files)
            statement_paras = list(self._shared_statement_paragraphs)
            assignment_docs = dict(self._shared_assignment_docs)
            own_starter = False
            if files['snapshot_start']:
                try:
                    s_files, s_paras, s_docs = self._extract_snapshot_zip(z, files['snapshot_start'][0])
                    # Step 4: Validate starter files; detect contaminated starter snapshot
                    is_valid_starter = (
                        s_files
                        and "app.py" in s_files
                        and ("templates/info.html" in s_files or "data/courses.json" in s_files)
                        and any(k in s_files.get("app.py", "") for k in ["courses", "PWD301", "CourseForm", "FlaskForm"])
                        and not any(bad in s_files.get("app.py", "") for bad in ["blog_bp", "Apple", "Banana", "wtfapplab"])
                    )
                    if is_valid_starter:
                        starter_files = s_files
                        own_starter = True
                    else:
                        data.dq_report["contaminated_snapshot_start"] = True
                        data.dq_report["starter_source"] = "shared_starter_files"
                    if s_paras:
                        statement_paras = s_paras
                    if s_docs:
                        assignment_docs = s_docs
                except Exception:
                    pass
            # 5. Read server AI proxy prompt_json (<student_id>.json) if present
            if files.get('prompt_json'):
                try:
                    raw_p = json.loads(z.read(files['prompt_json']).decode('utf-8', errors='ignore'))
                    if isinstance(raw_p, list):
                        data.prompts = raw_p
                except Exception:
                    data.prompts = []
            self._mark_server_prompts(data)

            starter_files, statement_paras, assignment_docs = self._check_starter(
                z, data, files, starter_files, statement_paras, assignment_docs, own_starter)
            data.task_config["starter_files"] = starter_files
            data.task_config["statement_paragraphs"] = statement_paras
            data.task_config["assignment_docs"] = assignment_docs

            snapshot_end_files: Optional[Dict[str, str]] = None
            own_end = self._own_end_snapshot(z, files)
            if own_end:
                try:
                    snapshot_end_files, _, _ = self._extract_snapshot_zip(z, own_end)
                except Exception:
                    snapshot_end_files = None

            # 3. Read raw events.jsonl
            events = []
            for src_idx, ev_path in enumerate(files['events']):
                try:
                    raw_lines = z.read(ev_path).decode('utf-8', errors='ignore').splitlines()
                    for idx, line in enumerate(raw_lines):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            ev = json.loads(line)
                            ev["_raw_order"] = idx
                            ev["_src"] = src_idx
                            events.append(ev)
                        except json.JSONDecodeError:
                            continue
                except Exception:
                    pass

            # 4. Read raw ai_interactions.jsonl
            ai_items = []
            for ai_path in files['ai']:
                try:
                    raw_lines = z.read(ai_path).decode('utf-8', errors='ignore').splitlines()
                    for idx, line in enumerate(raw_lines):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            ai_item = json.loads(line)
                            ai_item["_raw_order"] = idx
                            ai_items.append(ai_item)
                        except json.JSONDecodeError:
                            continue
                except Exception:
                    pass

        events = select_records(events, window_begin, window_end)
        ai_items = exclude_request_conflicts(select_records(ai_items, window_begin, window_end))
        data.prompts = exclude_request_conflicts([p for p in data.prompts if isinstance(p, dict) and request_time(p) is not None and window_begin <= request_time(p) <= window_end])

        # Run M0 normalization, filtering, and provenance reconstruction
        self._run_m0_pipeline(data, events, ai_items, snapshot_end_files, upload_ts_ms)
        return data

    def _own_end_snapshot(self, z: zipfile.ZipFile, files: Dict[str, Any]) -> Optional[str]:
        """snapshot_end đúng buổi là file nằm cùng thư mục với một events.jsonl có dữ liệu (DQ1)."""
        for sp in files['snapshot_end']:
            folder = sp.rsplit('/', 1)[0] + '/'
            if any(ev.startswith(folder) and z.getinfo(ev).file_size > 0 for ev in files['events']):
                return sp
        return None

    def _first_anchor(self, s_id: str, prompts: List[Dict[str, Any]]) -> int:
        """Mốc sớm nhất chắc chắn thuộc phiên này: lúc đăng nhập trong manifest hoặc yêu cầu đầu ở log máy chủ."""
        anchors = [self._manifest_login.get(s_id, 0)]
        anchors += [parse_iso_ms(p.get("timestamp")) for p in prompts or [] if isinstance(p, dict)]
        return min([a for a in anchors if a], default=0)

    def _is_fresh_snapshot(self, z: zipfile.ZipFile, snap_path: str, first_anchor: int) -> bool:
        """A21: snapshot_start chụp lúc mở buổi này, tức examStartAt của thư mục nó trong 3 giờ trước mốc đầu."""
        try:
            meta = json.loads(z.read(snap_path.rsplit('/', 1)[0] + '/metadata.json').decode('utf-8', errors='ignore'))
            st = int(meta.get('examStartAt') or 0)
        except Exception:
            return False
        return bool(first_anchor and st and first_anchor - 3 * 3600 * 1000 <= st <= first_anchor)

    def _check_starter(self, z: zipfile.ZipFile, data: StudentSessionData, files: Dict[str, Any],
                       starter_files: Dict[str, str], paras: List[str], docs: Dict[str, str],
                       own_starter: bool) -> Tuple[Dict[str, str], List[str], Dict[str, str]]:
        """
        A21: bộ log không có code khởi đầu dùng chung (không có hai snapshot_start của buổi này giống
        nhau) thì mỗi sinh viên dùng snapshot_start của chính mình chụp lúc mở buổi này, không có thì
        để trống. Không lấy code khởi đầu hay đề bài của một buổi khác.
        """
        if own_starter or starter_files:
            return starter_files, paras, docs
        first = self._first_anchor(data.student_id, data.prompts)
        for sp in files['snapshot_start']:
            if self._is_fresh_snapshot(z, sp, first):
                try:
                    own, own_paras, own_docs = self._extract_snapshot_zip(z, sp)
                except Exception:
                    continue
                if own:
                    data.dq_report["starter_source"] = "own_snapshot_this_session"
                    return own, own_paras, own_docs
        data.dq_report["starter_source"] = "none"
        return {}, [], {}

    def _run_m0_pipeline(self, data: StudentSessionData, raw_events: List[Dict[str, Any]],
                         raw_ai: List[Dict[str, Any]], snapshot_end_files: Optional[Dict[str, str]],
                         upload_ts_ms: int):
        """Executes M0 standardization, session window selection, clock sync, and provenance tracking."""
        # Check monotonic clock on raw streams before sorting (DQ6)
        clock_monotonic = True
        for stream in (raw_events, raw_ai):
            prev_t = -1
            for item in stream:
                cur_t = item.get("timestamp", 0) or 0
                if cur_t and prev_t > 0 and cur_t < prev_t - 5000:
                    clock_monotonic = False
                if cur_t:
                    prev_t = cur_t

        raw_events.sort(key=lambda x: (x.get('timestamp', 0), x.get('_raw_order', 0)))
        raw_ai.sort(key=lambda x: (x.get('timestamp', 0), x.get('_raw_order', 0)))

        # Step M0.0: Mark rebuilt and misattached server proxy prompts (B1)
        self._mark_server_prompts(data)

        # Production uses the verified schedule, not activity clusters or trailing-noise trimming.
        # Step 3: Determine session workspace root and filter foreign workspace events (HE186629)
        raw_events = self._filter_foreign_workspace_events(data, raw_events)

        data.events = raw_events
        data.ai_interactions = raw_ai

        # Keep the verified signin/scheduled end and original record clocks.

        # Step M0.2c: Mốc của terminal_command là lúc bắt đầu chạy (A19 / Việc 3)
        self._apply_command_start_time(data)

        # Step M0.3: Align server AI proxy logs (data.prompts) with client chat_request events (PP 5.1, 5.2)
        proxy_aligned_map, inferred_links_count, _ = self._align_proxy_logs(data)
        data.proxy_by_request = proxy_aligned_map

        # Step M0.4: Enrich terminal_command events with terminalOutput from AI proxy logs (PP 5.1)
        self._enrich_terminal_runs_from_proxy(data, proxy_aligned_map)

        # Step M0.4b: Bộ ghi không ghi lệnh terminal thì dựng lần chạy từ terminal chụp (A17)
        self._synthesize_runs_from_captures(data, proxy_aligned_map)

        # Step M0.4c: Mốc của yêu cầu AI là lúc bấm gửi, lấy từ requestId (A18)
        self._apply_request_send_time(data)

        # Step M0.5: Build standardized edits, deduplicating typing_chunk + paste + edit_detected
        self._build_standardized_events_and_provenance(
            data, snapshot_end_files, clock_monotonic, inferred_links_count
        )

    def _apply_login_start(self, data: StudentSessionData, events: List[Dict[str, Any]],
                           ai_items: List[Dict[str, Any]]) -> None:
        """
        A16: đầu buổi là lúc sinh viên đăng nhập phiên. Nguồn ưu tiên là loginTimestamp của
        session_manifest.json (SESSION SIGN-IN của replay). Không có manifest thì dùng examEndAt
        của bộ log cũ, ghi lúc cửa sổ nạp lại khi đăng nhập (L6), nếu nó nằm trong buổi.
        Lúc đăng nhập chỉ được dùng khi chưa có sự kiện hoạt động nào trước nó. Sự kiện trước
        đó chỉ là thao tác giao diện, được giữ lại và mang t = 0.
        """
        first_ts = data.start_ts
        data.login_info = {"rule": "first_event", "first_event_ts": first_ts, "login_ts": None,
                           "login_source": None, "shift_ms": 0, "pre_login_events": 0}
        cluster_gap_ms = 180 * 60000
        login_ts, source = self._manifest_login.get(data.student_id, 0), "manifest"
        if not login_ts or not (first_ts - cluster_gap_ms <= login_ts <= data.end_ts):
            login_ts, source = data.meta_exam_end_at, "examEndAt"
            if not login_ts or not (first_ts < login_ts <= data.end_ts):
                return
        data.login_info["login_source"] = source

        def is_activity(ev: Dict[str, Any]) -> bool:
            etype = ev.get("type", "")
            if etype in ("terminal_command", "chat"):
                return True
            if etype in ("typing_chunk", "paste", "undo", "redo"):
                p = ev.get("payload", {})
                return not is_non_code_uri(p.get("fileUri") or p.get("targetFile") or "")
            return False

        first_act = min(
            [e.get("timestamp", 0) for e in events if is_activity(e) and e.get("timestamp")]
            + [a.get("timestamp", 0) for a in ai_items
               if a.get("type") in ("chat_request", "edit_detected") and a.get("timestamp")],
            default=0,
        )
        if first_act and login_ts > first_act:
            data.login_info.update({
                "rule": "login_after_activity",
                "login_ts": login_ts,
                "activity_before_login": sum(
                    1 for e in events if is_activity(e) and 0 < e.get("timestamp", 0) < login_ts),
            })
            return

        data.start_ts = login_ts
        data.login_info.update({
            "rule": "login",
            "login_ts": login_ts,
            "shift_ms": login_ts - first_ts,
            "pre_login_events": sum(1 for e in events if e.get("timestamp", 0) < login_ts),
        })

    def _isolate_exam_cluster(self, events: List[Dict[str, Any]], ai_items: List[Dict[str, Any]],
                              upload_ts_ms: int, anchors: Optional[List[int]] = None
                              ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Phân cụm sự kiện theo khoảng dừng > 1 giờ (60 phút).
        Ưu tiên các cụm nằm trong cửa sổ 24 giờ của session (tính từ createdAt trong manifest).
        Chọn 1 cụm hoạt động mạnh nhất (nhiều sửa code, hỏi AI) trong các cụm hợp lệ; không dùng upload_bonus.
        """
        if not events:
            return events, ai_items

        cluster_gap_ms = 1 * 3600 * 1000  # Ngưỡng phân cụm 1h (60 phút)
        clusters: List[List[Dict[str, Any]]] = []
        cur_c: List[Dict[str, Any]] = []
        prev_t = 0
        for ev in events:
            t = ev.get("timestamp", 0)
            if prev_t and t - prev_t > cluster_gap_ms:
                if cur_c:
                    clusters.append(cur_c)
                cur_c = []
            cur_c.append(ev)
            if t:
                prev_t = t
        if cur_c:
            clusters.append(cur_c)

        if len(clusters) <= 1:
            return events, ai_items

        # Lọc các cụm nằm trong cửa sổ phiên thi (24 giờ kể từ createdAt nếu có)
        candidate_clusters = clusters
        if self._session_created_at:
            win_start = self._session_created_at
            win_end = self._session_created_at + self._session_duration_min * 60 * 1000
            in_win = [
                c for c in clusters
                if win_start <= ((c[0].get("timestamp", 0) + c[-1].get("timestamp", 0)) / 2) <= win_end
            ]
            if in_win:
                candidate_clusters = in_win

        if anchors:
            def anchors_in(c: List[Dict[str, Any]]) -> int:
                lo = c[0].get("timestamp", 0) - cluster_gap_ms
                hi = c[-1].get("timestamp", 0) + 1800000
                return sum(1 for a in anchors if lo <= a <= hi)
            hits = [anchors_in(c) for c in candidate_clusters]
            if max(hits) > 0:
                filtered_by_anchor = [c for c, h in zip(candidate_clusters, hits) if h == max(hits)]
                if len(filtered_by_anchor) == 1:
                    best = filtered_by_anchor[0]
                    w_start = best[0].get("timestamp", 0) - 600000
                    w_end = best[-1].get("timestamp", 0) + 600000
                    return best, [a for a in ai_items if w_start <= a.get("timestamp", 0) <= w_end]
                candidate_clusters = filtered_by_anchor

        # Score candidate clusters: chọn cụm có hoạt động mạnh nhất (bỏ upload_bonus)
        best_cluster = candidate_clusters[-1]
        best_score = -1.0
        for c in candidate_clusters:
            c_start = c[0].get("timestamp", 0) - 600000
            c_end = c[-1].get("timestamp", 0) + 600000
            ai_in_c = sum(1 for a in ai_items if c_start <= a.get("timestamp", 0) <= c_end)
            code_edits_in_c = sum(
                1 for e in c
                if e.get("type") in ("typing_chunk", "paste", "undo", "redo", "terminal_command")
                and not is_non_code_uri(e.get("payload", {}).get("fileUri") or e.get("payload", {}).get("targetFile") or "")
            )
            score = ai_in_c * 50 + code_edits_in_c + len(c) * 0.1
            if score > best_score:
                best_score = score
                best_cluster = c

        w_start = best_cluster[0].get("timestamp", 0) - 600000
        w_end = best_cluster[-1].get("timestamp", 0) + 600000
        filtered_ai = [a for a in ai_items if w_start <= a.get("timestamp", 0) <= w_end]
        return best_cluster, filtered_ai

    def _trim_trailing_ui_noise(self, events: List[Dict[str, Any]], ai_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Drops trailing UI-only manipulations after a long gap (>= pause.segment_ms) at the end of the session (PP 5.1).
        """
        if not events:
            return events

        # Find the last active code edit or command or AI interaction
        active_types = {"typing_chunk", "paste", "undo", "redo", "terminal_command"}
        last_active_idx = -1
        last_ai_ts = ai_items[-1].get("timestamp", 0) if ai_items else 0

        for i in range(len(events) - 1, -1, -1):
            ev = events[i]
            etype = ev.get("type")
            p = ev.get("payload", {}) or {}
            uri = p.get("fileUri") or p.get("targetFile") or ""
            is_active = False
            if etype == "terminal_command" or etype == "chat":
                is_active = True
            elif etype in active_types and not is_non_code_uri(uri):
                is_active = True
            if is_active:
                last_active_idx = i
                break

        if last_active_idx < len(events) - 1:
            last_active_ts = max(events[last_active_idx].get("timestamp", 0), last_ai_ts)
            # Check if there is a gap >= 3 minutes before trailing UI events
            cut_idx = len(events)
            prev_ts = last_active_ts
            for j in range(last_active_idx + 1, len(events)):
                t_j = events[j].get("timestamp", 0)
                if t_j - prev_ts >= self.params.get("pause.segment_ms", 180000):
                    cut_idx = j
                    break
                prev_ts = t_j
            return events[:cut_idx]

        return events

    def _filter_foreign_workspace_events(self, data: StudentSessionData, raw_events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Step 3: Determine session workspace root and ignore edits to files outside it (HE186629).
        Counts external workspace edits in data.dq_report["external_workspace_edits"].
        """
        from collections import Counter
        ws_root = ""
        # 1. Check prompts for exam root folder (e.g. 24_09_2026___<id>)
        for p in getattr(data, "prompts", []):
            if p.get("_misattached"):
                continue
            paths = [p.get("activeFilePath")]
            if isinstance(p.get("codeSnapshots"), list):
                paths.extend([cs.get("path") for cs in p["codeSnapshots"]])
            for p_path in paths:
                if p_path and "24_09_2026___" in p_path:
                    m = re.search(r"(24_09_2026___[a-f0-9\-]+)", p_path)
                    if m:
                        ws_root = m.group(1)
                        break
            if ws_root:
                break

        # 2. Check metadata session_id if it looks like a path or uuid
        counts = Counter()
        for ev in raw_events:
            p = ev.get("payload", {})
            u = p.get("fileUri") or p.get("targetFile") or ""
            if u.startswith("file:"):
                for m in ["/Lab1-Student/", "/Lab1/", "/student/"]:
                    idx = u.find(m)
                    if idx != -1:
                        counts[u[:idx + len(m)]] += 1
                        break

        if not ws_root:
            if len(counts) > 1:
                ws_root = counts.most_common(1)[0][0]
            else:
                data.dq_report["external_workspace_edits"] = 0
                return raw_events

        filtered = []
        ext_count = 0
        for ev in raw_events:
            p = ev.get("payload", {})
            u = p.get("fileUri") or p.get("targetFile") or ""
            if u.startswith("file:"):
                if any(m in u for m in ["/Lab1-Student/", "/Lab1/", "/student/"]):
                    if ws_root not in u:
                        ext_count += 1
                        continue
            filtered.append(ev)

        data.dq_report["external_workspace_edits"] = ext_count
        return filtered


    def _align_proxy_logs(self, data: StudentSessionData) -> Tuple[Dict[str, Dict[str, Any]], int, Optional[Dict[str, str]]]:
        """
        Aligns server-side AI proxy entries (data.prompts) with client chat_request events.
        Returns (request_id -> proxy_entry, inferred_links_count, latest_code_snapshot).
        """
        aligned: Dict[str, Dict[str, Any]] = {}
        inferred_count = 0
        latest_snapshot: Optional[Dict[str, str]] = None

        if not data.prompts:
            return aligned, inferred_count, latest_snapshot

        client_reqs = [a for a in data.ai_interactions if a.get("type") == "chat_request"]
        used_proxy = set()

        for creq in client_reqs:
            p = creq.get("payload", {})
            req_id = p.get("requestId", "")
            c_ts = p.get("_logged_ts") or creq.get("timestamp", 0)
            msgs = p.get("messages", [])
            user_msg = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "").strip()
            user_head = user_msg[:120].lower()

            best_idx = None
            best_diff = float("inf")
            for idx, p_entry in enumerate(data.prompts):
                if idx in used_proxy:
                    continue
                p_prompt = str(p_entry.get("prompt", "")).strip()
                p_ts = parse_iso_ms(p_entry.get("timestamp") or p_entry.get("createdAt"))
                time_diff = abs(p_ts - c_ts) if (p_ts and c_ts) else float("inf")

                # Match by text prefix or close timestamp
                text_match = bool(user_head and user_head[:40] in p_prompt.lower())
                if text_match and time_diff < 600000:
                    if time_diff < best_diff:
                        best_diff = time_diff
                        best_idx = idx
                elif time_diff <= self.params.get("link.time_tolerance_ms", 2000):
                    if time_diff < best_diff:
                        best_diff = time_diff
                        best_idx = idx

            if best_idx is not None:
                used_proxy.add(best_idx)
                p_matched = data.prompts[best_idx]
                aligned[req_id] = p_matched
                p_matched["_matched_req_id"] = req_id
                if best_diff > 500:
                    inferred_count += 1

        # Extract latest code snapshot within session window if available
        for p_entry in reversed(data.prompts):
            if p_entry.get("_misattached"):
                continue
            p_ts = parse_iso_ms(p_entry.get("timestamp") or p_entry.get("createdAt"))
            if data.end_ts and p_ts > data.end_ts + 600000:
                continue
            snaps = p_entry.get("codeSnapshots")
            if isinstance(snaps, list) and snaps:
                snap_map: Dict[str, str] = {}
                for s in snaps:
                    spath = s.get("path", "")
                    if spath and not is_non_code_uri(spath):
                        rel = normalize_rel_path(spath)
                        if rel:
                            snap_map[rel] = str(s.get("content", "")).replace("\r\n", "\n")
                if snap_map:
                    latest_snapshot = snap_map
                    break

        return aligned, inferred_count, latest_snapshot

    REQUEST_ID_RE = re.compile(r"^chat-(\d{12,})-")
    RUN_CMD_RE = re.compile(
        r"(?:python(?:3)?|py)(?:\.exe)?['\"]?\s+(?:['\"]([^'\"\n]*?([\w\-]+\.py))['\"]|([^\s'\"\n]*?([\w\-]+\.py))\b)",
        re.IGNORECASE
    )
    PS_PROMPT_RE = re.compile(r"^(?:\(\.venv\)\s*)?PS [A-Za-z]:\\[^>\n]*>", re.MULTILINE)
    ACCESS_RE = re.compile(r"127\.0\.0\.1 - - \[(\d\d)/(\w{3})/(\d{4}) (\d\d):(\d\d):(\d\d)\] \"(\w+) (\S+) HTTP/[\d.]+\" (\d{3})")
    ERR_LINE_RE = re.compile(r"^\s*([A-Za-z_][\w.]*(?:Error|Exception))(?::\s*(.*))?$", re.MULTILINE)
    # python không mở được script (sai đường dẫn): không có traceback, vẫn là lần chạy lỗi (TH2, P0 quyết 10/11)
    CANT_OPEN_RE = re.compile(r"can't open file '[^'\n]*': \[Errno (\d+)\][^\n]*")
    PS_CATEGORY_RE = re.compile(r"^([ \t]*\+ CategoryInfo[^\n]*)(?:\n[ \t]+(?![ \t+])([^\n]*))?", re.MULTILINE)
    MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

    def _unwrap_ps_error(self, out: str) -> str:
        """PowerShell ngắt dòng CategoryInfo theo bề rộng terminal: nối lại, rồi đưa CommandNotFoundException ra một dòng riêng."""
        def join(m: "re.Match") -> str:
            line = m.group(1).rstrip() + (m.group(2) or "").strip()
            return f"{line}\nCommandNotFoundException" if line.endswith("CommandNotFoundException") else m.group(0)
        return self.PS_CATEGORY_RE.sub(join, out)

    def _match_script(self, m: "re.Match") -> str:
        # Nhóm 2 là tên script khi đường dẫn nằm trong dấu nháy, nhóm 4 khi không có dấu nháy.
        # Không dùng m.lastindex: với nhóm lồng nhau, lastindex là nhóm ngoài (3), không phải nhóm 4.
        return (m.group(2) or m.group(4) or "").lower()

    def _capture_pieces(self, out: str, t_cap: int) -> List[Dict[str, Any]]:
        """Tách một lần chụp terminal thành các đoạn lệnh chạy, mỗi đoạn gồm dòng lệnh và phần in ra tới dấu nhắc kế tiếp."""
        hits = list(self.RUN_CMD_RE.finditer(out))
        pieces = []
        for i, h in enumerate(hits):
            end = hits[i + 1].start() if i + 1 < len(hits) else len(out)
            body = out[h.end():end]
            nxt = self.PS_PROMPT_RE.search(body)
            if nxt:
                body = body[:nxt.start()]
            script = self._match_script(h)
            if not script or "activate" in script:
                continue
            # Dòng lệnh bị vẽ lại hay được terminal in lại (dòng "$ lệnh") ngay trước chính nó thì gộp
            if i + 1 < len(hits) and self._match_script(hits[i + 1]) == script:
                stripped = body.strip().lower()
                has_output = ("running on" in stripped or "serving flask" in stripped or "traceback" in stripped
                              or bool(self.ERR_LINE_RE.search(body)) or bool(self.ACCESS_RE.search(body)))
                if not has_output:
                    continue
            pieces.append({"cmd": h.group(0), "script": script, "body": body, "t_cap": t_cap, "start": h.start()})
        return pieces

    def _apply_request_send_time(self, data: StudentSessionData) -> None:
        """
        A18: bộ ghi ghi chat_request lúc câu trả lời xong, cùng mốc với chat_response_complete.
        requestId (`chat-<ms>-…`) mang mốc bấm gửi, nên đổi timestamp của chat_request về mốc đó
        và giữ mốc gốc ở payload._logged_ts. Bảng sự kiện và replay vẫn xếp theo mốc gốc.
        """
        for a in data.ai_interactions:
            if a.get("type") != "chat_request":
                continue
            p = a.setdefault("payload", {})
            m = self.REQUEST_ID_RE.match(str(p.get("requestId", "")))
            logged = a.get("timestamp", 0)
            if not m or "_logged_ts" in p:
                continue
            sent = int(m.group(1))
            if logged and sent <= logged and logged - sent <= 600000:
                p["_logged_ts"] = logged
                a["timestamp"] = max(sent, data.start_ts) if data.start_ts else sent
        data.ai_interactions.sort(key=lambda x: (x.get("timestamp", 0), x.get("_raw_order", 0)))

    def _mark_server_prompts(self, data: StudentSessionData) -> None:
        """
        Việc 1: Bản ghi gắn nhầm lượt.
        Trong data.prompts, một bản ghi là gắn nhầm khi activeFilePath bắt đầu bằng 'file:'
        và một trong hai điều sau đúng:
        - tin nhắn user cuối trong history không chứa prompt[:40].strip(), hoặc
        - prompt[:30] trùng một bản ghi trước đó của phiên.
        Bản ghi gắn nhầm vẫn tính là một yêu cầu AI, vẫn giữ prompt, câu trả lời, thời gian.
        Nhưng không dùng codeSnapshots, codeSnapshot, terminalOutput, lastTerminalCommand
        và nhãn I/M/E của nó. Nhãn lúc đó coi như không có.
        Ghi vào dq_report khóa server_log có rebuilt và misattached.
        """
        rebuilt = 0
        misattached = 0
        seen_p30 = set()

        for p in getattr(data, "prompts", []):
            afp = str(p.get("activeFilePath") or "")
            is_rebuilt = afp.startswith("file:")
            is_mis = False

            prompt_text = str(p.get("prompt") or "")
            p30 = prompt_text[:30]
            p40_strip = prompt_text[:40].strip()

            if is_rebuilt:
                rebuilt += 1
                history = p.get("history") or []
                last_user_msg = None
                for msg in reversed(history):
                    role = msg.get("role") or msg.get("sender") or msg.get("type")
                    if role == "user":
                        last_user_msg = msg.get("content") or msg.get("text") or msg.get("message") or ""
                        break
                cond1 = (last_user_msg is None) or (p40_strip not in last_user_msg)
                cond2 = (p30 in seen_p30)

                if cond1 or cond2:
                    is_mis = True
                    misattached += 1

            seen_p30.add(p30)

            p["_is_rebuilt"] = is_rebuilt
            p["_misattached"] = is_mis
            if is_mis:
                p["codeSnapshots"] = None
                p["codeSnapshot"] = None
                p["terminalOutput"] = None
                p["lastTerminalCommand"] = None
                p["classification"] = None
                p["label"] = None
                p["proxy_label"] = None

        data.dq_report["server_log"] = {
            "rebuilt": rebuilt,
            "misattached": misattached,
        }

    def _prompt_capture_ts(self, p: Dict[str, Any], offset_a10: int) -> Optional[int]:
        """
        Việc 2: Mốc snapshot và terminal.
        timestamp của bản ghi máy chủ là lúc trả lời xong, còn snapshot và terminal
        được lấy trước khi gửi. Dùng lúc gửi của yêu cầu đã ghép (mốc trong requestId)
        cho checkpoint và lần chụp terminal. Không ghép được thì dùng createdAt
        cộng độ lệch A10.
        """
        req_id = p.get("_matched_req_id")
        if req_id:
            m = self.REQUEST_ID_RE.match(req_id)
            if m:
                return int(m.group(1))
        # createdAt có khi là của lượt sau (lớn hơn timestamp), nên lấy mốc sớm hơn
        stamps = [parse_iso_ms(p.get(k)) for k in ("createdAt", "timestamp") if p.get(k)]
        stamps = [t for t in stamps if t]
        return min(stamps) + offset_a10 if stamps else None

    def _apply_command_start_time(self, data: StudentSessionData) -> None:
        """
        Việc 3: Mốc lần chạy.
        timestamp của terminal_command là lúc lệnh kết thúc. Theo mẫu _apply_request_send_time (A18),
        đổi timestamp của sự kiện đó về timestamp − durationMs và giữ mốc gốc ở payload._logged_ts,
        không để trước đầu buổi.
        Làm sau khi đã chọn cụm buổi, để không đổi cách chọn cụm.
        Lần chạy dựng từ terminal (_synthetic) không đổi.
        """
        for e in data.events:
            if e.get("type") != "terminal_command" or e.get("_synthetic"):
                continue
            p = e.setdefault("payload", {})
            if "_logged_ts" in p:
                continue
            logged = e.get("timestamp", 0)
            dur = max(0, int(p.get("durationMs", 0) or 0))
            p["_logged_ts"] = logged
            start_t = logged - dur
            if data.start_ts:
                e["timestamp"] = max(start_t, data.start_ts)
            else:
                e["timestamp"] = start_t
        data.events.sort(key=lambda x: (x.get("timestamp", 0), x.get("_raw_order", 0)))

    def _capture_offset_ms(self, data: StudentSessionData, proxy_map: Dict[str, Dict[str, Any]]) -> int:
        """Lệch đồng hồ log máy chủ so với máy sinh viên: trung vị các cặp yêu cầu đã ghép (A10)."""
        req_ts = {a.get("payload", {}).get("requestId"): a.get("payload", {}).get("_logged_ts") or a.get("timestamp", 0)
                  for a in data.ai_interactions if a.get("type") == "chat_request"}
        diffs = sorted(req_ts[r] - parse_iso_ms(e.get("timestamp") or e.get("createdAt"))
                       for r, e in proxy_map.items()
                       if req_ts.get(r) and parse_iso_ms(e.get("timestamp") or e.get("createdAt")))
        return diffs[len(diffs) // 2] if diffs else 0

    def _page_loads(self, body: str) -> List[Tuple[int, int, str]]:
        """Lần tải trang trong một đoạn terminal: (mốc ms, mã HTTP, đường dẫn). Bỏ dòng favicon, .well-known
        và tài nguyên của trang lỗi (fvscode.term.page_noise), theo đặc tả 07 Q14d."""
        noise = self.params.get("fvscode.term.page_noise", ["/favicon.ico", "/.well-known/", "__debugger__="])
        return [(self._access_ms(a), int(a.group(9)), a.group(8)) for a in self.ACCESS_RE.finditer(body)
                if not any(n in a.group(8) for n in noise)]

    def _access_ms(self, m: "re.Match") -> int:
        dd, mon, yyyy, hh, mi, ss = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
        try:
            # Flask in giờ theo máy sinh viên, cùng đồng hồ với log IDE
            return int(datetime.datetime(int(yyyy), self.MONTHS.get(mon, 1), int(dd), int(hh), int(mi), int(ss)).timestamp() * 1000)
        except (ValueError, OverflowError):
            return 0

    def _synthesize_runs_from_captures(self, data: StudentSessionData, proxy_map: Dict[str, Dict[str, Any]]) -> None:
        """
        A17: khi log IDE không có terminal_command nào (L-gap của bộ ghi), dựng lần chạy từ các dòng lệnh
        chạy Python trong terminal chụp ở log máy chủ. Mỗi lần chạy được nhận theo khóa (script, dòng báo lỗi
        và vị trí, hoặc giờ lần tải trang đầu), nên hai lần chạy giống hệt nhau bị gộp làm một: số lần chạy
        là cận dưới. Mốc thời gian không biết chính xác, chỉ biết cận trên: lần tải trang đầu của chính nó
        hay của lần chạy đứng sau nó trong cùng lần chụp, hoặc lúc chụp. Mốc được đặt ở cận trên.
        """
        if not data.prompts or any(e.get("type") == "terminal_command" for e in data.events):
            return
        offset = self._capture_offset_ms(data, proxy_map)
        caps = []
        for entry in data.prompts:
            if entry.get("_misattached"):
                continue
            t_cap = self._prompt_capture_ts(entry, offset)
            if not t_cap:
                continue
            out = self._unwrap_ps_error(str(entry.get("terminalOutput") or "").replace("\r\n", "\n").replace("\r", "\n"))
            if out.strip():
                if data.start_ts and t_cap < data.start_ts:
                    continue
                if data.end_ts and t_cap > data.end_ts + 60000:
                    continue
                caps.append((t_cap, out))
        caps.sort()
        runs: Dict[Tuple, Dict[str, Any]] = {}
        order: List[Tuple] = []
        prev_cap = None
        for t_cap, out in caps:
            hits = list(self.RUN_CMD_RE.finditer(out))
            blocks = []
            for i, m in enumerate(hits):
                end = hits[i + 1].start() if i + 1 < len(hits) else len(out)
                body = out[m.end():end]
                nxt_prompt = self.PS_PROMPT_RE.search(body)
                if nxt_prompt:
                    body = body[:nxt_prompt.start()]
                # Dòng lệnh bị vẽ lại hay ngắt dòng: thân rỗng và lệnh kế tiếp cùng script thì là cùng một lần chạy
                if not body.strip() and i + 1 < len(hits) and self._match_script(hits[i + 1]) == self._match_script(m):
                    continue
                script = self._match_script(m)
                if "activate" in script:
                    continue
                errs = list(self.ERR_LINE_RE.finditer(body))
                err = errs[-1] if errs else None
                loc = re.findall(r'File "([^"]+)", line (\d+)', body)
                accesses = [(self._access_ms(a), int(a.group(9))) for a in self.ACCESS_RE.finditer(body)]
                pages = self._page_loads(body)
                # Bảng 8: server đã lên khi có dòng Running on hoặc log thấy lần tải trang. Có dòng truy cập thì
                # traceback trong thân là lỗi của một lần tải trang, đi theo mã HTTP (A11, E1)
                server = "running on http" in body.lower() or bool(accesses)
                if server:
                    key = (script, "server", accesses[0][0] if accesses else None)
                elif err:
                    key = (script, err.group(0).strip(), loc[-1] if loc else None)
                else:
                    key = (script, "other", body.strip()[:120])
                blocks.append({"key": key, "cmd": m.group(0), "cwd": out[out.rfind("\n", 0, m.start()) + 1:m.start()], "script": script, "body": body,
                               "server": server, "accesses": accesses, "pages": pages})
            # cận trên: lần tải trang đầu của chính nó hoặc của lần chạy đứng sau trong cùng lần chụp
            upper = t_cap
            for b in reversed(blocks):
                if b["accesses"] and b["accesses"][0][0]:
                    upper = min(upper, b["accesses"][0][0])
                b["upper"] = upper
            for b in blocks:
                if b["key"] in runs:
                    r = runs[b["key"]]
                    if len(b["body"]) > len(r["body"]):
                        r["body"], r["accesses"], r["pages"] = b["body"], b["accesses"], b["pages"]
                    continue
                runs[b["key"]] = {**b, "t_cap": t_cap, "t_lo": prev_cap}
                order.append(b["key"])
            prev_cap = t_cap
        new_events = []
        for key in order:
            r = runs[key]
            tail = r["body"][-self.params.get("run.output_tail_chars", 4000):]
            payload = {
                "command": r["cmd"],
                "cwd": r["cwd"],
                "script": r["script"],
                "stdout_tail": tail,
                "stderr_tail": tail,
                "observed_at_ts": r["t_cap"],
                "t_source": "capture",
                "t_lo_ts": r["t_lo"],
                "rule": "A17",
            }
            if r["server"]:
                payload["long_lived"] = True
                payload["observed"] = {"outcome": "server_started"}
                if r.get("pages"):
                    payload["last_page_code"] = r["pages"][-1][1]
                    payload["page_loads"] = len(r["pages"])
                    payload["observed"]["last_page_code"] = r["pages"][-1][1]
            new_events.append({"timestamp": int(r["upper"]), "type": "terminal_command", "payload": payload,
                               "_raw_order": -1, "_synthetic": True})
        if new_events:
            data.events.extend(new_events)
            data.events.sort(key=lambda x: (x.get("timestamp", 0), x.get("_raw_order", 0)))
        data.capture_runs = {"n": len(new_events), "offset_ms": offset, "n_captures": len(caps)}

    def _enrich_terminal_runs_from_proxy(self, data: StudentSessionData, proxy_map: Dict[str, Dict[str, Any]]):
        """
        Spec 03 E1 and E2 for sessions with terminal_command:
        - E1: split each capture at run commands; match each piece in order to logged terminal_command events.
        - E2: parse Flask access lines, search integer timezone h in [-14, 14], assign to latest server run,
              emit http_request events (page loads).
        - Drop startup errors if server subsequently served pages (startup_err_dropped).
        - Detect HTTP status >= 500 as error outcome.
        - Record adapter report metrics (term.hour_offset, term.access_lines, term.unassigned, term.outside_logged_run, term.evidence).
        """
        term_events = [e for e in data.events if e.get("type") == "terminal_command" and not e.get("_synthetic")]
        if not term_events:
            return

        tail_limit = self.params.get("run.output_tail_chars", 4000)
        server_scripts = set(self.params.get("fvscode.run.server_scripts", ["app.py"]))
        page_noise = self.params.get("fvscode.term.page_noise", ["/favicon.ico", "/.well-known/", "__debugger__="])
        slack_ms = self.params.get("fvscode.term.snapshot_slack_ms", 1000)
        max_lag_ms = self.params.get("fvscode.term.max_lag_ms", 3600000)

        # Index logged runs (excluding activate.ps1 and execution policy commands)
        logged_runs = []
        for e in term_events:
            pl = e.setdefault("payload", {})
            cmd = str(pl.get("command", "")).strip()
            if "activate.ps1" in cmd.lower() or "set-executionpolicy" in cmd.lower():
                continue
            script = pl.get("script") or ""
            if not script:
                py_matches = re.findall(r"([\w\-./\\]+\.py)\b", cmd)
                if py_matches:
                    script = re.split(r"[/\\]", py_matches[-1])[-1].lower()
                else:
                    tokens = [tok for tok in cmd.split() if not tok.startswith("-") and tok.lower() not in ("python", "python3", "pytest", "flask", "node", "python.exe", "python3.exe", "py", "py.exe")]
                    script = re.split(r"[/\\]", tokens[0])[-1].lower() if tokens else ""
                    if script in ("python.exe", "python3.exe", "python", "python3", "py", "py.exe"):
                        script = ""
            if script:
                pl["script"] = script
                logged_runs.append({
                    "event": e,
                    "payload": pl,
                    "ts": e.get("timestamp", 0),
                    "script": script,
                    "cmd": cmd,
                    "e1": None,
                    "e2_accesses": [],
                })

        offset = self._capture_offset_ms(data, proxy_map) if data.prompts else 0

        # Collect valid captures
        caps = []
        if data.prompts:
            for c_idx, pr in enumerate(data.prompts):
                if pr.get("_misattached"):
                    continue
                t_cap = self._prompt_capture_ts(pr, offset)
                if not t_cap:
                    continue
                out = self._unwrap_ps_error(str(pr.get("terminalOutput") or "").replace("\r\n", "\n").replace("\r", "\n"))
                if out.strip():
                    if data.start_ts and t_cap < data.start_ts:
                        continue
                    if data.end_ts and t_cap > data.end_ts + 60000:
                        continue
                    caps.append((t_cap, out, c_idx))
            caps.sort(key=lambda x: x[0])

        # If no captures or no logged python runs, initialize term report & exit
        if not caps or not logged_runs:
            data.term_report = {
                "hour_offset": None,
                "access_lines": 0,
                "unassigned": 0,
                "outside_logged_run": 0,
                "evidence": {"E1": 0, "E2": 0, "E1+E2": 0, "by_outcome": {}},
                "snapshots": len(caps),
            }
            data.dq_report["term"] = data.term_report
            return

        # -------------------------------------------------------------
        # E2 Step 1: Parse and deduplicate Flask access lines
        # -------------------------------------------------------------
        unique_access: Dict[Tuple, Dict[str, Any]] = {}
        for t_cap, out, c_idx in caps:
            lines = out.splitlines()
            for l_idx, line in enumerate(lines):
                m = self.ACCESS_RE.search(line)
                if not m:
                    continue
                dd, mon, yyyy, hh, mi, ss, method, path, status_str = (
                    m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6),
                    m.group(7), m.group(8), m.group(9)
                )
                key = (dd, mon, yyyy, hh, mi, ss, method, path, status_str)
                if key in unique_access:
                    continue
                status = int(status_str)
                dt_utc = datetime.datetime(int(yyyy), self.MONTHS.get(mon, 1), int(dd), int(hh), int(mi), int(ss), tzinfo=datetime.timezone.utc)
                epoch_utc = int(dt_utc.timestamp() * 1000)

                app_msg = None
                err_line = None
                location = None
                if status >= 500:
                    for pre_l in lines[max(0, l_idx - 3):l_idx]:
                        m_app = re.match(r"^Error [\w ]+: (.+)$", pre_l.strip())
                        if m_app:
                            app_msg = m_app.group(0).strip()
                            break
                    post_lines = []
                    for post_l in lines[l_idx + 1:min(len(lines), l_idx + 61)]:
                        if self.ACCESS_RE.search(post_l) and "__debugger__=" not in post_l:
                            break
                        post_lines.append(post_l)
                    for post_l in reversed(post_lines):
                        m_err = self.ERR_LINE_RE.match(post_l.strip())
                        if m_err:
                            err_line = m_err.group(0).strip()
                            break
                    loc_matches = re.findall(r'File "([^"]+)", line (\d+)', "\n".join(post_lines))
                    for f_path, l_num in reversed(loc_matches):
                        if "site-packages" not in f_path and "lib/python" not in f_path.lower():
                            location = {"file": normalize_rel_path(f_path), "line": int(l_num)}
                            break

                is_noise = any(noise in path for noise in page_noise)
                unique_access[key] = {
                    "epoch_utc": epoch_utc,
                    "first_t_cap": t_cap,
                    "method": method,
                    "path": path,
                    "status": status,
                    "app_msg": app_msg,
                    "err_line": err_line,
                    "location": location,
                    "is_noise": is_noise,
                }

        # -------------------------------------------------------------
        # E2 Step 2: Timezone h search
        # -------------------------------------------------------------
        valid_h = None
        if unique_access:
            valid_hs = []
            for h_cand in range(-14, 15):
                ok = True
                for acc in unique_access.values():
                    t_acc = acc["epoch_utc"] - h_cand * 3600000
                    if t_acc > acc["first_t_cap"] + slack_ms or (acc["first_t_cap"] - t_acc) >= max_lag_ms:
                        ok = False
                        break
                if ok:
                    valid_hs.append(h_cand)
            if 7 in valid_hs:
                valid_h = 7
            elif valid_hs:
                valid_h = valid_hs[0]

        access_items = []
        if valid_h is not None:
            for acc in unique_access.values():
                acc["t"] = acc["epoch_utc"] - valid_h * 3600000
                access_items.append(acc)
            access_items.sort(key=lambda x: x["t"])

        # -------------------------------------------------------------
        # E1: phần in ra của lần chạy trong mỗi lần chụp (đặc tả 03, mục 4.1)
        # -------------------------------------------------------------
        # Mỗi lần chụp là phần cuối của terminal lúc gửi yêu cầu AI, các đoạn lệnh trong đó theo đúng thứ tự chạy.
        # Đoạn cuối ứng với lần chạy cuối trước lần chụp (quy tắc E1). Đi ngược từ cuối, đoạn thứ k từ cuối ứng với lần
        # chạy thứ k từ cuối, chừng nào còn khớp: cùng script, không mâu thuẫn giờ (lần chạy bắt đầu trước dòng truy cập
        # đầu của đoạn, và dòng truy cập cuối của đoạn trước lần chạy kế tiếp bắt đầu), và không trái với phần in ra
        # đã gán cho lần chạy đó từ lần chụp trước. Gặp điểm không khớp đầu tiên thì dừng, vì từ đó trở về trước có thể
        # có lần chạy log IDE không ghi hay đoạn của terminal khác. Lần chụp sau có thể thấy thêm phần in ra của cùng
        # lần chạy (server in tiếp, bộ nạp lại báo lỗi), khi đó giữ bản dài hơn.
        e1_runs = [lr for lr in logged_runs if lr["script"].endswith(".py")]
        e1_slack = self.params.get("fvscode.term.e1_time_slack_ms", 2000)

        def access_times(body: str) -> List[int]:
            if valid_h is None:
                return []
            res = []
            for m in self.ACCESS_RE.finditer(body):
                dt = datetime.datetime(int(m.group(3)), self.MONTHS.get(m.group(2), 1), int(m.group(1)),
                                       int(m.group(4)), int(m.group(5)), int(m.group(6)), tzinfo=datetime.timezone.utc)
                res.append(int(dt.timestamp() * 1000) - valid_h * 3600000)
            return res

        def body_lines(body: str) -> set:
            return {ln.strip() for ln in body.splitlines() if ln.strip()}

        for t_cap, out, c_idx in caps:
            pieces = self._capture_pieces(out, t_cap)
            runs_before = [lr for lr in e1_runs if lr["ts"] <= t_cap + 1000]
            next_run_ts = None
            for pc, lr in zip(reversed(pieces), reversed(runs_before)):
                if pc["script"] != lr["script"]:
                    break
                acc_t = access_times(pc["body"])
                if acc_t and lr["ts"] > min(acc_t) + e1_slack:
                    break
                if acc_t and next_run_ts is not None and max(acc_t) > next_run_ts + e1_slack:
                    break
                if lr["e1"] is not None:
                    # So theo tập dòng vì terminal vẽ lại có thể lặp hay đổi chỗ vài dòng giữa hai lần chụp
                    old_l, new_l = body_lines(lr["e1"]["body"]), body_lines(pc["body"])
                    if old_l <= new_l:
                        lr["e1"] = pc
                    elif not new_l <= old_l:
                        break
                else:
                    lr["e1"] = pc
                next_run_ts = lr["ts"]
        # Parse E1 outcome for matched pieces
        for lr in logged_runs:
            if lr["e1"]:
                body = lr["e1"]["body"]
                body_strip = body.strip()
                has_access = bool(list(self.ACCESS_RE.finditer(body)))
                has_tb = "traceback" in body.lower()
                err_matches = list(self.ERR_LINE_RE.finditer(body))
                last_err = err_matches[-1] if err_matches else None

                has_syntax_err = False
                if not has_tb and last_err:
                    err_word = last_err.group(1).split(".")[-1]
                    if err_word in ("SyntaxError", "IndentationError", "TabError", "CommandNotFoundException"):
                        has_syntax_err = True

                loc_matches = re.findall(r'File "([^"]+)", line (\d+)', body)
                location = None
                for f_path, l_num in reversed(loc_matches):
                    if "site-packages" not in f_path and "lib/python" not in f_path.lower():
                        location = {"file": normalize_rel_path(f_path), "line": int(l_num)}
                        break

                access_matches = list(self.ACCESS_RE.finditer(body))
                has_access = bool(access_matches)

                if has_access:
                    e1_outcome = "server_started"
                    e1_err = None
                elif (has_tb or has_syntax_err) and last_err:
                    e1_outcome = "error"
                    e1_err = last_err.group(0).strip()
                elif "running on http" in body.lower() or "serving flask app" in body.lower():
                    e1_outcome = "server_started"
                    e1_err = None
                elif not body_strip:
                    e1_outcome = "no_output"
                    e1_err = None
                else:
                    e1_outcome = "other_output"
                    e1_err = None

                e1_type = last_err.group(1).split(".")[-1] if last_err else None
                cant_open = self.CANT_OPEN_RE.search(body) if e1_outcome == "other_output" else None
                if cant_open:
                    e1_outcome = "error"
                    e1_err = cant_open.group(0).strip()
                    e1_type = f"can't open file [Errno {cant_open.group(1)}]"

                lr["e1_parsed"] = {
                    "outcome": e1_outcome,
                    "err_line": e1_err,
                    "location": location,
                    "error_type": e1_type,
                    "t_cap": lr["e1"]["t_cap"],
                    "body": body,
                }

        # -------------------------------------------------------------
        # E2 Step 3: Assign access lines to latest server run
        # -------------------------------------------------------------
        unassigned_count = 0
        new_http_events = []
        for acc in access_items:
            assigned_lr = None
            for lr in logged_runs:
                if lr["script"] in server_scripts and lr["ts"] <= acc["t"] + 1000:
                    assigned_lr = lr
                elif lr["ts"] > acc["t"] + 1000:
                    break
            if assigned_lr is not None:
                assigned_lr["e2_accesses"].append(acc)
            else:
                unassigned_count += 1

            if not acc["is_noise"]:
                new_http_events.append({
                    "timestamp": acc["t"],
                    "type": "http_request",
                    "payload": {
                        "method": acc["method"],
                        "path": acc["path"],
                        "status": acc["status"],
                        "run_id": None,
                        "err_line": acc["err_line"],
                    },
                    "_synthetic": True,
                })

        # Attach http_requests to data
        if new_http_events:
            data.events.extend(new_http_events)
            data.events.sort(key=lambda x: (x.get("timestamp", 0), x.get("_raw_order", 0)))

        # -------------------------------------------------------------
        # Combine E1 and E2 into observed outcome for each logged run
        # -------------------------------------------------------------
        for ri, lr in enumerate(logged_runs):
            pl = lr["payload"]
            e1 = lr.get("e1_parsed")
            e2_list = lr["e2_accesses"]
            page_loads = [a for a in e2_list if not a["is_noise"]]

            outcome = "unknown"
            source = "none"
            err_line = None
            error_type = None
            location = None
            http_error = False
            startup_err_dropped = None
            last_page_code = None

            if page_loads:
                last_page_code = page_loads[-1]["status"]

            if e1 and e1["outcome"] == "error":
                if e2_list:
                    startup_err_dropped = e1["err_line"]
                    if page_loads and page_loads[-1]["status"] >= 500:
                        outcome = "error"
                        http_error = True
                        lp = page_loads[-1]
                        err_line = lp["err_line"] or lp["app_msg"]
                        error_type = lp["err_line"].split(":")[0] if lp["err_line"] else "HTTP500"
                        location = lp["location"]
                        source = "E1+E2"
                    else:
                        outcome = "server_started"
                        source = "E1+E2"
                        err_line = None
                        error_type = None
                        location = None
                else:
                    outcome = "error"
                    err_line = e1["err_line"]
                    error_type = e1["error_type"]
                    location = e1["location"]
                    source = "E1"
            elif page_loads and page_loads[-1]["status"] >= 500:
                outcome = "error"
                http_error = True
                lp = page_loads[-1]
                err_line = lp["err_line"] or lp["app_msg"]
                error_type = lp["err_line"].split(":")[0] if lp["err_line"] else "HTTP500"
                location = lp["location"]
                source = "E1+E2" if e1 else "E2"
            elif (e1 and e1["outcome"] == "server_started") or e2_list:
                outcome = "server_started"
                source = "E1+E2" if (e1 and e2_list) else ("E1" if e1 else "E2")
                err_line = None
                error_type = None
                location = None
            elif e1 and e1["outcome"] in ("no_output", "other_output"):
                outcome = "no_error_seen"
                source = "E1"
                err_line = None
                error_type = None
                location = None
            else:
                outcome = "unknown"
                source = "none"
                err_line = None
                error_type = None
                location = None

            obs_until = (
                page_loads[-1]["t"]
                if page_loads
                else (e1["t_cap"] if e1 else (e2_list[-1]["t"] if e2_list else None))
            )

            pl["observed"] = {
                "outcome": outcome,
                "err_line": err_line,
                "location": location,
                "error_type": error_type,
                "source": source,
                "http_error": http_error,
                "n_pages": len(page_loads),
                "page_codes": [a["status"] for a in page_loads],
                "last_page_code": last_page_code,
                "n_page_errors": sum(1 for a in page_loads if a["status"] >= 500),
                "observed_until": obs_until,
            }
            if e1:
                body = e1["body"]
                pl["stdout_tail"] = body[-tail_limit:]
                pl["stderr_tail"] = body[-tail_limit:]
                pl["observed_at_ts"] = e1["t_cap"]

            if outcome == "server_started" or bool(e2_list):
                pl["long_lived"] = True

            pl["page_loads"] = len(page_loads)
            pl["last_page_code"] = last_page_code
            if startup_err_dropped:
                pl["startup_err_dropped"] = startup_err_dropped

        # -------------------------------------------------------------
        # Adapter report / DQ report metrics (Spec 03 Section 7)
        # -------------------------------------------------------------
        outside_logged_run = 0
        for acc in access_items:
            inside = False
            for lr in logged_runs:
                if lr["script"] in server_scripts:
                    dur = int(lr["event"].get("payload", {}).get("durationMs", 0) or 0)
                    end_logged = lr["payload"].get("_logged_ts") or (lr["ts"] + dur)
                    if lr["ts"] <= acc["t"] <= max(end_logged, lr["ts"] + dur) + 6000:
                        inside = True
                        break
            if not inside:
                outside_logged_run += 1

        data.term_report = {
            "hour_offset": valid_h,
            "access_lines": len(access_items),
            "unassigned": unassigned_count,
            "outside_logged_run": outside_logged_run,
            "evidence": {
                "E1": sum(1 for r in logged_runs if r["payload"].get("observed", {}).get("source") == "E1"),
                "E2": sum(1 for r in logged_runs if r["payload"].get("observed", {}).get("source") == "E2"),
                "E1+E2": sum(1 for r in logged_runs if r["payload"].get("observed", {}).get("source") == "E1+E2"),
                "by_outcome": {
                    oc: sum(1 for r in logged_runs if r["payload"].get("observed", {}).get("outcome") == oc)
                    for oc in ("error", "server_started", "no_error_seen", "unknown")
                },
            },
            "snapshots": len(caps),
        }
        data.dq_report["term"] = data.term_report

    def _build_standardized_events_and_provenance(
        self,
        data: StudentSessionData,
        snapshot_end_files: Optional[Dict[str, str]],
        clock_monotonic: bool,
        inferred_links_count: int,
    ):
        """
        Pairs typing_chunk + paste + edit_detected into unified edit records,
        synthesizes view/focus events, reconstructs code & character-level provenance Spans (Spec 01 Section 3),
        and computes Data Quality Report (DQ1-DQ8).
        """
        start_ts = data.start_ts
        raw_events = self._in_record_order(data.events)
        raw_ai = data.ai_interactions

        # 1. Index paste events and edit_detected events for pairing and deduplication
        paste_events = []
        for idx, ev in enumerate(raw_events):
            if ev.get("type") == "paste":
                p = ev.get("payload", {})
                t_file = p.get("targetFile", "")
                if not is_non_code_uri(t_file):
                    paste_events.append({
                        "raw_idx": idx,
                        "log_idx": idx,
                        "ts": ev.get("timestamp", 0),
                        "file": normalize_rel_path(t_file),
                        "text": str(p.get("pastedText", "")).replace("\r\n", "\n"),
                        "is_internal": bool(p.get("source", {}).get("isInternal", False)),
                        "range": p.get("range", {}),
                        "kind": p.get("kind", "add"),
                        "paired": False,
                    })

        # Deduplicate identical paste_events within 50ms on the same file
        dedup_pastes = []
        for pe in paste_events:
            if dedup_pastes and dedup_pastes[-1]["file"] == pe["file"] and dedup_pastes[-1]["text"] == pe["text"] and abs(pe["ts"] - dedup_pastes[-1]["ts"]) <= 50:
                continue
            dedup_pastes.append(pe)
        paste_events = dedup_pastes

        # Index edit_detected from ai_interactions (deduplicating simultaneous entries)
        ai_edits_detected = []
        for a in raw_ai:
            if a.get("type") == "edit_detected":
                p = a.get("payload", {})
                doc_uri = p.get("documentUri", "")
                if is_non_code_uri(doc_uri):
                    continue
                # Rule C.3: ai-mcp is normal student activity during AI call, never creates edit or marks AI
                if p.get("editKind") != "ai-chat":
                    continue
                rel_f = normalize_rel_path(doc_uri)
                txt = str(p.get("text", "")).replace("\r\n", "\n")
                ts = a.get("timestamp", 0)
                meta = p.get("meta", {})
                req_id = meta.get("requestId", "")
                match_type = meta.get("matchType", "")
                # If duplicate timestamp + file + text, merge metadata (prefer chat-* requestId and matchType)
                if ai_edits_detected and ai_edits_detected[-1]["file"] == rel_f and ai_edits_detected[-1]["text"] == txt and abs(ts - ai_edits_detected[-1]["ts"]) <= 2000:
                    prev = ai_edits_detected[-1]
                    if req_id.startswith("chat-") or not prev["request_id"]:
                        prev["request_id"] = req_id
                    if match_type and not prev["match_type"]:
                        prev["match_type"] = match_type
                    continue
                ai_edits_detected.append({
                    "ts": ts,
                    "file": rel_f,
                    "text": txt,
                    "edit_kind": "ai-chat",
                    "request_id": req_id,
                    "match_type": match_type,
                    "paired": False,
                })

        # Link ai_edits_detected to paste_events when they match on file, text, and timestamp (within 2500ms)
        for pe in paste_events:
            for aed in ai_edits_detected:
                if not aed["paired"] and aed["file"] == pe["file"] and abs(aed["ts"] - pe["ts"]) <= 2500:
                    if (aed["text"].strip() == pe["text"].strip()
                            or aed["text"].strip() in pe["text"].strip()
                            or pe["text"].strip() in aed["text"].strip()):
                        pe["ai_request_id"] = aed["request_id"]
                        pe["ai_match_type"] = aed["match_type"]
                        pe["ai_edit_kind"] = aed["edit_kind"]
                        aed["paired"] = True
                        break

        # 2. Track clipboard copies to identify paste_chat vs paste_internal vs paste_external (TH4 Step 1)
        last_copy: Optional[Dict[str, Any]] = None
        raw_edits: List[Dict[str, Any]] = []
        views: List[Dict[str, Any]] = []
        focus_events: List[Dict[str, Any]] = []
        merge_windows: List[int] = []

        for idx, ev in enumerate(raw_events):
            etype = ev.get("type", "")
            ts = ev.get("timestamp", 0)
            t_rel = max(ts - start_ts, 0)
            p = ev.get("payload", {})

            if etype == "copy":
                src_file = p.get("sourceFile", "")
                copied_txt = str(p.get("copiedText", "")).replace("\r\n", "\n")
                from_kind = "other"
                if "vscode-chat-code-block" in src_file.lower() or "chatsession" in src_file.lower():
                    from_kind = "chat"
                elif not is_non_code_uri(src_file):
                    from_kind = "editor"
                last_copy = {"t": t_rel, "text": copied_txt, "from": from_kind}

            elif etype in ("file_switch", "text_selection", "ui_click"):
                uri = p.get("toFile") or p.get("fileUri") or ""
                region = p.get("targetRegion", "")
                if is_task_doc_uri(uri):
                    focus_events.append({"t": t_rel, "target": "task_panel"})
                elif "chat" in uri.lower() or region in ("auxiliarybar", "chat"):
                    focus_events.append({"t": t_rel, "target": "chat_panel"})
                elif "terminal" in uri.lower() or region == "panel":
                    focus_events.append({"t": t_rel, "target": "terminal"})
                elif not is_non_code_uri(uri):
                    rel_f = normalize_rel_path(uri)
                    focus_events.append({"t": t_rel, "target": "editor", "file": rel_f})
                    if etype in ("view", "viewport_change", "visible_ranges"):
                        rng = p.get("range", {})
                        sl = rng.get("sl", 1)
                        el = rng.get("el", sl + 25)
                        views.append({
                            "t": t_rel,
                            "file": rel_f,
                            "visible_start_line": max(1, sl - 10),
                            "visible_end_line": el + 15,
                        })

            elif etype == "typing_chunk":
                f_uri = p.get("fileUri", "")
                if is_non_code_uri(f_uri):
                    continue
                rel_f = normalize_rel_path(f_uri)
                dur = int(p.get("duration", 0) or 0)
                if dur > 0:
                    merge_windows.append(dur)
                t_end_rel = t_rel + dur
                txt = str(p.get("text", "")).replace("\r\n", "\n")
                rng = p.get("range", {})
                kind = p.get("kind", "add")

                # Check if this typing_chunk is paired with a paste event on the same file
                matched_pe = None
                for pe in paste_events:
                    if not pe["paired"] and pe["file"] == rel_f:
                        if abs(ts - pe["ts"]) <= 1500 or abs((ts + dur) - pe["ts"]) <= 1500:
                            if pe["text"] and txt and (pe["text"] == txt or pe["text"] in txt):
                                matched_pe = pe
                                pe["paired"] = True
                                break

                # Also check if paired directly with an unpaired ai_edit_detected (Insert button block)
                if not matched_pe:
                    for aed in ai_edits_detected:
                        if not aed["paired"] and aed["file"] == rel_f:
                            if (abs(ts - aed["ts"]) <= 2500 or abs((ts + dur) - aed["ts"]) <= 2500
                                    or (ts <= aed["ts"] <= ts + dur + 100)):
                                if aed["text"] and txt and (aed["text"] == txt or aed["text"] in txt):
                                    matched_pe = {
                                        "ts": aed["ts"],
                                        "file": rel_f,
                                        "text": aed["text"],
                                        "is_internal": False,
                                        "range": rng,
                                        "ai_request_id": aed["request_id"],
                                        "ai_match_type": aed["match_type"],
                                        "from_insert_button": True,
                                    }
                                    aed["paired"] = True
                                    break

                if matched_pe:
                    p_txt = matched_pe["text"]
                    if matched_pe.get("from_insert_button"):
                        paste_src = "chat"
                    else:
                        paste_src = self._determine_paste_source(matched_pe, last_copy)

                    # Check if typing_chunk also had typed characters around the paste
                    if txt != p_txt and len(txt) > len(p_txt):
                        rem_len = len(txt) - len(p_txt)
                        idx_sub = txt.find(p_txt)
                        if idx_sub >= 0:
                            prefix_txt = txt[:idx_sub]
                            suffix_txt = txt[idx_sub + len(p_txt):]
                        else:
                            prefix_txt = txt[:rem_len]
                            suffix_txt = ""

                        if prefix_txt:
                            raw_edits.append({
                                "t": t_rel,
                                "t_end": max(t_end_rel - 1, t_rel),
                                "ts_abs": ts,
                                "file": rel_f,
                                "range": rng,
                                "kind": "add",
                                "inserted": prefix_txt,
                                "origin": "typed",
                                "paste_source": None,
                                "ai_request_id": None,
                                "log_idx": idx,
                            })

                        pe_t_rel = max(matched_pe["ts"] - start_ts, t_rel)
                        kind_to_use = kind if kind in ("rep", "del") else matched_pe.get("kind", "add")
                        if kind_to_use in ("rep", "del") and rng:
                            range_to_use = {
                                "sl": rng.get("sl", 1),
                                "sc": int(rng.get("sc", 1) or 1) + len(prefix_txt),
                                "el": rng.get("el", 1),
                                "ec": int(rng.get("ec", 1) or 1) + len(prefix_txt),
                            }
                        else:
                            range_to_use = matched_pe.get("range") or {
                                "sl": rng.get("sl", 1),
                                "sc": int(rng.get("sc", 1) or 1) + len(prefix_txt),
                                "el": rng.get("el", 1),
                                "ec": int(rng.get("ec", 1) or 1) + len(prefix_txt),
                            }
                        raw_edits.append({
                            "t": pe_t_rel,
                            "t_end": pe_t_rel,
                            "ts_abs": matched_pe["ts"],
                            "file": rel_f,
                            "range": range_to_use,
                            "kind": kind_to_use,
                            "inserted": p_txt,
                            "origin": "paste",
                            "paste_source": paste_src,
                            "ai_request_id": matched_pe.get("ai_request_id"),
                            "log_idx": idx,
                        })

                        if suffix_txt:
                            raw_edits.append({
                                "t": min(pe_t_rel + 1, t_end_rel),
                                "t_end": t_end_rel,
                                "ts_abs": ts + dur,
                                "file": rel_f,
                                "range": {},
                                "kind": "add",
                                "inserted": suffix_txt,
                                "origin": "typed",
                                "paste_source": None,
                                "ai_request_id": None,
                                "log_idx": idx,
                            })
                    else:
                        pe_t_rel = max(matched_pe["ts"] - start_ts, t_rel)
                        kind_to_use = kind if kind in ("rep", "del") else matched_pe.get("kind", "add")
                        if kind_to_use in ("rep", "del") and rng:
                            range_to_use = rng
                        else:
                            range_to_use = matched_pe.get("range") if matched_pe.get("range") else rng
                            if not range_to_use:
                                range_to_use = {
                                    "sl": rng.get("sl", 1),
                                    "sc": rng.get("sc", 1),
                                    "el": rng.get("el", 1),
                                    "ec": rng.get("ec", 1),
                                }
                        raw_edits.append({
                            "t": pe_t_rel,
                            "t_end": pe_t_rel,
                            "ts_abs": matched_pe["ts"],
                            "file": rel_f,
                            "range": range_to_use,
                            "kind": kind_to_use,
                            "inserted": p_txt,
                            "origin": "paste",
                            "paste_source": paste_src,
                            "ai_request_id": matched_pe.get("ai_request_id"),
                            "log_idx": idx,
                        })
                else:
                    raw_edits.append({
                        "t": t_rel,
                        "t_end": t_end_rel,
                        "ts_abs": ts,
                        "file": rel_f,
                        "range": rng,
                        "kind": kind,
                        "inserted": txt,
                        "origin": "typed",
                        "paste_source": None,
                        "ai_request_id": None,
                        "log_idx": idx,
                    })

            elif etype in ("undo", "redo"):
                f_uri = p.get("fileUri", "")
                if is_non_code_uri(f_uri):
                    continue
                rel_f = normalize_rel_path(f_uri)
                # Pair with any edit_detected on same file within 2500ms so undo restoring AI code does not create duplicate edit (Rule C.2)
                for aed in ai_edits_detected:
                    if not aed["paired"] and aed["file"] == rel_f and abs(aed["ts"] - ts) <= 2500:
                        aed["paired"] = True
                changes = p.get("changes", [])
                for ch in changes:
                    raw_edits.append({
                        "t": t_rel,
                        "t_end": t_rel,
                        "ts_abs": ts,
                        "file": rel_f,
                        "range": ch.get("range", {}),
                        "kind": etype,
                        "inserted": str(ch.get("text", "")).replace("\r\n", "\n"),
                        "origin": etype,
                        "paste_source": None,
                        "ai_request_id": None,
                        "log_idx": idx,
                    })

        # Add any standalone paste_events or ai_edits_detected that did not pair with a typing_chunk
        for pe in paste_events:
            if not pe["paired"] and pe["text"]:
                pe_t_rel = max(pe["ts"] - start_ts, 0)
                paste_src = self._determine_paste_source(pe, last_copy)
                raw_edits.append({
                    "t": pe_t_rel,
                    "t_end": pe_t_rel,
                    "ts_abs": pe["ts"],
                    "file": pe["file"],
                    "range": pe.get("range", {}),
                    "kind": "add",
                    "inserted": pe["text"],
                    "origin": "paste",
                    "paste_source": paste_src,
                    "ai_request_id": pe.get("ai_request_id"),
                    "log_idx": pe["log_idx"],
                })

        for aed in ai_edits_detected:
            if not aed["paired"] and aed["text"]:
                # edit_detected chỉ là nhãn: cụm gõ gom hai lần Insert liền nhau đã chứa đoạn này (A3)
                if any(e["file"] == aed["file"] and abs(e["ts_abs"] - aed["ts"]) <= 5000
                       and aed["text"].strip() in (e.get("inserted") or "") for e in raw_edits):
                    data.dq_report["ai_edit_in_chunk"] = data.dq_report.get("ai_edit_in_chunk", 0) + 1
                    continue
                data.dq_report["ai_edit_standalone"] = data.dq_report.get("ai_edit_standalone", 0) + 1
                aed_t_rel = max(aed["ts"] - start_ts, 0)
                raw_edits.append({
                    "t": aed_t_rel,
                    "t_end": aed_t_rel,
                    "ts_abs": aed["ts"],
                    "file": aed["file"],
                    "range": {},
                    "kind": "add",
                    "inserted": aed["text"],
                    "origin": "paste",
                    "paste_source": "chat",
                    "ai_request_id": aed.get("request_id"),
                    "log_idx": max((e["log_idx"] for e in raw_edits if e["ts_abs"] <= aed["ts"]), default=-1) + 0.5,
                })

        # B2: Giữ thứ tự áp thay đổi theo thứ tự ghi, không xếp theo t
        raw_edits.sort(key=lambda e: e["log_idx"])
        for i, ed in enumerate(raw_edits, 1):
            ed["id"] = f"e{i:06d}"
        self._mark_program_bursts(raw_edits)

        data.views = views
        data.focus_events = focus_events

        # Step 2: Extract checkpoints from data.prompts (Spec 02 A5)
        proxy_aligned_map = getattr(data, "proxy_by_request", {}) or {}
        offset = self._capture_offset_ms(data, proxy_aligned_map)
        checkpoints = []
        for p in getattr(data, "prompts", []):
            if p.get("_misattached"):
                continue
            t_abs = self._prompt_capture_ts(p, offset)
            if not t_abs:
                continue
            t_rel = max(t_abs - data.start_ts, 0)
            req_id = p.get("_matched_req_id")
            snaps = {}
            if isinstance(p.get("codeSnapshots"), list):
                for cs in p["codeSnapshots"]:
                    f = normalize_rel_path(cs.get("path", ""))
                    if f and not is_non_code_uri(f):
                        snaps[f] = str(cs.get("content", "")).replace("\r\n", "\n")
            # activeFilePath có lúc không khớp nội dung codeSnapshot, nên chỉ dùng khi không có danh sách ảnh
            if not snaps and p.get("activeFilePath") and p.get("codeSnapshot"):
                f = normalize_rel_path(p["activeFilePath"])
                if f and not is_non_code_uri(f):
                    snaps[f] = str(p["codeSnapshot"]).replace("\r\n", "\n")
            if snaps:
                checkpoints.append((t_rel, snaps, req_id, t_abs))
        checkpoints.sort(key=lambda x: x[0])

        # 3. Reconstruct code state and character-level provenance Spans (Spec 01 Section 3.1 - 3.3, Spec 02 A5)
        self._reconstruct_provenance_and_states(
            data, raw_edits, snapshot_end_files, clock_monotonic, inferred_links_count, merge_windows, checkpoints
        )

    def _determine_paste_source(self, pe: Dict[str, Any], last_copy: Optional[Dict[str, Any]]) -> str:
        if pe.get("ai_request_id"):
            return "chat"
        if last_copy and last_copy.get("from") == "chat":
            if last_copy.get("text", "").strip() == pe.get("text", "").strip():
                return "chat"
        if pe.get("is_internal"):
            return "internal"
        return "external"

    def _line_col_to_offset(self, content: str, line_1based: int, col_1based: int) -> int:
        """Converts 1-based (line, col) into 0-based character offset in content."""
        if not content or (line_1based <= 1 and col_1based <= 1):
            return 0
        lines = content.splitlines(keepends=True)
        if not lines:
            return 0
        if line_1based > len(lines):
            return len(content)
        line_idx = max(line_1based - 1, 0)
        offset = sum(len(lines[i]) for i in range(line_idx))
        col_offset = min(max(col_1based - 1, 0), len(lines[line_idx]))
        return min(offset + col_offset, len(content))

    def _mark_program_bursts(self, edits: List[Dict[str, Any]]) -> None:
        """A4: từ burst_min_chunks chunk cùng mili giây, cùng file là một đợt do chương trình, không phải gõ tay."""
        min_chunks = self.params.get("fvscode.prov.burst_min_chunks", 3)
        groups: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
        for ed in edits:
            if ed.get("origin") == "typed" and ed.get("kind") in ("add", "del", "rep") and ed.get("range"):
                groups.setdefault((ed.get("file"), ed.get("ts_abs")), []).append(ed)
        for group in groups.values():
            if len(group) < min_chunks:
                continue
            head = next((e for e in group if e.get("inserted")), group[0])
            for ed in group:
                ed["origin"] = "programmatic"
                ed["burst_head"] = head["id"]

    def _in_record_order(self, events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """B2: thứ tự ghi. groupId chỉ tăng trong một events.jsonl, nên các file xếp theo sự kiện đầu của chúng."""
        first: Dict[Any, int] = {}
        for ev in events:
            src, ts = ev.get("_src"), ev.get("timestamp", 0)
            first[src] = min(first.get(src, ts), ts)
        return sorted(events, key=lambda x: (x.get("_src") is None, first[x.get("_src")], x.get("_src") or 0,
                                             x.get("groupId", x.get("_raw_order", 0))))

    def _detect_crlf_mode(self, data: StudentSessionData) -> bool:
        """Phát hiện phiên dùng \\r\\n dựa trên dữ liệu thô của phiên."""
        for ev in getattr(data, "events", []) or []:
            p = ev.get("payload", {})
            txt = p.get("text") or p.get("pastedText") or ""
            if "\r\n" in txt:
                return True
            for ch in p.get("changes", []):
                if "\r\n" in ch.get("text", ""):
                    return True
        for c in (data.task_config or {}).get("starter_files", {}).values():
            if "\r\n" in c:
                return True
        return False

    def _line_col_offset(self, text: str, line: int, col: int) -> int:
        """Tính offset 0-based từ dòng và cột (1-based), hỗ trợ cả \\r\\n và \\n."""
        idx = 0
        for _ in range(max(line, 1) - 1):
            next_nl = text.find("\n", idx)
            if next_nl < 0:
                return len(text)
            idx = next_nl + 1
        next_nl = text.find("\n", idx)
        if next_nl < 0:
            line_end = len(text)
        elif next_nl > 0 and text[next_nl - 1] == "\r":
            line_end = next_nl - 1
        else:
            line_end = next_nl
        return min(idx + max(col, 1) - 1, line_end)

    def _resolve_batch_edits(self, batch: List[Dict[str, Any]], cur_text: str, is_crlf: bool,
                            known_lines: Optional[Set[str]] = None, known_after: Optional[str] = None) -> None:
        """
        Khôi phục offset cho lô nhiều thay đổi cùng timestamp.
        rep, del có dòng cột trên file trước lô. add có offset trên file trước lô nhưng dòng cột
        đọc trên file sau lô, nên phải lặp. VS Code xếp thay đổi của một sự kiện theo offset giảm dần.
        """
        pre = cur_text.replace("\n", "\r\n") if is_crlf else cur_text
        ops = []
        for ed in batch:
            rng = ed.get("range", {})
            kind = ed.get("kind", "add")
            ins = (ed.get("inserted") or "").replace("\n", "\r\n") if is_crlf else (ed.get("inserted") or "")
            a = self._line_col_offset(pre, int(rng.get("sl", 1) or 1), int(rng.get("sc", 1) or 1))
            b = a if kind == "add" else self._line_col_offset(pre, int(rng.get("el", 1) or 1), int(rng.get("ec", 1) or 1))
            ops.append([kind, rng, ins, a, b])

        # add nằm giữa hai rep, del kề nó theo thứ tự log
        known = [op for op in ops if op[0] != "add"]
        ordered = all(x[3] >= y[4] for x, y in zip(known, known[1:]))
        bounds = {}
        hi = len(pre)
        for idx, op in enumerate(ops):
            if op[0] != "add":
                hi = op[3]
            else:
                bounds[idx] = [0, hi]
        lo = 0
        for idx in range(len(ops) - 1, -1, -1):
            if ops[idx][0] != "add":
                lo = ops[idx][4]
            else:
                bounds[idx][0] = lo

        def rebuilt(chosen: List[List[Any]]) -> str:
            parts, pos = [], 0
            for op in sorted(chosen, key=lambda v: (v[3], v[4])):
                parts.append(pre[pos:max(op[3], pos)])
                parts.append(op[2])
                pos = max(pos, op[4])
            parts.append(pre[pos:])
            return "".join(parts)

        # Snapshot ngay sau lô cho biết file sau lô, nên đọc thẳng vị trí của add trên đó
        solved = False
        if known_after is not None:
            target = known_after.replace("\n", "\r\n") if is_crlf else known_after
            saved = [(op[3], op[4]) for op in ops]
            floor = 0
            for idx in range(len(ops) - 1, -1, -1):
                op = ops[idx]
                if op[0] == "add":
                    pos = self._line_col_offset(target, int(op[1].get("sl", 1) or 1), int(op[1].get("sc", 1) or 1))
                    op[3] = op[4] = min(max(pos, bounds[idx][0], floor), bounds[idx][1]) if ordered else pos
                    floor = op[3]
            solved = rebuilt(ops).rstrip() == target.rstrip()
            read_ops = None if solved else [(op[3], op[4]) for op in ops]
            if not solved:
                for op, (a0, b0) in zip(ops, saved):
                    op[3], op[4] = a0, b0

        # Đi từ offset thấp lên. Một vị trí của add có thể đọc ra nhiều nghiệm vì chính đoạn add làm
        # dòng cột đổi, nên lấy nghiệm thấp nhất. Lượt đầu bỏ các add phía trên vì chưa biết vị trí.
        for round_no in range(0 if solved else 3):
            changed = False
            floor = 0
            for idx in range(len(ops) - 1, -1, -1):
                op = ops[idx]
                if op[0] != "add":
                    continue
                rng = op[1]
                sl, sc = int(rng.get("sl", 1) or 1), int(rng.get("sc", 1) or 1)
                others = [o for i, o in enumerate(ops) if i != idx and (round_no or i > idx or o[0] != "add")]
                base = sorted(others, key=lambda v: (v[3], v[4]))
                marks = [(o[3], o[4], len(o[2]) - (o[4] - o[3])) for o in base]
                text = rebuilt(others)
                lo_b, hi_b = (max(bounds[idx][0], floor), bounds[idx][1]) if ordered else (0, len(pre))

                def post_index(cand: int) -> int:
                    shift = sum(delta for start, end, delta in marks if end <= cand and start < cand)
                    at = max(cand + shift, 0)
                    return self._line_col_offset(text[:at] + op[2] + text[at:], sl, sc)

                # Đọc thẳng được khi điểm cần đọc nằm trước đoạn add, nên thử cách này trước
                direct = self._line_col_offset(text, sl, sc)
                pos = direct if lo_b <= direct <= hi_b and post_index(direct) == direct else None
                # Đoạn add có xuống dòng thì nhiều vị trí cùng đúng: chọn vị trí có nhiều dòng quanh đó đã biết nhất
                if known_lines and ("\n" in op[2] or pos is None) and hi_b - lo_b <= 400:
                    fixed = [c for c in range(lo_b, hi_b + 1) if post_index(c) == c]
                    if len(fixed) > 1:
                        def known_score(cand: int) -> int:
                            shift = sum(delta for start, end, delta in marks if end <= cand and start < cand)
                            at = max(cand + shift, 0)
                            line_start = text.rfind("\n", 0, at) + 1
                            line_start = text.rfind("\n", 0, max(line_start - 1, 0)) + 1
                            line_end = text.find("\n", at)
                            line_end = text.find("\n", line_end + 1) if line_end >= 0 else -1
                            line_end = len(text) if line_end < 0 else line_end
                            around = (text[line_start:at] + op[2] + text[at:line_end]).replace("\r\n", "\n")
                            return sum(1 for line in around.split("\n") if line.strip() in known_lines)
                        pos = max(fixed, key=lambda c: (known_score(c), -c))
                    elif fixed:
                        pos = fixed[0]
                for cand in range(lo_b, hi_b + 1) if pos is None else ():
                    if post_index(cand) == cand:
                        pos = cand
                        break
                if pos is None:
                    pos = min(max(post_index(op[3]), lo_b), hi_b)
                floor = pos
                if pos != op[3]:
                    op[3] = op[4] = pos
                    changed = True
            if not changed:
                break

        # Đọc trên snapshot không khớp hoàn toàn thì giữ cách nào gần snapshot hơn
        if known_after is not None and not solved:
            def distance() -> float:
                return 1 - difflib.SequenceMatcher(None, rebuilt(ops), target, autojunk=False).ratio()
            solver_ops = [(op[3], op[4]) for op in ops]
            solver_gap = distance()
            for op, (a0, b0) in zip(ops, read_ops):
                op[3], op[4] = a0, b0
            if distance() >= solver_gap:
                for op, (a0, b0) in zip(ops, solver_ops):
                    op[3], op[4] = a0, b0

        # Chuyển offset trước lô thành offset áp tuần tự theo thứ tự log (chuẩn hoá về \n)
        to_lf_offset = (lambda off: len(pre[:off].replace("\r\n", "\n"))) if is_crlf else (lambda off: off)
        applied = []
        for ed, op in zip(batch, ops):
            a, b = to_lf_offset(op[3]), to_lf_offset(op[4])
            ed["offset"] = a + sum(delta for prev_a, delta in applied if prev_a < a)
            ed["deleted_len"] = b - a
            applied.append((a, len(ed.get("inserted") or "") - (b - a)))

        # Đợt do chương trình: giữ phần file đã đổi để so với câu trả lời AI (A4)
        members = [ed for ed in batch if ed.get("burst_head")]
        if members:
            head = next(ed for ed in members if ed["burst_head"] == ed["id"])
            after = rebuilt(ops).replace("\r\n", "\n")
            before_lines, after_lines = cur_text.split("\n"), after.split("\n")
            changed = [op for op in difflib.SequenceMatcher(None, before_lines, after_lines, autojunk=False).get_opcodes()
                       if op[0] != "equal"]
            first, last = (changed[0][3], changed[-1][4]) if changed else (0, 0)
            added = "".join(ed.get("inserted") or "" for ed in members)
            head["burst_text"] = "\n".join(after_lines[first:last])
            head["burst_chars"] = len(added)
            head["burst_lines"] = sum(op[4] - op[3] for op in changed)
            head["whitespace_only"] = not added.strip()

    def _reconstruct_provenance_and_states(
        self,
        data: StudentSessionData,
        edits: List[Dict[str, Any]],
        snapshot_end_files: Optional[Dict[str, str]],
        clock_monotonic: bool,
        inferred_links_count: int,
        merge_windows: List[int],
        checkpoints: Optional[List[Any]] = None,
    ):
        """
        Applies edits sequentially, tracking character-level Spans, line IDs,
        Undo/Redo restoration (3.3a), and Cancelled pairs (3.3b).
        """
        file_contents: Dict[str, str] = {}
        file_spans: Dict[str, List[Span]] = {}
        file_line_ids: Dict[str, List[str]] = {}
        line_edits_by_file: Dict[str, Dict[str, int]] = {}
        line_counter = 0

        for rel_f, content in data.task_config.get("starter_files", {}).items():
            clean_c = content.replace("\r\n", "\n")
            file_contents[rel_f] = clean_c
            file_spans[rel_f] = [Span(len(clean_c), "starter", "starter", None, 0, "starter")] if clean_c else []
            n_lines = max(len(clean_c.split("\n")), 1)
            l_ids = []
            for _ in range(n_lines):
                line_counter += 1
                l_ids.append(f"L{line_counter:04d}")
            file_line_ids[rel_f] = l_ids
            line_edits_by_file[rel_f] = {}

        removed_records: List[Dict[str, Any]] = []  # For 3.3a undo/redo lookback
        lineage_meta: Dict[str, Dict[str, Any]] = {}
        deleted_chars_by_lineage: Dict[str, int] = {}
        deletion_times_by_lineage: Dict[str, List[int]] = {}
        interior_insert_by_lineage: Dict[str, List[int]] = {}
        restored_edits_count = 0
        unrestored_chars_count = 0

        def current_alive_map() -> Dict[str, int]:
            alive: Dict[str, int] = {}
            for sp_list in file_spans.values():
                for sp in sp_list:
                    alive[sp.lineage] = alive.get(sp.lineage, 0) + sp.length
            return alive

        # Record initial state at t=0
        data.state_snapshots.append((0, dict(file_contents), current_alive_map()))
        data.spans_snapshots.append((0, {f: [s.copy() for s in sps] for f, sps in file_spans.items()}))

        max_lookback = self.params.get("undo.max_lookback", 50)
        restore_min_share = self.params.get("undo.restore_min_share", 0.90)
        cancel_window_ms = self.params.get("undo.cancel_window_ms", 30000)

        # Build unified timeline of edits and checkpoints (Spec 02 A5, B2)
        # Với timeline, dùng thời gian hiệu lực (giá trị lớn nhất của t tới dòng đó) để đặt checkpoint đúng chỗ
        timeline = []
        running_max_t = 0
        for idx, ed in enumerate(edits):
            running_max_t = max(running_max_t, ed["t"])
            timeline.append((running_max_t, 0, idx, "edit", ed))
        for idx, chk in enumerate(checkpoints or []):
            timeline.append((chk[0], 1, idx, "checkpoint", chk))
        timeline.sort(key=lambda item: (item[0], item[1], item[2]))

        total_checkpoints = 0
        matched_checkpoints = 0
        resync_count = 0
        resync_chars = 0
        stale_checkpoints = 0
        snaps_seen: Dict[str, set] = {}
        final_edits = []

        ai_texts = [((a.get("timestamp", 0) - data.start_ts), str((a.get("payload") or {}).get("text") or ""))
                    for a in data.ai_interactions if a.get("type") == "chat_response_complete"]
        sorted_checkpoints = sorted(checkpoints or [], key=lambda c: c[0])

        def known_lines_at(f: str, t: int) -> Set[str]:
            """Dòng của snapshot kế tiếp và của các câu trả lời AI đã có, dùng để chọn vị trí trong lô."""
            texts = [txt.replace("\r\n", "\n") for t_ai, txt in ai_texts if t_ai <= t + 5000]
            texts += [chk[1][f] for chk in sorted_checkpoints if chk[0] >= t and f in chk[1]][:1]
            return {line.strip() for txt in texts for line in txt.split("\n") if line.strip()}

        def snapshot_after_batch(first: Dict[str, Any]) -> Optional[str]:
            """Snapshot kế tiếp của file nếu từ sau lô tới đó không có thay đổi nào khác trên file."""
            f = first.get("file")
            batch = batch_groups[(f, first.get("ts_abs"))]
            members = {id(e) for e in batch}
            start = next(i for i, e in enumerate(edits) if e is first)
            nxt = next((e for e in edits[start:] if e.get("file") == f and id(e) not in members), None)
            t_batch = max(e["t"] for e in batch)
            for chk in sorted_checkpoints:
                if chk[0] >= t_batch and f in chk[1]:
                    return chk[1][f] if nxt is None or nxt["t"] > chk[0] else None
            return None

        # Lô nhiều thay đổi: typing_chunk cùng timestamp, cùng file
        is_crlf = self._detect_crlf_mode(data)
        batch_groups: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
        for ed in edits:
            if (ed.get("offset") is None
                    and ed.get("kind") in ("add", "del", "rep")
                    and ed.get("range")
                    and ed.get("ts_abs") is not None):
                batch_groups.setdefault((ed.get("file"), ed["ts_abs"]), []).append(ed)
        batch_groups = {k: v for k, v in batch_groups.items() if len(v) >= 2}
        resolved_batches: Set[Tuple[str, int]] = set()

        for t_item, kind_item, idx_item, action_type, obj in timeline:
            if action_type == "edit":
                batch_key = (obj.get("file"), obj.get("ts_abs"))
                if batch_key in batch_groups and batch_key not in resolved_batches:
                    resolved_batches.add(batch_key)
                    file_contents.setdefault(obj.get("file"), "")
                    self._resolve_batch_edits(batch_groups[batch_key], file_contents[obj.get("file")], is_crlf,
                                              known_lines_at(obj.get("file"), obj["t"]), snapshot_after_batch(obj))

                ed = obj
                rel_f = ed["file"]
                if rel_f not in file_contents:
                    file_contents[rel_f] = ""
                    file_spans[rel_f] = []
                    line_counter += 1
                    file_line_ids[rel_f] = [f"L{line_counter:04d}"]
                    line_edits_by_file[rel_f] = {}

                cur_text = file_contents[rel_f]
                cur_spans = file_spans[rel_f]

                # Determine offset p and deleted_len d
                if ed.get("offset") is not None:
                    p = min(max(int(ed["offset"]), 0), len(cur_text))
                    d = min(max(int(ed.get("deleted_len", 0)), 0), len(cur_text) - p)
                else:
                    rng = ed.get("range", {})
                    sl = int(rng.get("sl", 1) or 1)
                    sc = int(rng.get("sc", 1) or 1)
                    el = int(rng.get("el", sl) or sl)
                    ec = int(rng.get("ec", sc) or sc)
                    p = self._line_col_to_offset(cur_text, sl, sc)
                    if (el > sl or ec > sc) and ed.get("kind") in ("del", "rep", "undo", "redo"):
                        end_off = self._line_col_to_offset(cur_text, el, ec)
                        d = max(end_off - p, 0)
                    elif ed.get("kind") == "del":
                        d = min(1, len(cur_text) - p)
                    else:
                        d = 0

                x = ed.get("inserted", "")
                ed["offset"] = p
                ed["deleted_len"] = d
                ed["cancelled"] = False
                ed["cancelled_by"] = None
                ed["restores"] = None

                # Compute lines touched in state right before edit
                start_line_idx = cur_text[:p].count("\n")
                end_line_idx = cur_text[:p + d].count("\n")
                f_lids = file_line_ids[rel_f]
                touched_lids = []
                for l_i in range(start_line_idx, min(end_line_idx + 1, len(f_lids))):
                    lid = f_lids[l_i]
                    touched_lids.append(lid)
                    line_edits_by_file[rel_f][lid] = line_edits_by_file[rel_f].get(lid, 0) + 1
                ed["touched_line_ids"] = touched_lids
                ed["start_line_1based"] = start_line_idx + 1

                # Update line_ids list for file
                new_n_lines = x.count("\n")
                new_lids = []
                for _ in range(new_n_lines):
                    line_counter += 1
                    new_lids.append(f"L{line_counter:04d}")
                kept_prefix = f_lids[:start_line_idx + 1]
                kept_suffix = f_lids[end_line_idx + 1:]
                file_line_ids[rel_f] = kept_prefix + new_lids + kept_suffix

                interior_lineage = None
                if x and d == 0 and ed["origin"] not in ("undo", "redo"):
                    pos = 0
                    for sp in cur_spans:
                        if pos < p < pos + sp.length:
                            interior_lineage = sp.lineage
                            break
                        pos += sp.length

                placed_before = {sp.placed_by for sp in cur_spans if sp.length > 0}

                before_spans: List[Span] = []
                removed_spans: List[Span] = []
                after_spans: List[Span] = []
                pos = 0
                for sp in cur_spans:
                    sp_start = pos
                    sp_end = pos + sp.length
                    pos = sp_end
                    if sp_end <= p:
                        before_spans.append(sp)
                    elif sp_start >= p + d:
                        after_spans.append(sp)
                    else:
                        if sp_start < p:
                            left_len = p - sp_start
                            before_spans.append(Span(left_len, sp.origin, sp.lineage, sp.ai_ref, sp.t_insert, sp.placed_by))
                        ov_start = max(sp_start, p)
                        ov_end = min(sp_end, p + d)
                        if ov_end > ov_start:
                            rem_sp = Span(ov_end - ov_start, sp.origin, sp.lineage, sp.ai_ref, sp.t_insert, sp.placed_by)
                            removed_spans.append(rem_sp)
                            deleted_chars_by_lineage[sp.lineage] = deleted_chars_by_lineage.get(sp.lineage, 0) + rem_sp.length
                            deletion_times_by_lineage.setdefault(sp.lineage, []).append(ed["t"])
                        if sp_end > p + d:
                            right_len = sp_end - (p + d)
                            after_spans.append(Span(right_len, sp.origin, sp.lineage, sp.ai_ref, sp.t_insert, sp.placed_by))

                removed_text = cur_text[p:p + d]
                if d > 0 and removed_spans:
                    removed_records.append({
                        "edit_id": ed["id"],
                        "file": rel_f,
                        "offset": p,
                        "text": removed_text,
                        "spans": [s.copy() for s in removed_spans],
                        "restored": False,
                    })
                ed["removed_spans"] = [s.copy() for s in removed_spans]

                inserted_spans: List[Span] = []
                if x:
                    if ed["origin"] in ("undo", "redo"):
                        cands = [r for r in reversed(removed_records) if r["file"] == rel_f and not r["restored"]][:max_lookback]
                        chosen_r = None
                        chosen_blocks = []
                        for r in cands:
                            if not r["text"]:
                                continue
                            matcher = difflib.SequenceMatcher(None, r["text"], x, autojunk=False)
                            blocks = matcher.get_matching_blocks()
                            match_sum = sum(b.size for b in blocks)
                            if match_sum >= restore_min_share * len(x):
                                chosen_r = r
                                chosen_blocks = [b for b in blocks if b.size > 0]
                                break

                        if chosen_r is not None:
                            chosen_r["restored"] = True
                            ed["restores"] = chosen_r["edit_id"]
                            restored_edits_count += 1
                            r_char_spans: List[Span] = []
                            for rsp in chosen_r["spans"]:
                                for _ in range(rsp.length):
                                    r_char_spans.append(rsp)

                            cur_j = 0
                            for b in chosen_blocks:
                                if b.b > cur_j:
                                    gap_len = b.b - cur_j
                                    inserted_spans.append(Span(gap_len, ed["origin"], ed["id"], None, ed["t"], ed["id"]))
                                    unrestored_chars_count += gap_len
                                for k in range(b.a, min(b.a + b.size, len(r_char_spans))):
                                    orig_sp = r_char_spans[k]
                                    inserted_spans.append(Span(1, orig_sp.origin, orig_sp.lineage, orig_sp.ai_ref, orig_sp.t_insert, ed["id"]))
                                    deleted_chars_by_lineage[orig_sp.lineage] = max(0, deleted_chars_by_lineage.get(orig_sp.lineage, 0) - 1)
                                cur_j = b.b + b.size
                            if cur_j < len(x):
                                tail_len = len(x) - cur_j
                                inserted_spans.append(Span(tail_len, ed["origin"], ed["id"], None, ed["t"], ed["id"]))
                                unrestored_chars_count += tail_len
                        else:
                            inserted_spans.append(Span(len(x), ed["origin"], ed["id"], None, ed["t"], ed["id"]))
                            unrestored_chars_count += len(x)
                    else:
                        origin_label = ed["origin"]
                        if origin_label == "paste":
                            origin_label = "paste_" + (ed.get("paste_source") or "unknown")
                        ai_ref = {"request_id": ed["ai_request_id"], "block_index": 0} if ed.get("ai_request_id") else None
                        # Cả đợt do chương trình là một lineage, mang mã của chunk đầu đợt (A4)
                        lin_id = ed.get("burst_head") or ed["id"]
                        inserted_spans.append(Span(len(x), origin_label, lin_id, ai_ref, ed["t"], lin_id))
                        if lin_id in lineage_meta:
                            lineage_meta[lin_id]["original_chars"] += len(x)
                            lineage_meta[lin_id]["lines_inserted"] += len(x.splitlines())
                            lineage_meta[lin_id]["text"] += x
                        else:
                            lineage_meta[lin_id] = {
                                "lineage": lin_id,
                                "origin": origin_label,
                                "file": rel_f,
                                "t_insert": ed["t"],
                                "original_chars": len(x),
                                "lines_inserted": len(x.splitlines()),
                                "text": x,
                                "ai_ref": ai_ref,
                            }
                        if interior_lineage:
                            interior_insert_by_lineage.setdefault(interior_lineage, []).append(ed["t"])

                combined = before_spans + inserted_spans + after_spans
                merged_spans: List[Span] = []
                for sp in combined:
                    if sp.length <= 0:
                        continue
                    if merged_spans and merged_spans[-1].lineage == sp.lineage and merged_spans[-1].placed_by == sp.placed_by:
                        merged_spans[-1].length += sp.length
                    else:
                        merged_spans.append(sp)

                file_spans[rel_f] = merged_spans
                file_contents[rel_f] = cur_text[:p] + x + cur_text[p + d:]

                placed_after = {sp.placed_by for sp in merged_spans if sp.length > 0}
                ed["_placed_before"] = placed_before
                ed["_placed_after"] = placed_after

                final_edits.append(ed)
                data.state_snapshots.append((ed["t"], dict(file_contents), current_alive_map()))
                data.spans_snapshots.append((ed["t"], {f_s: [s.copy() for s in sps] for f_s, sps in file_spans.items()}))

            elif action_type == "checkpoint":
                t_chk, snaps, req_id, t_abs = obj
                for f, snap_text in snaps.items():
                    if is_non_code_uri(f):
                        continue
                    file_contents.setdefault(f, "")
                    file_spans.setdefault(f, [])
                    file_line_ids.setdefault(f, [])
                    line_edits_by_file.setdefault(f, {})
                    cur_text = file_contents[f]
                    total_checkpoints += 1
                    seen_snaps = snaps_seen.setdefault(f, set())
                    snap_key = snap_text.rstrip()
                    is_old_snap = snap_key in seen_snaps
                    seen_snaps.add(snap_key)
                    if cur_text.rstrip() == snap_key:
                        matched_checkpoints += 1
                    elif is_old_snap:
                        # Ảnh trùng một ảnh trước đó của file: ảnh chưa cập nhật, không kéo bản dựng lùi (A5)
                        stale_checkpoints += 1
                    else:
                        matcher = difflib.SequenceMatcher(None, cur_text, snap_text)
                        diff_c = sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag != "equal")
                        resync_count += 1
                        resync_chars += diff_c
                        resync_id = f"resync_{resync_count}"

                        cur_spans = file_spans[f]
                        char_spans = []
                        for sp in cur_spans:
                            for _ in range(sp.length):
                                char_spans.append(sp)

                        new_spans = []
                        cur_b = 0
                        for a, b, size in matcher.get_matching_blocks():
                            if size == 0:
                                continue
                            if b > cur_b:
                                gap_len = b - cur_b
                                new_spans.append(Span(gap_len, "resync", resync_id, None, t_chk, resync_id))
                            for k in range(a, min(a + size, len(char_spans))):
                                orig_sp = char_spans[k]
                                new_spans.append(Span(1, orig_sp.origin, orig_sp.lineage, orig_sp.ai_ref, orig_sp.t_insert, orig_sp.placed_by))
                            cur_b = b + size
                        if cur_b < len(snap_text):
                            tail_len = len(snap_text) - cur_b
                            new_spans.append(Span(tail_len, "resync", resync_id, None, t_chk, resync_id))

                        merged_new_spans = []
                        for sp in new_spans:
                            if sp.length <= 0:
                                continue
                            if merged_new_spans and merged_new_spans[-1].lineage == sp.lineage and merged_new_spans[-1].placed_by == sp.placed_by:
                                merged_new_spans[-1].length += sp.length
                            else:
                                merged_new_spans.append(sp)

                        # Ký tự và dòng mà resync đưa vào (log IDE không ghi), tính trên snap_text
                        new_chars = 0
                        new_line_idx = set()
                        pos = 0
                        for sp in merged_new_spans:
                            if sp.origin == "resync" and sp.length > 0:
                                new_chars += sp.length
                                l0 = snap_text.count("\n", 0, pos)
                                seg_txt = snap_text[pos:pos + sp.length]
                                for k in range(seg_txt.count("\n") + 1):
                                    new_line_idx.add(l0 + k)
                            pos += sp.length
                        n_snap_lines = len(snap_text.splitlines())
                        new_lines = len([i for i in new_line_idx if i < n_snap_lines])

                        file_contents[f] = snap_text
                        file_spans[f] = merged_new_spans
                        n_lines = max(len(snap_text.split("\n")), 1)
                        file_line_ids[f] = [f"L{line_counter + k:04d}" for k in range(n_lines)]
                        line_counter += n_lines

                        resync_ed = {
                            "id": resync_id,
                            "t": t_chk,
                            "t_end": t_chk,
                            "ts_abs": t_abs,
                            "file": f,
                            "kind": "rep",
                            "range": {},
                            "offset": 0,
                            "deleted_len": len(cur_text),
                            "inserted": snap_text,
                            "origin": "resync",
                            "src": "resync",
                            "group": "unknown",
                            "paste_source": None,
                            "ai_request_id": req_id,
                            "agent_edit_before": False,
                            "chars_changed": diff_c,
                            "new_chars": new_chars,
                            "new_lines": new_lines,
                            "cancelled": False,
                            "cancelled_by": None,
                            "restores": None,
                            "touched_line_ids": list(file_line_ids[f]),
                            "start_line_1based": 1,
                        }
                        lineage_meta[resync_id] = {
                            "lineage": resync_id,
                            "origin": "resync",
                            "file": f,
                            "t_insert": t_chk,
                            "original_chars": diff_c,
                            "lines_inserted": len(snap_text.splitlines()),
                            "text": snap_text,
                            "ai_ref": None,
                        }
                        final_edits.append(resync_ed)
                        data.state_snapshots.append((t_chk, dict(file_contents), current_alive_map()))
                        data.spans_snapshots.append((t_chk, {f_s: [s.copy() for s in sps] for f_s, sps in file_spans.items()}))

        # 3.3b: Identify Cancelled Pairs (undo/redo within 30s that cancels a prior edit)
        edit_by_id = {e["id"]: e for e in final_edits}
        cancelled_pairs = []
        for idx, c in enumerate(final_edits):
            if c["origin"] not in ("undo", "redo"):
                continue
            # Look backwards for edit e on same file within cancel_window_ms
            for prev_idx in range(idx - 1, -1, -1):
                e = final_edits[prev_idx]
                if e["file"] != c["file"]:
                    continue
                dt = c["t"] - e["t"]
                if dt > cancel_window_ms:
                    break
                if dt < 0 or e.get("cancelled"):
                    continue
                # Condition 2: right before c there were chars with placed_by = e.id, right after c there are none
                cond2 = (e["id"] in c["_placed_before"]) and (e["id"] not in c["_placed_after"])
                # Or if e was a pure deletion and c restores e.id
                cond_del_restore = (len(e["inserted"]) == 0 and e["deleted_len"] > 0 and c.get("restores") == e["id"])
                # Condition 3: e deleted nothing, or c.restores == e.id
                cond3 = (e["deleted_len"] == 0) or (c.get("restores") == e["id"])
                if (cond2 and cond3) or cond_del_restore:
                    # If e itself had cancelled an earlier edit e0, un-cancel e0! (Spec 01 Section 3.3b)
                    if e.get("cancels_edit_id"):
                        e0_id = e["cancels_edit_id"]
                        if e0_id in edit_by_id:
                            edit_by_id[e0_id]["cancelled"] = False
                            edit_by_id[e0_id]["cancelled_by"] = None
                        cancelled_pairs = [cp for cp in cancelled_pairs if cp["edit_id"] != e0_id]

                    e["cancelled"] = True
                    e["cancelled_by"] = c["id"]
                    c["cancelled"] = True
                    c["cancels_edit_id"] = e["id"]
                    cancelled_pairs.append({
                        "edit_id": e["id"],
                        "by": c["id"],
                        "t": e["t"],
                        "t_by": c["t"],
                    })
                    break

        # Clean temporary sets
        for ed in final_edits:
            ed.pop("_placed_before", None)
            ed.pop("_placed_after", None)
            ed.pop("removed_spans", None)

        data.edits = final_edits
        data.final_files = file_contents
        data.final_spans = file_spans
        data.line_edits_by_file = line_edits_by_file
        data.final_line_ids = file_line_ids
        data.dq_report["checkpoints"] = {
            "total": total_checkpoints,
            "matched": matched_checkpoints,
            "resync_count": resync_count,
            "resync_chars": resync_chars,
            "stale": stale_checkpoints,
        }
        data.dq_report["resync"] = {
            "count": resync_count,
            "chars": resync_chars,
        }

        # Build provenance summary
        alive_end = current_alive_map()
        for lid, meta in lineage_meta.items():
            meta["alive_end"] = alive_end.get(lid, 0)
            meta["deleted_chars"] = deleted_chars_by_lineage.get(lid, 0)
            meta["deletion_times"] = deletion_times_by_lineage.get(lid, [])
            meta["interior_inserts"] = interior_insert_by_lineage.get(lid, [])
            meta["cancelled"] = edit_by_id[lid]["cancelled"] if lid in edit_by_id else False

        data.provenance = {
            "lineages": lineage_meta,
            "cancelled_pairs": cancelled_pairs,
            "repaste_families": [],  # Populated in TH4/TH5
        }

        # 4. Data Quality Report DQ1 - DQ8 (Spec 01 Section 4)
        # DQ1: tỷ lệ code log IDE không ghi, và file đã sửa so với snapshot_end đúng buổi
        logged_edits = [e for e in data.edits if e.get("origin") != "resync"]
        logged_by_id = {e["id"]: e for e in logged_edits}
        added_chars = sum(len(e.get("inserted") or "") for e in logged_edits if not e.get("cancelled")
                          and not logged_by_id.get(e.get("burst_head"), e).get("whitespace_only"))
        unlogged_chars = sum(e.get("new_chars", 0) for e in data.edits if e.get("origin") == "resync")
        unlogged_share = unlogged_chars / max(added_chars + unlogged_chars, 1)
        touched_files = {e["file"] for e in logged_edits}
        end_files = [f for f in (snapshot_end_files or {}) if f in touched_files and not is_non_code_uri(f)]
        end_diff = [f for f in end_files
                    if file_contents.get(f, "").replace("\r\n", "\n").strip()
                    != snapshot_end_files[f].replace("\r\n", "\n").strip()]
        if unlogged_share > self.params.get("dq.unlogged_fail_share", 0.30):
            dq1_level = "fail"
        elif not total_checkpoints and not end_files:
            dq1_level = "unverified"
        elif unlogged_share > self.params.get("dq.unlogged_warn_share", 0.10) or end_diff:
            dq1_level = "warn"
        else:
            dq1_level = "pass"
        dq1_ok = dq1_level != "fail"
        dq1_detail = f"{dq1_level}: {unlogged_share:.1%} code log IDE không ghi, {len(end_files) - len(end_diff)}/{len(end_files)} file khớp snapshot_end"

        runs_raw = [e for e in data.events if e.get("type") == "terminal_command"]
        trust_exit = self.params.get("fvscode.run.trust_exit", False)
        runs_observed = sum(
            1 for r in runs_raw
            if ((r.get("payload", {}).get("observed") or {}).get("outcome") not in (None, "unknown"))
            or (r.get("payload", {}).get("exitCode") is not None and trust_exit)
        )
        dq2_ratio = (runs_observed / len(runs_raw)) if runs_raw else 1.0

        known_origin_edits = sum(1 for e in data.edits if e.get("src") != "paste_unknown")
        dq3_ratio = (known_origin_edits / len(data.edits)) if data.edits else 1.0

        ai_reqs = {a.get("payload", {}).get("requestId") for a in data.ai_interactions if a.get("type") == "chat_request"}
        ai_resps = [a for a in data.ai_interactions if a.get("type") == "chat_response_complete"]
        linked_resps = sum(1 for r in ai_resps if r.get("payload", {}).get("requestId") in ai_reqs)
        dq4_ratio = (linked_resps / len(ai_resps)) if ai_resps else 1.0

        dq5_ratio = (inferred_links_count / max(len(ai_reqs), 1)) if ai_reqs else 0.0
        max_merge_w = max(merge_windows) if merge_windows else 0
        total_undo_inserted = sum(len(e.get("inserted", "")) for e in data.edits if e.get("src") in ("undo", "redo"))
        dq8_ratio = (unrestored_chars_count / total_undo_inserted) if total_undo_inserted > 0 else 0.0

        data.dq_report.update({
            "DQ1": dq1_ok,
            "reconstruction_ok": dq1_ok,
            "reconstruction_detail": dq1_detail,
            "reconstruction": {
                "level": dq1_level,
                "unlogged_share": round(unlogged_share, 4),
                "unlogged_chars": unlogged_chars,
                "added_chars": added_chars,
                "checkpoints": total_checkpoints,
                "end_files": len(end_files),
                "end_files_diff": end_diff,
            },
            "dq2_run_exit_code_ratio": round(dq2_ratio, 3),
            "dq3_edit_known_origin_ratio": round(dq3_ratio, 3),
            "dq4_ai_response_linked_ratio": round(dq4_ratio, 3),
            "dq5_ai_inferred_link_ratio": round(dq5_ratio, 3),
            "dq6_clock_monotonic": clock_monotonic,
            "dq7_max_merge_window_ms": max_merge_w,
            "dq8_undo_unrestored_ratio": round(dq8_ratio, 3),
            "session_start": data.login_info,
            "undo": {
                "restored_edits": restored_edits_count,
                "unrestored_chars": unrestored_chars_count,
                "cancelled_pairs": len(cancelled_pairs),
                "repaste_families": 0,
            },
            "checkpoints": {
                "total": total_checkpoints,
                "matched": matched_checkpoints,
                "resync_count": resync_count,
                "resync_chars": resync_chars,
                "stale": stale_checkpoints,
            },
            "resync": {
                "count": resync_count,
                "chars": resync_chars,
            },
        })
