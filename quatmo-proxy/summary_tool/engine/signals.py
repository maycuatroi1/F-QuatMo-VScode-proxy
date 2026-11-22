# -*- coding: utf-8 -*-
"""
Signals module (M1: TH1 - TH11) for PhaseSUMMARY Engine.
Implements Spec 02 (Tín hiệu TH1–TH11) and 'Phương pháp tóm tắt tiến trình làm bài (bản rút gọn, nhiều khía cạnh).md' Section 6.1.
"""

import os
import io
import re
import functools
import tokenize
import difflib
from typing import Dict, List, Any, Optional, Tuple
from .constants import DEFAULT_PARAMS, FVSCODE_LABELS, minute_label
from .ingestion import task_dir_of, split_user_prompt


def norm_ws(text: str) -> str:
    """Collapses all whitespace sequences into a single space and strips ends."""
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


@functools.lru_cache(maxsize=4096)
def normalize_code(text: str) -> str:
    """
    Normalizes code string N(x) according to Spec 02 TH4 (Rahe & Maalej):
    1. Strip line comments (# in Python via tokenize with regex fallback, // in C/JS/Java outside quotes).
    2. Strip trailing whitespace on each line.
    3. Replace internal whitespace runs with a single space.
    4. Remove blank lines.
    5. Join lines with \\n.
    """
    if not text:
        return ""
    src = text.replace("\r\n", "\n")

    # Try Python tokenize comment removal if text looks like Python (and not HTML)
    stripped_py = src
    if not src.lstrip().startswith("<"):
        try:
            tokens = tokenize.generate_tokens(io.StringIO(src).readline)
            out_Lines = src.splitlines(keepends=True)
            # Remove COMMENT tokens from lines
            comment_spans_by_line: Dict[int, int] = {}
            for tok_type, tok_str, start, end, _ in tokens:
                if tok_type == tokenize.COMMENT:
                    s_line, s_col = start
                    comment_spans_by_line[s_line - 1] = s_col
            if comment_spans_by_line:
                new_lines = []
                for idx, l in enumerate(out_Lines):
                    if idx in comment_spans_by_line:
                        new_lines.append(l[:comment_spans_by_line[idx]])
                    else:
                        new_lines.append(l)
                stripped_py = "".join(new_lines)
        except Exception:
            # Fallback: strip # comment when not inside quotes
            lines_fb = []
            for l in src.splitlines():
                if not l.lstrip().startswith("<"):
                    l = re.sub(r"(?<!['\"\w])#.*$", "", l)
                lines_fb.append(l)
            stripped_py = "\n".join(lines_fb)

    cleaned = []
    for line in stripped_py.splitlines():
        # Strip C/JS // comments outside URLs (not preceded by :)
        l = re.sub(r"(?<!:)//.*$", "", line)
        l = re.sub(r"\s+", " ", l).strip()
        if l:
            cleaned.append(l)
    return "\n".join(cleaned)


def extract_code_blocks(text: str) -> List[Dict[str, str]]:
    """Extracts fenced code blocks ```lang ... ``` from AI response markdown."""
    if not text:
        return []
    matches = re.findall(r"```([a-zA-Z0-9_\-\+]*)\n(.*?)```", text, re.DOTALL)
    blocks = []
    for lang, code in matches:
        c_clean = code.strip()
        if c_clean:
            blocks.append({"lang": lang.strip() or "python", "code": c_clean})
    if not blocks:
        lines = [l for l in text.splitlines() if l.strip()]
        if len(lines) >= 3 and any(("def " in l or "import " in l or "return " in l or "class " in l or "<html" in l or "<form" in l) for l in lines):
            blocks.append({"lang": "python", "code": text.strip()})
    return blocks


def calculate_overlap_ratio_and_containment(x: str, b: str, max_prod: int = 400000000) -> Tuple[float, float]:
    """Calculates Ratcliff/Obershelp ratio and containment using difflib.SequenceMatcher(autojunk=False)."""
    if not x or not b:
        return 0.0, 0.0
    if len(x) * len(b) > max_prod:
        window_size = 2 * len(x)
        step = max(len(x) // 2, 1)
        best_ratio, best_cont = 0.0, 0.0
        for i in range(0, max(len(b) - window_size + 1, 1), step):
            sub_b = b[i:i + window_size]
            m = difflib.SequenceMatcher(None, x, sub_b, autojunk=False)
            match_chars = sum(block.size for block in m.get_matching_blocks())
            r = 2.0 * match_chars / (len(x) + len(sub_b)) if (len(x) + len(sub_b)) > 0 else 0.0
            c = match_chars / len(x) if len(x) > 0 else 0.0
            if r > best_ratio:
                best_ratio = r
            if c > best_cont:
                best_cont = c
        return best_ratio, best_cont

    matcher = difflib.SequenceMatcher(None, x, b, autojunk=False)
    match_chars = sum(block.size for block in matcher.get_matching_blocks())
    ratio = (2.0 * match_chars) / (len(x) + len(b)) if (len(x) + len(b)) > 0 else 0.0
    containment = match_chars / len(x) if len(x) > 0 else 0.0
    return ratio, containment


class SignalsAnalyzer:
    def __init__(self, session_data, params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)
        self.signals: Dict[str, Any] = {}

    def analyze(self) -> Dict[str, Any]:
        """Executes M1 signal extraction pipeline (TH1 - TH11) in dependency order."""
        self._analyze_th2_runs()
        self._analyze_th1_pauses()
        self._analyze_th3_threads()
        self._analyze_th7_requests()
        self._analyze_th4_ai_linkage()
        self._analyze_th5_and_th11_ai_fate()
        self._analyze_th6_uptake()
        self._analyze_th8_context()
        self._analyze_th9_reactions()
        self._analyze_th10_bursts()
        return self.signals

    # =========================================================================
    # TH2: Terminal Runs, Outcomes, and Error Signatures (Spec 02 TH2)
    # =========================================================================
    def _analyze_th2_runs(self):
        runs = []
        start_ts = self.data.start_ts
        run_patterns = self.data.task_config.get("run_patterns", {})
        sig_mode = self.params.get("errors.signature_mode", "default")

        run_idx = 0
        for ev in self.data.events:
            if ev.get("type") != "terminal_command":
                continue
            p = ev.get("payload", {})
            cmd = str(p.get("command", "")).strip()
            if not cmd:
                continue

            # Ignore environment activation and PowerShell execution policy setup commands
            if "activate.ps1" in cmd.lower() or "set-executionpolicy" in cmd.lower():
                continue

            # Classify command against task.run_patterns (test -> run -> build -> other)
            kind = "other"
            for k_type in ("test", "run", "build"):
                pats = run_patterns.get(k_type, [])
                if any(re.search(pat, cmd, re.IGNORECASE) for pat in pats):
                    kind = k_type
                    break

            if kind not in ("run", "test"):
                continue

            run_idx += 1
            ts_abs = ev.get("timestamp", start_ts)
            t_rel = max(ts_abs - start_ts, 0)
            dur = int(p.get("durationMs", 0) or 0)
            if p.get("long_lived"):
                dur = 0
            t_end_rel = t_rel + dur
            exit_code = p.get("exitCode")
            stdout_tail = str(p.get("stdout_tail") or "")
            stderr_tail = str(p.get("stderr_tail") or "")

            # Extract script (Spec 02 TH2)
            script = p.get("script") or ""
            if not script:
                py_matches = re.findall(r"([\w\-./\\]+\.py)\b", cmd)
                if py_matches:
                    script = re.split(r"[/\\]", py_matches[-1])[-1]
                else:
                    tokens = [tok for tok in cmd.split() if not tok.startswith("-") and tok.lower() not in ("python", "python3", "pytest", "flask", "node", "py", "py.exe")]
                    script = re.split(r"[/\\]", tokens[0])[-1] if tokens else "app.py"

            # Parse error line and location from stderr_tail if available
            err_type, msg_raw, location = self._parse_error_and_location(stderr_tail)

            # Chuỗi lỗi tính theo script, nên Q1/app.py và Q2/app.py là hai script
            py_path = re.findall(r"([\w\-./\\:]+\.py)\b", cmd)
            task_dir = task_dir_of(py_path[-1] if py_path else "", p.get("cwd"), cmd, (location or {}).get("file"))
            if task_dir and "/" not in script:
                script = f"{task_dir}/{script}"

            # Determine outcome (Spec 02 TH2: error, test_fail, server_started, no_error_seen, unknown)
            outcome = "unknown"
            outcome_source = "none"
            tests_info = None

            obs = p.get("observed")
            if obs is not None:
                outcome = obs.get("outcome", "unknown")
                outcome_source = obs.get("source", "observed")
                err_type = obs.get("error_type")
                msg_raw = obs.get("err_line")
                location = obs.get("location")
                # err_line của E1, E2 là cả dòng "TênLỗi: thông điệp". Tách như _parse_error_and_location để
                # chữ ký không lặp loại lỗi ("NameError: NameError: ...") và loại lỗi luôn là tên cuối (bỏ module)
                m_line = re.match(r"^\s*([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt))(?::\s*(.*))?$", msg_raw or "")
                if m_line:
                    err_type = m_line.group(1).split(".")[-1]
                    msg_raw = (m_line.group(2) or "").strip()
                elif err_type:
                    err_type = err_type.split(".")[-1]
            elif kind == "test":
                tests_info = self._parse_test_results(stdout_tail + "\n" + stderr_tail)
                if tests_info and (tests_info.get("passed") or tests_info.get("failed")):
                    outcome = "test_fail" if tests_info.get("failed") else "no_error_seen"
                    if err_type and err_type != "AssertionError":
                        outcome = "error"
                    outcome_source = "test_result"
                elif err_type and err_type != "AssertionError":
                    outcome = "error"
                    outcome_source = "stderr"
                elif exit_code is not None and self.params.get("fvscode.run.trust_exit", False):
                    outcome = "error" if exit_code != 0 else "no_error_seen"
                    outcome_source = "exit_code"
            elif exit_code is not None and self.params.get("fvscode.run.trust_exit", False) and not p.get("long_lived"):
                outcome = "error" if exit_code != 0 else "no_error_seen"
                outcome_source = "exit_code"
            else:
                if err_type:
                    outcome = "error"
                    outcome_source = "stderr"
                elif "running on" in (stdout_tail + stderr_tail).lower() or "press ctrl+c" in (stdout_tail + stderr_tail).lower():
                    outcome = "server_started"
                    outcome_source = "output"
                elif stdout_tail or stderr_tail:
                    outcome = "no_error_seen"
                    outcome_source = "output"
                else:
                    outcome = "unknown"
                    outcome_source = "none"

            # Check HTTP 500 error code
            last_page = p.get("last_page_code") or (obs or {}).get("last_page_code")
            if last_page and int(last_page) >= 500:
                outcome = "error"
                if not err_type:
                    err_type = "HTTP500"
                if not msg_raw:
                    msg_raw = f"HTTP 500 Internal Server Error"

            # Clear error fields for non-error outcomes
            if outcome in ("server_started", "no_error_seen", "unknown"):
                err_type = None
                msg_raw = None
                location = None

            # Compute 3 signature modes (default, keep_quoted, type_only)
            sig_default, sig_keep_quoted, sig_type_only = None, None, None
            if outcome in ("error", "test_fail"):
                if err_type:
                    norm_def = self._normalize_error_message(msg_raw, keep_quoted=False)
                    norm_kq = self._normalize_error_message(msg_raw, keep_quoted=True)
                    sig_default = f"{err_type}: {norm_def}" if norm_def else err_type
                    sig_keep_quoted = f"{err_type}: {norm_kq}" if norm_kq else err_type
                    sig_type_only = err_type
                elif exit_code is not None and exit_code != 0:
                    err_type = "RuntimeError" if kind == "run" else "AssertionError"
                    sig_default = f"exit:{exit_code}"
                    sig_keep_quoted = f"exit:{exit_code}"
                    sig_type_only = err_type

            sig_chosen = sig_default
            if sig_mode == "keep_quoted":
                sig_chosen = sig_keep_quoted
            elif sig_mode == "type_only":
                sig_chosen = sig_type_only

            runs.append({
                "id": f"r{run_idx:02d}",
                "run_id": f"r{run_idx:02d}",
                "t": t_rel,
                "t_end": t_end_rel,
                "ts_abs": ts_abs,
                "ts_abs_end": ts_abs + dur,
                "kind": kind,
                "script": script,
                "command": cmd,
                "exit_code": exit_code,
                "outcome": outcome,
                "outcome_source": outcome_source,
                "error_type": err_type,
                "message_raw": msg_raw,
                "signature": sig_chosen,
                "signature_default": sig_default,
                "signature_keep_quoted": sig_keep_quoted,
                "signature_type_only": sig_type_only,
                "location": location,
                "tests": tests_info,
                "observed_at_ts": p.get("observed_at_ts"),
                "t_source": p.get("t_source", "log"),
                "t_lo": max(int(p["t_lo_ts"]) - start_ts, 0) if p.get("t_lo_ts") is not None else None,
                "page_loads": p.get("page_loads"),
                "last_page_code": p.get("last_page_code"),
                "observed": p.get("observed"),
                "startup_err_dropped": p.get("startup_err_dropped"),
                "rule": "TH2",
                "rule_version": "3.0",
                "sources": [f"r{run_idx:02d}"],
            })

        runs.sort(key=lambda x: x["t"])
        self.signals["runs"] = runs
        self.signals["runs_by_outcome"] = {
            k: sum(1 for r in runs if r.get("outcome") == k)
            for k in ("error", "test_fail", "server_started", "no_error_seen", "unknown")
        }

    def _parse_error_and_location(self, stderr_text: str) -> Tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
        if not stderr_text:
            return None, None, None
        err_pat = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt))(?::\s*(.*))?$")
        err_type = None
        msg_raw = None
        for line in reversed(stderr_text.splitlines()):
            l_strip = line.strip()
            m = err_pat.match(l_strip)
            if m:
                err_type = m.group(1).split(".")[-1]
                msg_raw = (m.group(2) or "").strip()
                break

        location = None
        if err_type:
            tb_matches = re.findall(r'File "([^"]+)", line (\d+)', stderr_text)
            for f_path, l_num in reversed(tb_matches):
                if "site-packages" not in f_path and "lib/python" not in f_path.lower():
                    from .ingestion import normalize_rel_path
                    location = {"file": normalize_rel_path(f_path), "line": int(l_num)}
                    break
        return err_type, msg_raw, location

    def _normalize_error_message(self, msg: Optional[str], keep_quoted: bool = False) -> str:
        """5-step normalization of error message (Spec 02 TH2, U3)."""
        if not msg:
            return ""
        s = msg
        if not keep_quoted:
            s = re.sub(r"'[^']*'|\"[^\"]*\"", "<str>", s)
        s = re.sub(r"(?:[A-Za-z]:\\|/)[\w\\/.:\-]+", "<path>", s)
        s = re.sub(r"0x[0-9a-fA-F]+", "<addr>", s)
        s = re.sub(r"\b\d+(?:\.\d+)?\b", "<num>", s)
        return norm_ws(s)

    def _normalize_signature(self, sig: Optional[str]) -> str:
        """Normalize signature for comparison: strip module prefix and repeated 'ErrorName: ' at start."""
        if not sig:
            return ""
        sig = sig.strip()
        m = re.match(r"^([A-Za-z_][\w.]*):\s*(.*)$", sig)
        if not m:
            return sig.split(".")[-1]
        err_name = m.group(1).split(".")[-1]
        rest = m.group(2)
        while True:
            m_rep = re.match(r"^([A-Za-z_][\w.]*):\s*(.*)$", rest)
            if m_rep and m_rep.group(1).split(".")[-1] == err_name:
                rest = m_rep.group(2)
            else:
                break
        return f"{err_name}: {rest}" if rest else err_name

    def _parse_test_results(self, output: str) -> Optional[Dict[str, List[str]]]:
        if not output:
            return None
        passed = re.findall(r"PASSED\s+[\w/.:\-]+::(\w+)", output)
        failed = re.findall(r"FAILED\s+[\w/.:\-]+::(\w+)", output)
        if not passed and not failed:
            return None
        return {"passed": passed, "failed": failed}

    # =========================================================================
    # TH1: Pauses, Work Sessions, and Estimated Task Time (Spec 02 TH1)
    # =========================================================================
    def _analyze_th1_pauses(self):
        start_ts = self.data.start_ts
        end_ts = self.data.end_ts
        total_duration = max(end_ts - start_ts, 0)

        # Build tagged active intervals: (start_rel, end_rel, opener_tag, event_id, deleted_lines)
        raw_intervals: List[Tuple[int, int, str, str, int]] = []

        for ed in self.data.edits:
            if ed.get("origin") == "resync":
                continue
            t_s = ed["t"]
            t_e = max(ed.get("t_end", t_s), t_s)
            orig = ed.get("origin", "typed")
            ins = ed.get("inserted", "")
            d_len = ed.get("deleted_len", 0)
            if orig in ("ai_insert", "ai_agent", "ai_autocomplete"):
                tag = "ai_insert"
            elif orig.startswith("paste"):
                tag = "paste"
            elif not ins and d_len > 0:
                tag = "delete"
            else:
                tag = "type"
            del_lines = (ins.count("\n") + 1) if tag == "delete" else 0
            raw_intervals.append((t_s, t_e, tag, ed["id"], del_lines))

        for r in self.signals.get("runs", []):
            if r.get("t_source") == "capture":
                continue  # mốc của lần chạy dựng từ terminal chụp chỉ là cận trên, không dùng để đo khoảng dừng
            tag = f"run_{r.get('outcome', 'unknown')}"
            raw_intervals.append((r["t"], max(r["t_end"], r["t"]), tag, r["id"], 0))

        # Page loads are active events (U11, Spec 02 TH1)
        if self.params.get("pause.include_page_loads", True):
            for idx, ev in enumerate(self.data.events):
                if ev.get("type") == "http_request":
                    t_rel = max(ev.get("timestamp", start_ts) - start_ts, 0)
                    raw_intervals.append((t_rel, t_rel, "page_load", f"http_{idx}", 0))

        # Waiting for AI response is active time (U11)
        req_start_map: Dict[str, int] = {}
        for a in self.data.ai_interactions:
            atype = a.get("type")
            req_id = a.get("payload", {}).get("requestId", "")
            t_rel = max(a.get("timestamp", start_ts) - start_ts, 0)
            if atype == "chat_request":
                if req_id:
                    req_start_map[req_id] = t_rel
                raw_intervals.append((t_rel, t_rel + 1000, "ai_request", req_id or "req", 0))
            elif atype == "chat_response_complete":
                t_req = req_start_map.get(req_id, t_rel)
                raw_intervals.append((min(t_req, t_rel), max(t_req, t_rel), "ai_response", req_id or "resp", 0))

        if not raw_intervals:
            self.signals["pauses"] = []
            self.signals["T_task_ms"] = 0
            self.signals["duration_ms"] = total_duration
            self.signals["work_sessions"] = [(0, total_duration)] if total_duration > 0 else []
            self.signals["n_pauses_ge_3min"] = 0
            return

        raw_intervals.sort(key=lambda x: (x[0], x[1]))

        # Merge overlapping intervals while preserving end opener and start follower tags
        merged: List[Dict[str, Any]] = []
        cur = {
            "start": raw_intervals[0][0],
            "end": raw_intervals[0][1],
            "start_tag": raw_intervals[0][2],
            "end_tag": raw_intervals[0][2],
            "start_id": raw_intervals[0][3],
            "end_id": raw_intervals[0][3],
            "del_lines": raw_intervals[0][4],
        }
        for s, e, tag, eid, dlines in raw_intervals[1:]:
            if s <= cur["end"]:
                if e >= cur["end"]:
                    cur["end"] = e
                    cur["end_tag"] = tag
                    cur["end_id"] = eid
                if tag == "delete":
                    cur["del_lines"] += dlines
            else:
                merged.append(cur)
                cur = {
                    "start": s,
                    "end": e,
                    "start_tag": tag,
                    "end_tag": tag,
                    "start_id": eid,
                    "end_id": eid,
                    "del_lines": dlines,
                }
        merged.append(cur)

        tiers_ms = self.params.get("pause.tiers_ms", [2000, 15000, 180000, 600000])
        session_break_ms = self.params.get("pause.session_break_ms", 300000)
        pauses = []
        t_task_ms = sum(m["end"] - m["start"] for m in merged)
        work_sessions = []
        ws_start = merged[0]["start"]

        for k in range(1, len(merged)):
            prev_m = merged[k - 1]
            curr_m = merged[k]
            gap = curr_m["start"] - prev_m["end"]

            if gap >= tiers_ms[0]:
                tier = "vi_mo"
                if gap >= tiers_ms[3]:
                    tier = "dai"
                elif gap >= tiers_ms[2]:
                    tier = "vua"
                elif gap >= tiers_ms[1]:
                    tier = "ngan"

                pauses.append({
                    "id": f"p{len(pauses) + 1:03d}",
                    "start": prev_m["end"],
                    "end": curr_m["start"],
                    "t_start": prev_m["end"] + start_ts,
                    "t_end": curr_m["start"] + start_ts,
                    "length": gap,
                    "tier": tier,
                    "opener": prev_m["end_tag"],
                    "follower": curr_m["start_tag"],
                    "deleted_lines": prev_m["del_lines"] if prev_m["end_tag"] == "delete" else 0,
                    "rule": "TH1",
                    "rule_version": "1.0",
                    "sources": [prev_m["end_id"], curr_m["start_id"]],
                })

            if gap < session_break_ms:
                t_task_ms += gap
            else:
                work_sessions.append((ws_start, prev_m["end"]))
                ws_start = curr_m["start"]

        work_sessions.append((ws_start, merged[-1]["end"]))
        duration_ms = max(merged[-1]["end"] - merged[0]["start"], total_duration)

        self.signals["pauses"] = pauses
        self.signals["T_task_ms"] = t_task_ms
        self.signals["duration_ms"] = duration_ms
        self.signals["work_sessions"] = work_sessions
        self.signals["n_pauses_ge_3min"] = sum(1 for p in pauses if p["length"] >= self.params.get("pause.segment_ms", 180000))

    # =========================================================================
    # TH3: Repeated Error Threads, Test Streaks, and Between-Run Edits (Spec 02 TH3)
    # =========================================================================
    def _analyze_th3_threads(self):
        runs = self.signals.get("runs", [])
        repeat_min = self.params.get("errors.repeat_runs", 3)
        minor_max_lines = self.params.get("runs.minor_change_lines", 2)
        no_edit_repeat_min = self.params.get("runs.no_edit_repeat", 2)
        end_session_rel = max(self.data.end_ts - self.data.start_ts, 0)

        # 1. Error chains calculated per script on kind == "run" (Spec 02 TH3)
        chains = []
        scripts = sorted(list({r.get("script") for r in runs if r.get("script")}))
        if not scripts and runs:
            scripts = ["main.py"]

        for script in scripts:
            cur = None
            pending_unknown = 0
            for r in [r for r in runs if r.get("kind") == "run" and r.get("script") == script]:
                if r["outcome"] == "unknown":
                    if cur:
                        pending_unknown += 1  # không nối dài, không cắt chuỗi
                    continue
                if r["outcome"] == "error" and cur and cur["signature"] == r["signature"]:
                    cur["runs"].append(r)
                    cur["unknown_between"] += pending_unknown
                    cur["last_error_t"] = r["t"]
                    pending_unknown = 0
                    continue
                if cur:
                    cur["ended_at_t"] = r["t"]
                    cur["ended_by_outcome"] = r["outcome"]
                    cur["repeated"] = len(cur["runs"]) >= repeat_min
                    cur["sources"] = [x["id"] for x in cur["runs"]]
                    chains.append(cur)
                    cur = None
                if r["outcome"] == "error":
                    cur = {
                        "id": f"th_{len(chains) + 1:02d}",
                        "script": script,
                        "signature": r["signature"],
                        "error_type": r.get("error_type") or "RuntimeError",
                        "location": r.get("location"),
                        "runs": [r],
                        "unknown_between": 0,
                        "start_t": r["t"],
                        "last_error_t": r["t"],
                        "ended_at_t": None,
                        "ended_by_outcome": None,
                        "repeated": False,
                        "requests_in_span": [],
                        "rule": "TH3",
                        "rule_version": "3.0",
                        "sources": [r["id"]],
                    }
                pending_unknown = 0
            if cur:
                cur["repeated"] = len(cur["runs"]) >= repeat_min
                cur["sources"] = [x["id"] for x in cur["runs"]]
                chains.append(cur)

        threads = chains

        # Compute Ohno et al. metrics for each thread (Spec 02 TH3)
        for th in threads:
            th["sources"] = [r["id"] for r in th["runs"]]
            t0 = th["runs"][0]["t"]
            t1 = th["ended_at_t"] if th["ended_at_t"] is not None else end_session_rel
            th_edits = [
                e for e in self.data.edits
                if t0 <= e["t"] <= t1 and not e.get("cancelled")
            ]
            line_counts: Dict[str, int] = {}
            for e in th_edits:
                for lid in e.get("touched_line_ids", []):
                    line_counts[lid] = line_counts.get(lid, 0) + 1
            n_lines = len(line_counts)
            total_touches = sum(line_counts.values())
            freq = 0.0
            if n_lines > 1 and total_touches > 0:
                mu = 1.0 / n_lines
                freq = (1.0 / n_lines) * sum(((c / total_touches) - mu) ** 2 for c in line_counts.values())
            th["ohno"] = {
                "freq": round(freq, 4),
                "revs": len(th_edits),
                "n_lines": n_lines,
            }

        # 2. Test streaks (consecutive test runs failing the same test_id)
        test_streaks = []
        active_streaks: Dict[str, List[Dict[str, Any]]] = {}
        for r in runs:
            if r.get("tests") is None:
                continue
            failed_ids = set(r["tests"].get("failed", []))
            # Check existing streaks
            for tid in list(active_streaks.keys()):
                if tid in failed_ids:
                    active_streaks[tid].append(r)
                else:
                    s_runs = active_streaks.pop(tid)
                    if len(s_runs) >= repeat_min:
                        test_streaks.append({
                            "test_id": tid,
                            "runs": len(s_runs),
                            "run_list": s_runs,
                            "start_t": s_runs[0]["t"],
                            "end_t": s_runs[-1]["t_end"],
                            "resolved_at_t": r["t"],
                            "rule": "TH3",
                            "rule_version": "3.0",
                            "sources": [x["id"] for x in s_runs],
                        })
            for tid in failed_ids:
                if tid not in active_streaks:
                    active_streaks[tid] = [r]

        for tid, s_runs in active_streaks.items():
            if len(s_runs) >= repeat_min:
                test_streaks.append({
                    "test_id": tid,
                    "runs": len(s_runs),
                    "run_list": s_runs,
                    "start_t": s_runs[0]["t"],
                    "end_t": s_runs[-1]["t_end"],
                    "resolved_at_t": None,
                    "rule": "TH3",
                    "rule_version": "3.0",
                    "sources": [x["id"] for x in s_runs],
                })

        # 3. Work between consecutive runs per script (between_runs & rerun_no_change)
        between_runs = []
        rerun_no_change = []

        for script in scripts:
            script_runs = [r for r in runs if r.get("script") == script]
            no_change_streak = 0
            no_change_start_t = 0
            for k in range(len(script_runs) - 1):
                rk = script_runs[k]
                rk1 = script_runs[k + 1]
                t_a = rk["t_end"]
                t_b = rk1["t"]

                interval_edits = []
                for e in self.data.edits:
                    if t_a < e["t"] <= t_b:
                        if e.get("cancelled") or e.get("origin") == "resync":
                            continue
                        interval_edits.append(e)

                chars_added = sum(len(e.get("inserted", "")) for e in interval_edits)
                chars_deleted = sum(e.get("deleted_len", 0) for e in interval_edits)
                lines_touched = set()
                origin_mix: Dict[str, int] = {}
                for e in interval_edits:
                    for lid in e.get("touched_line_ids", []):
                        lines_touched.add(lid)
                    orig = e.get("origin", "typed")
                    origin_mix[orig] = origin_mix.get(orig, 0) + len(e.get("inserted", ""))

                if chars_added + chars_deleted == 0:
                    label = "no_change"
                    if no_change_streak == 0:
                        no_change_start_t = rk["t"]
                    no_change_streak += 1
                else:
                    if no_change_streak + 1 > no_edit_repeat_min:
                        rerun_no_change.append({
                            "script": script,
                            "runs": no_change_streak + 1,
                            "start_t": no_change_start_t,
                            "end_t": rk["t_end"],
                        })
                    no_change_streak = 0
                    if 1 <= len(lines_touched) <= minor_max_lines:
                        label = "minor"
                    else:
                        label = "major"

                # Check deleted_error_line
                deleted_error_line = False
                if rk["outcome"] == "error" and rk.get("location") and rk1.get("signature") != rk.get("signature"):
                    loc_line = rk["location"].get("line")
                    if any(e.get("deleted_len", 0) > 0 and not e.get("inserted") and e.get("start_line_1based") == loc_line for e in interval_edits):
                        deleted_error_line = True

                between_runs.append({
                    "script": script,
                    "from_run": rk["id"],
                    "to_run": rk1["id"],
                    "t_start": t_a,
                    "t_end": t_b,
                    "chars_added": chars_added,
                    "chars_deleted": chars_deleted,
                    "n_lines_touched": len(lines_touched),
                    "origin_mix": origin_mix,
                    "label": label,
                    "deleted_error_line": deleted_error_line,
                    "rule": "TH3",
                    "rule_version": "3.0",
                    "sources": [rk["id"], rk1["id"]],
                })

            if no_change_streak + 1 > no_edit_repeat_min and script_runs:
                rerun_no_change.append({
                    "script": script,
                    "runs": no_change_streak + 1,
                    "start_t": no_change_start_t,
                    "end_t": script_runs[-1]["t_end"],
                })

        # Attach between_labels and deleted_error_line to each thread
        br_by_from = {br["from_run"]: br for br in between_runs}
        for th in threads:
            th_run_ids = [r["id"] for r in th.get("runs", [])]
            b_labels = []
            del_err_line = False
            for r_id in th_run_ids[:-1]:
                br = br_by_from.get(r_id)
                if br:
                    b_labels.append("none" if br["label"] == "no_change" else br["label"])
            if th_run_ids:
                last_br = br_by_from.get(th_run_ids[-1])
                if last_br and last_br.get("deleted_error_line"):
                    del_err_line = True
            th["between_labels"] = b_labels
            th["deleted_error_line"] = del_err_line

        self.signals["chains"] = chains
        self.signals["threads"] = threads
        self.signals["n_chains_repeated"] = sum(1 for t in chains if t.get("repeated"))
        self.signals["n_threads_repeated"] = self.signals["n_chains_repeated"]
        self.signals["test_streaks"] = test_streaks
        self.signals["between_runs"] = between_runs
        self.signals["rerun_no_change"] = rerun_no_change

    # =========================================================================
    # TH7: AI Request Taxonomy & Deterministic Flags (Spec 02 TH7, Version 3.0)
    # =========================================================================
    def _analyze_th7_requests(self):
        start_ts = self.data.start_ts
        ai_items = self.data.ai_interactions
        runs = self.signals.get("runs", [])
        statement_paras = [p for p in self.data.task_config.get("statement_paragraphs", []) if len(p) >= self.params.get("prompt.task_paragraph_min_chars", 50)]
        task_cont_thresh = self.params.get("prompt.task_containment", 0.80)
        own_code_min_lines = self.params.get("prompt.own_code_lines", 3)
        err_pat = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception))(?::\s*(.*))?$")

        # Index AI responses by request_id
        resp_by_req: Dict[str, Dict[str, Any]] = {}
        for a in ai_items:
            if a.get("type") == "chat_response_complete":
                p = a.get("payload", {})
                rid = p.get("requestId", "")
                t_rel = max(a.get("timestamp", start_ts) - start_ts, 0)
                text = str(p.get("text", ""))
                blocks = extract_code_blocks(text)
                resp_by_req[rid] = {
                    "request_id": rid,
                    "t_end": t_rel,
                    "ts_abs_end": a.get("timestamp", start_ts),
                    "text": text,
                    "code_blocks": blocks,
                    "norm_blocks": [normalize_code(b["code"]) for b in blocks if b["code"].strip()],
                    "rejected": bool(p.get("error")),
                    "cancelled": bool(p.get("cancelled")),
                }

        # Index prompts for F-VSCode proxy label
        prompts_by_req: Dict[str, Dict[str, Any]] = {}
        for pe in getattr(self.data, "prompts", []):
            if isinstance(pe, dict):
                rid = pe.get("requestId")
                if rid:
                    prompts_by_req[rid] = pe

        req_list = []
        req_idx = 0
        current_conv_id = None
        prev_hist_len = None
        conv_counter = 0

        for a in ai_items:
            if a.get("type") != "chat_request":
                continue
            req_idx += 1
            p = a.get("payload", {})
            req_id = p.get("requestId") or f"req_{req_idx:02d}"

            # Read F-VSCode proxy label directly (Spec 02 TH7: I, M, E, unknown; QĐ23, U30)
            # Log máy chủ không có requestId, nên dùng cặp đã ghép ở M0.3; nhãn nằm ở classification.label
            pe_match = prompts_by_req.get(req_id) or getattr(self.data, "proxy_by_request", {}).get(req_id)

            # Phân tách cuộc hội thoại theo history của proxy log máy chủ (TH7)
            hist = pe_match.get("history") if pe_match else None
            if isinstance(hist, list):
                hist_len = len(hist)
                if hist_len <= 2 or prev_hist_len is None or hist_len < prev_hist_len:
                    conv_counter += 1
                    current_conv_id = f"cv_{conv_counter:02d}"
                prev_hist_len = hist_len
                conv_id = current_conv_id
            else:
                conv_counter += 1
                conv_id = p.get("conversationId") or p.get("sessionId") or f"cv_{conv_counter:02d}"
                current_conv_id = conv_id
                prev_hist_len = None

            ts_abs = a.get("timestamp", start_ts)
            t_rel = max(ts_abs - start_ts, 0)
            msgs = p.get("messages", [])
            user_msgs = [m.get("content", "") for m in msgs if m.get("role") == "user"]
            user_msg = user_msgs[-1] if user_msgs else ""

            # Phần sinh viên viết: bỏ mọi khối khung chat tự thêm (file đính kèm, file đang mở, chỉ dẫn, tab)
            pure_prompt, _attached_files = split_user_prompt(user_msg)

            if pe_match and not pe_match.get("_misattached"):
                cls = pe_match.get("classification")
                raw_label = (p.get("label")
                             or pe_match.get("label")
                             or pe_match.get("proxy_label")
                             or (cls.get("label") if isinstance(cls, dict) else None))
            else:
                cls = None
                raw_label = p.get("label")
            if raw_label in ("I", "M", "E"):
                label = raw_label
            elif raw_label in ("instrumental", "INSTRUMENTAL", "INVESTIGATING", "investigating", "kien_tao", "KIEN_TAO"):
                label = "I"
            elif raw_label in ("MIXED", "mixed", "hon_hop", "HON_HOP"):
                label = "M"
            elif raw_label in ("executive", "EXECUTIVE", "EXTERNALIZING", "externalizing", "uy_thac", "UY_THAC"):
                label = "E"
            else:
                label = "unknown"

            # Cờ 1: flag_error & prompt_error_signature (Spec 02 TH7)
            err_lines_in_u = []
            for line in pure_prompt.splitlines():
                l_str = line.strip()
                m_err = err_pat.match(l_str)
                if m_err:
                    err_type_u = m_err.group(1).split(".")[-1]
                    msg_u = (m_err.group(2) or "").strip()
                    norm_m = self._normalize_error_message(msg_u, keep_quoted=False)
                    sig_u = f"{err_type_u}: {norm_m}" if norm_m else err_type_u
                    err_lines_in_u.append(sig_u)
                elif l_str.startswith("Traceback"):
                    err_lines_in_u.append("Traceback")

            flag_error = len(err_lines_in_u) > 0
            prompt_error_signature = None
            matches_run = None
            if flag_error:
                prompt_error_signature = err_lines_in_u[-1]
                # Find nearest run before q with outcome == error and signature_default == prompt_error_signature
                if prompt_error_signature != "Traceback":
                    norm_prompt_sig = self._normalize_signature(prompt_error_signature)
                    prior_err_runs = [
                        r for r in runs
                        if r["t"] <= t_rel and r["outcome"] == "error"
                        and r.get("signature_default")
                        and self._normalize_signature(r.get("signature_default")) == norm_prompt_sig
                    ]
                    if prior_err_runs:
                        matches_run = prior_err_runs[-1]["id"]

            # Cờ 2: flag_task (Spec 02 TH7: containment >= 0.80 of statement paragraph >= 50 chars)
            flag_task = False
            norm_prompt_ws = norm_ws(pure_prompt)
            if statement_paras and len(norm_prompt_ws) >= 32:
                for para in statement_paras:
                    norm_p = norm_ws(para)
                    if not norm_p or len(norm_p) < 50:
                        continue
                    _, cont = calculate_overlap_ratio_and_containment(norm_p, norm_prompt_ws)
                    if cont >= task_cont_thresh:
                        flag_task = True
                        break

            # Cờ 3: flag_own_code (Spec 02 TH7: >= 3 consecutive lines of state_at(q.t) in user_text)
            flag_own_code = False
            state_now = self.data.state_at(t_rel)
            combined_query_txt = pure_prompt
            for f_content in state_now.values():
                code_lines = [norm_ws(l) for l in f_content.splitlines() if len(norm_ws(l)) >= 8]
                if len(code_lines) >= own_code_min_lines:
                    for i in range(len(code_lines) - own_code_min_lines + 1):
                        window = code_lines[i:i + own_code_min_lines]
                        if all(w_line in combined_query_txt for w_line in window):
                            flag_own_code = True
                            break
                if flag_own_code:
                    break

            resp_info = resp_by_req.get(req_id)
            resp_code_lines = 0
            has_code_resp = False
            if resp_info and resp_info["code_blocks"]:
                has_code_resp = True
                resp_code_lines = sum(len(b["code"].splitlines()) for b in resp_info["code_blocks"])

            req_list.append({
                "id": f"q{req_idx:02d}",
                "event_id": f"q{req_idx:02d}",
                "request_id": req_id,
                "conversation_id": conv_id,
                "t": t_rel,
                "t_end": resp_info["t_end"] if resp_info else t_rel,
                "ts_abs": ts_abs,
                "t_response_end": resp_info["t_end"] if resp_info else t_rel,
                "prompt": pure_prompt or user_msg,
                "full_prompt": user_msg,
                "label": label,
                "flag_error": flag_error,
                "prompt_error_signature": prompt_error_signature,
                "matches_run": matches_run,
                "flag_task": flag_task,
                "flag_own_code": flag_own_code,
                "has_code_response": has_code_resp,
                "response_has_code": has_code_resp,
                "response_code_lines": resp_code_lines,
                "response_rejected": bool(resp_info.get("rejected", False)) if resp_info else False,
                "cancelled": bool(resp_info.get("cancelled", False)) if resp_info else False,
                "rule": "TH7",
                "rule_version": "3.0",
                "sources": [req_id],
            })

        req_list.sort(key=lambda x: x["t"])

        # Group conversations by conversation_id and determine final_label (Spec 02 TH7)
        cv_map: Dict[str, List[Dict[str, Any]]] = {}
        for q in req_list:
            cv_map.setdefault(q["conversation_id"], []).append(q)

        conversations_by_label = {"I": 0, "M": 0, "E": 0, "unknown": 0}
        for cv_id, q_group in cv_map.items():
            final_lbl = q_group[-1]["label"] if q_group else "unknown"
            if final_lbl not in ("I", "M", "E"):
                final_lbl = "unknown"
            conversations_by_label[final_lbl] = conversations_by_label.get(final_lbl, 0) + 1

        # Chuỗi yêu cầu kèm lỗi: >= 3 yêu cầu liên tiếp có flag_error = true (Spec 02 TH7)
        request_error_chains = []
        min_chain_reqs = self.params.get("chains.request_error_min", 3)
        cur_req_streak: List[Dict[str, Any]] = []

        for q in req_list:
            if q["flag_error"]:
                cur_req_streak.append(q)
            else:
                if len(cur_req_streak) >= min_chain_reqs:
                    request_error_chains.append({
                        "start_t": cur_req_streak[0]["t"],
                        "end_t": cur_req_streak[-1]["t"],
                        "n_requests": len(cur_req_streak),
                        "request_ids": [x["request_id"] for x in cur_req_streak],
                    })
                cur_req_streak = []

        if len(cur_req_streak) >= min_chain_reqs:
            request_error_chains.append({
                "start_t": cur_req_streak[0]["t"],
                "end_t": cur_req_streak[-1]["t"],
                "n_requests": len(cur_req_streak),
                "request_ids": [x["request_id"] for x in cur_req_streak],
            })

        self.signals["requests"] = req_list
        self.signals["ai_responses"] = sorted(list(resp_by_req.values()), key=lambda x: x["t_end"])
        self.signals["conversations_by_label"] = conversations_by_label
        self.signals["request_error_chains"] = request_error_chains

    # =========================================================================
    # TH4: Edit Origin & AI Response Matching + Groups (Spec 02 TH4, Version 3.0)
    # =========================================================================
    def _analyze_th4_ai_linkage(self):
        ai_responses = self.signals.get("ai_responses", [])
        starter_norm = "\n".join(normalize_code(c) for c in self.data.task_config.get("starter_files", {}).values())
        statement_norms = [normalize_code(p) for p in self.data.task_config.get("statement_paragraphs", [])]
        big_paste_min = self.params.get("match.big_paste_chars", 20)
        close_ratio = self.params.get("match.close_ratio", 0.90)
        close_cont = self.params.get("match.close_containment", 0.90)
        partial_cont = self.params.get("match.partial_containment", 0.50)
        max_prod = self.params.get("match.max_pair_product", 400000000)

        insertions = []
        rank_map = {"verbatim": 3, "close": 2, "partial": 1, "none": 0}

        by_id = {e["id"]: e for e in self.data.edits}
        for ed in self.data.edits:
            b_head = ed.get("burst_head")
            if b_head:
                h = by_id.get(b_head)
                if h and h.get("whitespace_only"):
                    ed["whitespace_only"] = True

        for ed in self.data.edits:
            if ed.get("cancelled") or ed.get("origin") == "resync":
                continue
            # Đợt do chương trình xét một lần ở chunk đầu đợt, trên phần file đã đổi (A4)
            if ed.get("burst_head") not in (None, ed["id"]):
                continue
            ins_txt = ed.get("burst_text") or ed.get("inserted", "")
            if not ins_txt:
                continue

            orig = ed.get("origin", "typed")
            # Bước 1: nhãn nguồn (chỉ từ điều log ghi, Spec 02 TH4)
            if orig in ("ai_insert", "ai_agent"):
                src = orig
            elif orig == "ai_autocomplete":
                src = "ai_autocomplete"
            elif orig == "paste":
                ps = ed.get("paste_source") or "unknown"
                src = f"paste_{ps}"
            elif (orig in ("programmatic", "unknown") and len(ins_txt) > 1 and not ins_txt.isspace()
                  and not ed.get("whitespace_only")):
                src = "unknown_source"  # log không ghi nguồn; KHÔNG coi là AI (QĐ25)
            else:
                src = orig

            norm_x = normalize_code(ins_txt)
            # Check if from_task (starter code or task statement, Spec 02 TH4)
            if not ed.get("whitespace_only") and src not in ("typed", "undo", "redo") and len(norm_x) >= big_paste_min:
                if starter_norm and norm_x in starter_norm:
                    src = "from_task"
                elif any(norm_x in sp_n for sp_n in statement_norms if sp_n):
                    src = "from_task"

            ed["src"] = src
            ed["match"] = {"level": "none", "score": 0.0, "request_id": None, "block_index": None, "response_t_end": None}

            # Bước 2: so với câu trả lời AI (Spec 02 TH4)
            if not ed.get("whitespace_only") and src not in ("typed", "undo", "redo", "from_task") and len(ins_txt.strip()) >= big_paste_min and norm_x:
                best_cand = None
                for resp in ai_responses:
                    # Câu trả lời bị hủy chỉ được tính khi edit_detected nối thay đổi với chính yêu cầu đó (B9)
                    if resp.get("cancelled") and resp["request_id"] != ed.get("ai_request_id"):
                        continue
                    if resp["t_end"] <= ed["t"] + 5000:
                        for b_idx, norm_b in enumerate(resp.get("norm_blocks", [])):
                            if not norm_b:
                                continue
                            level = "none"
                            score = 0.0
                            if norm_x in norm_b:
                                level = "verbatim"
                                score = 1.0
                            else:
                                r, c = calculate_overlap_ratio_and_containment(norm_x, norm_b, max_prod)
                                if r >= close_ratio or c >= close_cont:
                                    level = "close"
                                    score = max(r, c)
                                elif c >= partial_cont:
                                    level = "partial"
                                    score = c
                            if level != "none":
                                cand = (rank_map[level], score, resp["t_end"], resp["request_id"], b_idx)
                                if best_cand is None or cand > best_cand:
                                    best_cand = cand

                if best_cand is None and ed.get("ai_request_id"):
                    linked_r = next((r for r in ai_responses if r["request_id"] == ed["ai_request_id"]), None)
                    best_cand = (2, 0.95, linked_r["t_end"] if linked_r else ed["t"], ed["ai_request_id"], 0)

                if best_cand is not None:
                    rk, sc, r_tend, r_id, b_i = best_cand
                    lvl_str = {3: "verbatim", 2: "close", 1: "partial"}.get(rk, "none")
                    ed["match"] = {
                        "level": lvl_str,
                        "score": round(sc, 4),
                        "request_id": r_id,
                        "block_index": b_i,
                        "response_t_end": r_tend,
                    }

            # Bước 3: nhóm (group(e), Spec 02 TH4)
            if not ed.get("whitespace_only") and (src in ("ai_insert", "ai_agent", "ai_autocomplete", "paste_chat") or ed["match"]["level"] in ("verbatim", "close")):
                group = "ai"
            elif src == "unknown_source" and ed["match"]["level"] not in ("verbatim", "close"):
                group = "unknown"
            else:
                group = "other"

            ed["group"] = group

            if not ed.get("whitespace_only") and src not in ("typed", "undo", "redo", "from_task"):
                insertions.append({
                    "edit_id": ed["id"],
                    "t": ed["t"],
                    "ts_abs": ed.get("ts_abs", self.data.start_ts + ed["t"]),
                    "file": ed["file"],
                    "src": src,
                    "group": group,
                    "chars": ed.get("burst_chars", len(ins_txt)),
                    "lines": ed.get("burst_lines", len(ins_txt.splitlines())),
                    "text": ins_txt,
                    "norm_text": norm_x,
                    "match": ed["match"],
                    "rule": "TH4",
                    "rule_version": "3.0",
                    "sources": [ed["id"]],
                })

                # Update lineage metadata in provenance
                l_meta = self.data.provenance.get("lineages", {}).get(ed["id"])
                if l_meta:
                    l_meta["src"] = src
                    l_meta["group"] = group
                    l_meta["match"] = ed["match"]
                    if ed["match"]["request_id"]:
                        l_meta["ai_ref"] = {"request_id": ed["match"]["request_id"], "block_index": ed["match"]["block_index"]}
            elif ed.get("whitespace_only"):
                l_meta = self.data.provenance.get("lineages", {}).get(ed["id"])
                if l_meta:
                    l_meta["src"] = src
                    l_meta["group"] = group
                    l_meta["match"] = ed["match"]

        # Chunk còn lại của đợt nhận nguồn của chunk đầu đợt
        by_id = {e["id"]: e for e in self.data.edits}
        for ed in self.data.edits:
            head = by_id.get(ed.get("burst_head"))
            if head is not None and head is not ed:
                ed["src"] = head.get("src", "unknown_source")
                ed["group"] = head.get("group", "unknown")
                ed["match"] = head.get("match")
                if head.get("whitespace_only"):
                    ed["whitespace_only"] = True

        # Step 3 (Spec 01 Section 3.3c): Detect Repaste Families within provenance.repaste_window_ms (5 min)
        repaste_window = self.params.get("provenance.repaste_window_ms", 300000)
        retained_min = self.params.get("aicode.retained_min_chars", 40)
        repaste_families: Dict[str, Dict[str, Any]] = {}

        for i, ins in enumerate(insertions):
            for j in range(i - 1, -1, -1):
                prev_ins = insertions[j]
                if prev_ins["file"] != ins["file"]:
                    continue
                prev_lid = prev_ins["edit_id"]
                alive_at_ins = self.data.alive_chars_at(prev_lid, ins["t"])
                if alive_at_ins < retained_min:
                    # Find when prev_lid dropped
                    l_meta = self.data.provenance.get("lineages", {}).get(prev_lid, {})
                    del_times = l_meta.get("deletion_times", [])
                    t_drop = del_times[-1] if del_times else prev_ins["t"]
                    if 0 <= ins["t"] - t_drop <= repaste_window:
                        r_sim, _ = calculate_overlap_ratio_and_containment(prev_ins["norm_text"], ins["norm_text"], max_prod)
                        if r_sim >= close_ratio:
                            root_id = prev_ins.get("repaste_of") or prev_lid
                            ins["repaste_of"] = root_id
                            if root_id not in repaste_families:
                                repaste_families[root_id] = {
                                    "root": root_id,
                                    "members": [root_id],
                                    "t_first_insert": prev_ins["t"],
                                    "t_last_insert": ins["t"],
                                }
                            repaste_families[root_id]["members"].append(ins["edit_id"])
                            repaste_families[root_id]["t_last_insert"] = ins["t"]
                            break

        self.data.provenance["repaste_families"] = list(repaste_families.values())
        if "undo" in self.data.dq_report:
            self.data.dq_report["undo"]["repaste_families"] = len(repaste_families)

        self.signals["insertions"] = insertions
        self.signals["matched_chunks"] = [ins for ins in insertions if ins["match"]["level"] in ("verbatim", "close")]

    # =========================================================================
    # TH5 & TH11: Fate of AI Code & Verification Audit Profile D1-D5 (Spec 02 TH5, TH11)
    # =========================================================================
    def _analyze_th5_and_th11_ai_fate(self):
        insertions = self.signals.get("insertions", [])
        # Lần chạy dựng từ terminal chụp (A17) chỉ có cận trên của mốc, nên không dùng cho quan hệ trước sau với lần thêm code
        runs = [r for r in self.signals.get("runs", []) if r.get("t_source") != "capture"]
        requests = self.signals.get("requests", [])
        req_by_id = {q["request_id"]: q for q in requests}
        min_span_chars = self.params.get("provenance.min_span_chars", 40)
        retained_min_chars = self.params.get("aicode.retained_min_chars", 40)
        overlap_min_lines = self.params.get("aicode.prompt_overlap_lines", 3)
        classifier_enabled = self.params.get("classifier.enabled", True)
        end_rel = max(self.data.end_ts - self.data.start_ts, 0)

        # Group insertions by repaste family (if any), tracking only the final member per family
        repaste_map = {f["root"]: f for f in self.data.provenance.get("repaste_families", [])}
        non_final_members = set()
        for fam in repaste_map.values():
            for m_id in fam["members"][:-1]:
                non_final_members.add(m_id)

        ai_src_set = {"ai_insert", "ai_agent", "ai_autocomplete", "paste_chat", "inferred_ai"}
        ai_spans = []
        ai_chunks = []
        ai_chunks_discarded = []

        # Collect qualified candidate insertions (original_chars >= 40)
        qualified_ins = []
        for ins in insertions:
            if ins["edit_id"] in non_final_members:
                continue
            if ins["chars"] < min_span_chars:
                continue
            is_ai = (ins["src"] in ai_src_set) or (ins["match"]["level"] in ("verbatim", "close"))
            is_ext_paste = ins["src"] in ("paste_external", "paste_unknown") and not is_ai
            if is_ai or is_ext_paste:
                qualified_ins.append((ins, is_ai))

        # Extract AI insertion times for D2 boundary check
        ai_insert_times = sorted([ins["t"] for ins, is_ai in qualified_ins if is_ai])

        for idx, (ins, is_ai) in enumerate(qualified_ins):
            lid = ins["edit_id"]
            root_id = ins.get("repaste_of") or lid
            fam = repaste_map.get(root_id)
            member_ids = fam["members"] if fam else [lid]
            root_ins = next((x for x in insertions if x["edit_id"] == root_id), ins) if fam else ins
            t_first_insert = fam["t_first_insert"] if fam else ins["t"]
            repasted_at = [m_t for m_t in [next((x["t"] for x in insertions if x["edit_id"] == mid), ins["t"]) for mid in member_ids[1:]]] if fam else []

            orig_chars = ins["chars"]
            l_meta = self.data.provenance.get("lineages", {}).get(lid, {})

            # First run after t_first_insert
            first_run = next((r for r in runs if r["t"] > t_first_insert), None)
            if first_run:
                alive_r1 = self.data.alive_chars_at(lid, first_run["t"])
                s_first_run = round(min(alive_r1 / orig_chars, 1.0), 4)
            else:
                s_first_run = None

            alive_end = self.data.alive_chars_at(lid, end_rel)
            s_end = round(min(alive_end / orig_chars, 1.0), 4)

            # Check modifications touching any member of this lineage family
            del_times = []
            int_times = []
            for mid in member_ids:
                m_meta = self.data.provenance.get("lineages", {}).get(mid, {})
                del_times.extend(m_meta.get("deletion_times", []))
                int_times.extend(m_meta.get("interior_inserts", []))

            # Filter out edits that were cancelled
            active_edit_times = {e["t"] for e in self.data.edits if not e.get("cancelled")}
            del_times = [t for t in del_times if t in active_edit_times]
            int_times = [t for t in int_times if t in active_edit_times]

            # D1: modified_before_first_run
            mod_before_r1 = False
            if first_run:
                if any(t_first_insert < t <= first_run["t"] for t in del_times + int_times):
                    mod_before_r1 = True

            # Fate (Spec 02 TH5)
            if s_end == 1.0 and len(int_times) == 0:
                fate = "intact"
            elif alive_end == 0:
                fate = "discarded"
            else:
                fate = "partial"

            span_record = {
                "lineage": lid,
                "edit_id": lid,
                "t_insert": t_first_insert,
                "chars": orig_chars,
                "lines": ins["lines"],
                "file": ins["file"],
                "src": ins["src"],
                "match_level": ins["match"]["level"],
                "ai_ref": ins["match"].get("request_id"),
                "s_first_run": s_first_run,
                "s_end": s_end,
                "modified_before_first_run": mod_before_r1,
                "fate": fate,
                "is_ai": is_ai,
                "rule": "TH5",
                "rule_version": "1.0",
                "sources": member_ids,
            }
            ai_spans.append(span_record)

            if not is_ai:
                continue

            # TH11: Audit profile for AI chunks
            retained = alive_end >= retained_min_chars
            nxt_ai_t = next((t for t in ai_insert_times if t > t_first_insert), None)

            # D2: Run after receiving (Spec 02 TH11, Version 3.0: lần chạy đầu tiên sau lần chèn)
            d2 = None
            if first_run:
                d2 = {
                    "t": first_run["t"],
                    "minute": minute_label(first_run["t"]),
                    "time_to_run_s": max((first_run["t"] - t_first_insert) // 1000, 0),
                    "outcome": first_run["outcome"],
                    "run_id": first_run["id"],
                }

            # D3: View events overlapping chunk lines (Spec 02 TH11)
            if self.data.views:
                t_r1_bound = first_run["t"] if first_run else end_rel
                v_before = sum(
                    1 for v in self.data.views
                    if v["file"] == ins["file"] and t_first_insert < v["t"] <= t_r1_bound
                )
                v_until_end = sum(
                    1 for v in self.data.views
                    if v["file"] == ins["file"] and t_first_insert < v["t"] <= end_rel
                )
                d3 = {"before_first_run": v_before, "until_end": v_until_end}
            else:
                d3 = {"missing_reason": "no_view_events"}

            # D4: Subsequent AI requests containing >= 3 consecutive lines of chunk (Spec 02 TH11)
            d4 = []
            chunk_norm_lines = [l.strip() for l in normalize_code(ins["text"]).splitlines() if len(l.strip()) >= 8]
            if len(chunk_norm_lines) >= overlap_min_lines:
                for q in requests:
                    if q["t"] <= t_first_insert:
                        continue
                    q_norm = normalize_code(q["prompt"])
                    has_consec = False
                    for li in range(len(chunk_norm_lines) - overlap_min_lines + 1):
                        win = chunk_norm_lines[li:li + overlap_min_lines]
                        if all(w in q_norm for w in win):
                            has_consec = True
                            break
                    if has_consec:
                        d4.append({
                            "request_id": q["request_id"],
                            "t": q["t"],
                            "minute": minute_label(q["t"]),
                        })

            # D5: Subsequent edits touching the chunk after first_run
            d5_list = []
            t_after_bound = first_run["t"] if first_run else t_first_insert
            later_touch_times = sorted(set(t for t in (del_times + int_times) if t > t_after_bound))
            for lt in later_touch_times:
                ed_obj = next((e for e in self.data.edits if e["t"] == lt and not e.get("cancelled")), None)
                if not ed_obj:
                    continue
                prior_r = [r for r in runs if r["t_end"] <= lt]
                after_fail = bool(prior_r and prior_r[-1]["outcome"] in ("error", "test_fail"))
                fail_kind = prior_r[-1]["outcome"] if after_fail else None
                d5_list.append({
                    "edit_id": ed_obj["id"],
                    "t": lt,
                    "minute": minute_label(lt),
                    "src": ed_obj.get("src", "typed"),
                    "lines": max(len(ed_obj.get("inserted", "").splitlines()), 1),
                    "after_fail": after_fail,
                    "fail_outcome": fail_kind,
                    "after_outcome": fail_kind,
                })

            # Compute lines_end and function names in final file
            lines_end, funcs = self._compute_final_lines_and_funcs(ins["file"], lid, ins["text"], ins["lines"], s_end)

            req_id = root_ins["match"].get("request_id") or ins["match"].get("request_id")
            src_req = req_by_id.get(req_id) if req_id else None
            resp_t_end_val = root_ins["match"].get("response_t_end") or (src_req["t_response_end"] if src_req else t_first_insert)
            if resp_t_end_val > t_first_insert:
                resp_t_end_val = t_first_insert

            chunk_obj = {
                "id": lid,
                "chunk_id": f"chunk_{len(ai_chunks) + 1:02d}",
                "lineage": lid,
                "retained": retained,
                "t_insert": t_first_insert,
                "orig_minute": minute_label(t_first_insert),
                "repasted_at": repasted_at,
                "repaste_minutes": [minute_label(rt) for rt in repasted_at],
                "request_id": req_id,
                "request_t": src_req["t"] if src_req else None,
                "response_t_end": resp_t_end_val,
                "request_code": (src_req.get("label") or src_req.get("code")) if src_req else None,
                "request_category_name": (FVSCODE_LABELS.get(src_req.get("label"), src_req.get("category_name"))) if src_req else None,
                "request_flags": {
                    "flag_error": src_req["flag_error"] if src_req else False,
                    "flag_task": src_req["flag_task"] if src_req else False,
                    "flag_own_code": src_req["flag_own_code"] if src_req else False,
                },
                "src": ins["src"],
                "match_level": ins["match"]["level"],
                "file": ins["file"],
                "chars": orig_chars,
                "lines": ins["lines"],
                "lines_end": lines_end,
                "funcs": funcs,
                "a_end": alive_end,
                "s_end": s_end,
                "fate": fate,
                "D1": mod_before_r1,
                "D1_lines": 1 if mod_before_r1 else 0,
                "D2": d2,
                "D3": d3,
                "D4": d4,
                "D5": d5_list,
                "rule": "TH11",
                "rule_version": "1.0",
                "sources": member_ids,
            }
            if retained:
                ai_chunks.append(chunk_obj)
            else:
                t_drop = del_times[-1] if del_times else (t_first_insert + 60000)
                before_ev = self._find_event_before_drop(t_drop, runs, requests)
                drop_reason_map = {
                    "run_error": "after_error",
                    "run_test_fail": "after_test_fail",
                    "ai_request": "after_new_ai",
                }
                ai_chunks_discarded.append({
                    "id": lid,
                    "lineage": lid,
                    "file": ins["file"],
                    "t_insert": t_first_insert,
                    "minute_insert": minute_label(t_first_insert),
                    "lines": ins["lines"],
                    "t_drop": t_drop,
                    "minute_drop": minute_label(t_drop),
                    "before": before_ev,
                    "drop_reason": drop_reason_map.get(before_ev),
                    "rule": "TH11",
                    "rule_version": "1.0",
                    "sources": member_ids,
                })

        # Compute ai_char_share_final across final files (excluding starter code)
        ai_lineages = {c["lineage"] for c in ai_chunks if c.get("retained")}
        total_non_starter_chars = 0
        total_ai_final_chars = 0
        for f_rel, spans in self.data.final_spans.items():
            for sp in spans:
                if sp.origin not in ("starter", "resync") and sp.lineage not in ("starter", "resync"):
                    total_non_starter_chars += sp.length
                    if sp.lineage in ai_lineages or sp.origin in ("ai_insert", "ai_agent", "ai_autocomplete"):
                        total_ai_final_chars += sp.length
        ai_char_share_final = round(total_ai_final_chars / total_non_starter_chars, 4) if total_non_starter_chars > 0 else 0.0

        self.signals["ai_spans"] = ai_spans
        self.signals["ai_chunks"] = ai_chunks
        self.signals["ai_chunks_discarded"] = ai_chunks_discarded
        self.signals["ai_char_share_final"] = ai_char_share_final
        self.signals["n_cancelled_pairs"] = self.data.dq_report.get("undo", {}).get("cancelled_pairs", 0)
        self.signals["n_repaste_families"] = len(repaste_map)

    def _compute_final_lines_and_funcs(self, rel_file: str, lineage: str, orig_text: str,
                                       orig_lines: int, s_end: float) -> Tuple[int, List[str]]:
        """Counts lines in final file containing characters from lineage and extracts function names."""
        final_txt = self.data.final_files.get(rel_file, "")
        spans = self.data.final_spans.get(rel_file, [])
        if not final_txt or not spans:
            est_lines = max(int(round(orig_lines * s_end)), 1) if s_end > 0 else 0
            funcs = re.findall(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", orig_text, re.MULTILINE)
            return est_lines, funcs

        # Map character positions belonging to lineage
        char_belongs = bytearray(len(final_txt))
        pos = 0
        for sp in spans:
            if sp.lineage == lineage:
                end_p = min(pos + sp.length, len(final_txt))
                for k in range(pos, end_p):
                    char_belongs[k] = 1
            pos += sp.length

        lines_with_lineage = 0
        funcs = []
        cur_pos = 0
        for line in final_txt.splitlines(keepends=True):
            l_len = len(line)
            if any(char_belongs[cur_pos:cur_pos + l_len]):
                lines_with_lineage += 1
                m_fn = re.match(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", line)
                if m_fn:
                    funcs.append(m_fn.group(1))
            cur_pos += l_len

        if lines_with_lineage == 0 and s_end > 0:
            lines_with_lineage = max(int(round(orig_lines * s_end)), 1)
        if not funcs:
            funcs = re.findall(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", orig_text, re.MULTILINE)
        return lines_with_lineage, funcs

    def _find_event_before_drop(self, t_drop: int, runs: List[Dict[str, Any]], requests: List[Dict[str, Any]]) -> str:
        """Determines what happened immediately before an AI chunk was discarded (Spec 02 TH11)."""
        candidates = []
        for r in runs:
            if r["t_end"] <= t_drop:
                if r["outcome"] == "error":
                    candidates.append((r["t_end"], "run_error"))
                elif r["outcome"] == "test_fail":
                    candidates.append((r["t_end"], "run_test_fail"))
        for q in requests:
            if q["t"] <= t_drop:
                candidates.append((q["t"], "ai_request"))
        if not candidates:
            return "other"
        candidates.sort(key=lambda x: x[0])
        last_t, kind = candidates[-1]
        if t_drop - last_t <= 180000:
            return kind
        return "other"

    # =========================================================================
    # TH6: Behavior Around Receiving AI Code & State Transitions (Spec 02 TH6)
    # =========================================================================
    def _analyze_th6_uptake(self):
        responses = self.signals.get("ai_responses", [])
        insertions = self.signals.get("insertions", [])
        # Lần chạy dựng từ terminal chụp (A17) chỉ có cận trên của mốc, nên không dùng cho quan hệ trước sau với lần thêm code
        runs = [r for r in self.signals.get("runs", []) if r.get("t_source") != "capture"]
        spans_by_id = {s["edit_id"]: s for s in self.signals.get("ai_spans", [])}
        uptakes = []

        for r in responses:
            if not r.get("code_blocks"):
                continue
            rid = r["request_id"]
            first_ins = next(
                (ins for ins in insertions
                 if ins["match"].get("request_id") == rid and ins["match"].get("level") in ("verbatim", "close")),
                None
            )
            if first_ins is None:
                uptakes.append({
                    "request_id": rid,
                    "response_t_end": r["t_end"],
                    "inserted": False,
                    "rule": "TH6",
                    "rule_version": "1.0",
                    "sources": [rid],
                })
                continue

            wait_ms = max(first_ins["t"] - r["t_end"], 0)
            nr = next((run for run in runs if run["t"] > first_ins["t"]), None)
            time_to_run_ms = max(nr["t"] - first_ins["t"], 0) if nr else None
            run_outcome = nr["outcome"] if nr else None
            sp = spans_by_id.get(first_ins["edit_id"])
            mod_before = sp["modified_before_first_run"] if sp else False

            uptakes.append({
                "request_id": rid,
                "edit_id": first_ins["edit_id"],
                "t_insert": first_ins["t"],
                "response_t_end": r["t_end"],
                "inserted": True,
                "wait_before_insert_ms": wait_ms,
                "wait_before_insert_s": wait_ms // 1000,
                "time_to_run_ms": time_to_run_ms,
                "time_to_run_s": (time_to_run_ms // 1000) if time_to_run_ms is not None else None,
                "run_id": nr["id"] if nr else None,
                "run_t_end": nr["t_end"] if nr else None,
                "run_outcome": run_outcome,
                "modified_before_run": mod_before,
                "rule": "TH6",
                "rule_version": "1.0",
                "sources": [rid, first_ins["edit_id"]],
            })

        # Compute WC / VC / VR / VT state transitions if focus/view events exist (Qiao et al.)
        state_seq = []
        for e in self.data.edits:
            if e.get("origin") == "typed" and not e.get("cancelled"):
                state_seq.append((e["t"], "WC"))
        for v in self.data.views:
            state_seq.append((v["t"], "VC"))
        for f in self.data.focus_events:
            tgt = f.get("target")
            if tgt == "chat_panel":
                state_seq.append((f["t"], "VR"))
            elif tgt == "task_panel":
                state_seq.append((f["t"], "VT"))

        transitions = None
        if len(state_seq) >= 2:
            state_seq.sort(key=lambda x: x[0])
            collapsed = [state_seq[0][1]]
            for _, st in state_seq[1:]:
                if st != collapsed[-1]:
                    collapsed.append(st)
            counts: Dict[Tuple[str, str], int] = {}
            out_totals: Dict[str, int] = {}
            for i in range(len(collapsed) - 1):
                a_st, b_st = collapsed[i], collapsed[i + 1]
                counts[(a_st, b_st)] = counts.get((a_st, b_st), 0) + 1
                out_totals[a_st] = out_totals.get(a_st, 0) + 1

            def prob(a_st: str, b_st: str) -> float:
                tot = out_totals.get(a_st, 0)
                return round(counts.get((a_st, b_st), 0) / tot, 3) if tot > 0 else 0.0

            transitions = {
                "P_WC_to_VC": prob("WC", "VC"),
                "P_VC_to_WC": prob("VC", "WC"),
                "P_VT_to_WC": prob("VT", "WC"),
            }

        self.signals["uptakes"] = uptakes
        self.signals["transitions"] = transitions

    # =========================================================================
    # TH8: Prompt Context (start, after_clear, after_ai, after_own_code, has_solution) (Spec 02 TH8)
    # =========================================================================
    def _analyze_th8_context(self):
        requests = self.signals.get("requests", [])
        # Lần chạy dựng từ terminal chụp (A17) chỉ có cận trên của mốc, nên không dùng cho quan hệ trước sau với lần thêm code
        runs = [r for r in self.signals.get("runs", []) if r.get("t_source") != "capture"]
        insertions = self.signals.get("insertions", [])
        base_chars = self.params.get("prompt.context_typed_chars", 20)
        starter_files = self.data.task_config.get("starter_files", {})
        starter_total_len = sum(len(norm_ws(v)) for v in starter_files.values())

        def typed_since(t_a: int, t_b: int) -> int:
            return sum(
                len(e.get("inserted", ""))
                for e in self.data.edits
                if t_a < e["t"] <= t_b and e.get("origin") == "typed" and not e.get("cancelled")
            )

        ai_events = []
        for q in requests:
            ai_events.append((q["t"], "req", q["request_id"]))
        for ins in insertions:
            if ins["match"]["level"] in ("verbatim", "close") or ins["src"] in ("ai_insert", "ai_agent", "paste_chat"):
                ai_events.append((ins["t"], "ins", ins["edit_id"]))
        ai_events.sort(key=lambda x: x[0])

        # Bối cảnh 2 xét từng file: file từng dài hơn code khởi đầu của nó, nay quay về code khởi đầu hoặc rỗng,
        # với dung sai base_chars ký tự. "Từng dài hơn" xét từ lần dùng AI gần nhất trước yêu cầu (hoặc từ đầu buổi),
        # để một file đã trả về code khởi đầu từ lâu không làm mọi yêu cầu về sau thành "sau khi xóa trắng".
        starter_norm = {f: norm_ws(c) for f, c in starter_files.items()}
        # Độ dài (đã gộp khoảng trắng) của từng file mỗi lần đổi, dựng một lần
        len_timeline: Dict[str, List[Tuple[int, int]]] = {}
        prev_txt: Dict[str, str] = {}
        for snap_t, state_map, _ in (getattr(self.data, "state_snapshots", None) or []):
            for f, txt in state_map.items():
                if prev_txt.get(f) is txt:
                    continue
                prev_txt[f] = txt
                len_timeline.setdefault(f, []).append((snap_t, len(norm_ws(txt))))

        def max_len_between(f: str, t_from: Optional[int], t_to: int) -> int:
            """Độ dài lớn nhất của file f trong (t_from, t_to], kể cả độ dài đang có ngay tại t_from."""
            if t_from is None:
                best = len(starter_norm.get(f, ""))
            else:
                best = 0
                for snap_t, n in len_timeline.get(f, []):
                    if snap_t > t_from:
                        break
                    best = n
                if not len_timeline.get(f) or len_timeline[f][0][0] > t_from:
                    best = len(starter_norm.get(f, ""))
            for snap_t, n in len_timeline.get(f, []):
                if snap_t > t_to:
                    break
                if t_from is None or snap_t > t_from:
                    best = max(best, n)
            return best

        def back_to_start(cur: str, start: str) -> bool:
            if len(cur) <= base_chars:
                return True
            if abs(len(cur) - len(start)) > base_chars:
                return False
            matched = sum(b.size for b in difflib.SequenceMatcher(None, cur, start, autojunk=False).get_matching_blocks())
            return max(len(cur), len(start)) - matched <= base_chars

        def cleared_file(t: int, since: Optional[int], cur_state: Dict[str, str]) -> bool:
            for f, txt in cur_state.items():
                cur, start = norm_ws(txt), starter_norm.get(f, "")
                if max_len_between(f, since, t) > len(start) + base_chars and back_to_start(cur, start):
                    return True
            return False

        for q in requests:
            t = q["t"]
            cur_state = self.data.state_at(t)

            prior_runs = [r for r in runs if r["t_end"] <= t]
            last_run = prior_runs[-1] if prior_runs else None
            prior_test_runs = [r for r in prior_runs if r["kind"] == "test" and r.get("tests") is not None]
            last_test_run = prior_test_runs[-1] if prior_test_runs else None

            prior_ai = [ae for ae in ai_events if ae[0] < t]
            prev_ai_t = prior_ai[-1][0] if prior_ai else None

            # Xét theo đúng thứ tự của Mục 6.1, TH8: qua mọi test, xóa trắng, từ đầu, sau khi dùng AI, sau khi tự viết
            if last_test_run and not last_test_run["tests"].get("failed") and last_test_run["tests"].get("passed"):
                context = "after_all_pass"
            elif cleared_file(t, prev_ai_t, cur_state):
                context = "after_clear"
            elif prev_ai_t is None and typed_since(0, t) <= base_chars:
                context = "start"
            elif prev_ai_t is not None and typed_since(prev_ai_t, t) <= base_chars:
                context = "after_ai"
            else:
                context = "after_own_code"

            after_error = bool(
                last_run
                and last_run["outcome"] in ("error", "test_fail")
                and typed_since(last_run["t_end"], t) <= base_chars
            )

            q["context"] = context
            q["after_error"] = after_error

    # =========================================================================
    # TH9: Reactions After AI Code Fails & Chains (Spec 02 TH9, Version 3.0)
    # =========================================================================
    def _analyze_th9_reactions(self):
        uptakes = self.signals.get("uptakes", [])
        # Lần chạy dựng từ terminal chụp (A17) chỉ có cận trên của mốc, nên không dùng cho quan hệ trước sau với lần thêm code
        runs = [r for r in self.signals.get("runs", []) if r.get("t_source") != "capture"]
        requests = self.signals.get("requests", [])
        repaste_roots = {f["root"] for f in self.data.provenance.get("repaste_families", [])}
        chain_min_cycles = self.params.get("ai.chain_min_cycles", 2)

        ai_failures = []
        for u in uptakes:
            if not u.get("inserted") or u.get("run_outcome") not in ("error", "test_fail"):
                continue
            t_after_run = u.get("run_t_end") or u.get("t_insert", 0)
            lid = u.get("edit_id")

            # Find earliest next action among {typed edit, ai_request, run} after t_after_run (Spec 02 TH9)
            next_candidates = []
            for e in self.data.edits:
                if e["t"] > t_after_run and e.get("origin") == "typed" and not e.get("cancelled") and e.get("inserted"):
                    next_candidates.append((e["t"], "self_edit", e["id"]))
                    break
            for q in requests:
                if q["t"] > t_after_run:
                    next_candidates.append((q["t"], "new_request", q["request_id"]))
                    break
            for r in runs:
                if r["t"] > t_after_run:
                    next_candidates.append((r["t"], "rerun_no_change", r["id"]))
                    break

            next_candidates.sort(key=lambda x: x[0])
            nxt_t, nxt_action, nxt_id = next_candidates[0] if next_candidates else (float("inf"), "none", None)

            # Check if lineage dropped to 0 before nxt_t (Spec 02 TH9)
            l_meta = self.data.provenance.get("lineages", {}).get(lid, {})
            del_times = [dt for dt in l_meta.get("deletion_times", []) if dt > t_after_run]
            drop_t = None
            for dt in del_times:
                if self.data.alive_chars_at(lid, dt) == 0:
                    drop_t = dt
                    break

            if drop_t is not None and drop_t <= nxt_t:
                if lid in repaste_roots:
                    action = "delete_and_repaste"
                else:
                    action = "delete_ai_code"
            else:
                action = nxt_action

            if u.get("run_id"):
                r_match = next((r for r in runs if r["id"] == u["run_id"]), None)
                if r_match:
                    r_match["next_action"] = action

            ai_failures.append({
                "uptake_id": u["request_id"],
                "edit_id": lid,
                "run_id": u.get("run_id"),
                "t": t_after_run,
                "next_action": action,
                "next_request_id": nxt_id if action == "new_request" else None,
                "rule": "TH9",
                "rule_version": "3.0",
                "sources": [u["request_id"], u.get("run_id") or lid],
            })

        # Chuỗi chèn, lỗi, hỏi lại (insert_error_ask_chains): >= ai.chain_min_cycles (2) cycles (Spec 02 TH9)
        insert_error_ask_chains = []
        cur_chain = []
        for fail in ai_failures:
            if fail["next_action"] == "new_request":
                if not cur_chain:
                    cur_chain = [fail]
                else:
                    prev_fail = cur_chain[-1]
                    if fail["uptake_id"] == prev_fail.get("next_request_id") or (fail["t"] - prev_fail["t"] <= 600000):
                        cur_chain.append(fail)
                    else:
                        if len(cur_chain) >= chain_min_cycles:
                            insert_error_ask_chains.append(self._build_insert_error_ask_chain(cur_chain))
                        cur_chain = [fail]
            else:
                if len(cur_chain) >= chain_min_cycles:
                    insert_error_ask_chains.append(self._build_insert_error_ask_chain(cur_chain))
                cur_chain = []

        if len(cur_chain) >= chain_min_cycles:
            insert_error_ask_chains.append(self._build_insert_error_ask_chain(cur_chain))

        self.signals["ai_failures"] = ai_failures
        self.signals["insert_error_ask_chains"] = insert_error_ask_chains
        self.signals["fix_loops"] = insert_error_ask_chains  # for backwards compatibility

    def _build_insert_error_ask_chain(self, chain: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "start_t": chain[0]["t"],
            "end_t": chain[-1]["t"],
            "cycles": len(chain),
            "request_ids": [c["uptake_id"] for c in chain],
            "run_ids": [c["run_id"] for c in chain if c.get("run_id")],
            "rule": "TH9",
            "rule_version": "3.0",
            "sources": [c["uptake_id"] for c in chain],
        }

    # =========================================================================
    # TH10: Large Insertion Bursts Relative to Student Baseline (Spec 02 TH10, Version 3.0)
    # =========================================================================
    def _analyze_th10_bursts(self):
        gap_ms = self.params.get("burst.typed_gap_ms", 2000)
        typed_edits = [
            e for e in self.data.edits
            if e.get("origin") == "typed" and not e.get("cancelled") and e.get("inserted")
        ]
        burst_clusters: List[int] = []
        if typed_edits:
            cur_burst = len(typed_edits[0].get("inserted", ""))
            prev_t = typed_edits[0]["t"]
            for e in typed_edits[1:]:
                if e["t"] - prev_t < gap_ms:
                    cur_burst += len(e.get("inserted", ""))
                else:
                    burst_clusters.append(cur_burst)
                    cur_burst = len(e.get("inserted", ""))
                prev_t = e["t"]
            burst_clusters.append(cur_burst)

        min_events = self.params.get("burst.baseline_min_events", 20)
        if len(burst_clusters) >= min_events:
            burst_clusters.sort()
            p_idx = int((self.params.get("burst.own_percentile", 95) / 100.0) * len(burst_clusters))
            own_p95 = burst_clusters[min(p_idx, len(burst_clusters) - 1)]
        else:
            own_p95 = 0

        threshold = max(own_p95, self.params.get("burst.abs_min_chars", 100))
        bursts = []

        spans_by_id = {s["edit_id"]: s for s in self.signals.get("ai_spans", [])}
        runs = self.signals.get("runs", [])

        for ins in self.signals.get("insertions", []):
            if ins.get("repaste_of"):
                continue
            if ins["src"] in ("typed", "undo", "redo", "from_task"):
                continue
            if ins["chars"] > threshold:
                sp = spans_by_id.get(ins["edit_id"], {})
                has_run_after = any(r["t"] > ins["t"] for r in runs)
                bursts.append({
                    "id": ins["edit_id"],
                    "edit_id": ins["edit_id"],
                    "t": ins["t"],
                    "file": ins["file"],
                    "chars": ins["chars"],
                    "lines": ins["lines"],
                    "lines_end": ins["lines"],
                    "src": ins["src"],
                    "group": ins.get("group", "other"),
                    "match_level": ins["match"]["level"],
                    "request_id": ins["match"].get("request_id"),
                    "fate": sp.get("fate", "intact"),
                    "modified_before_first_run": sp.get("modified_before_first_run", False),
                    "has_run_after": has_run_after,
                    "own_p95": own_p95,
                    "threshold": threshold,
                    "rule": "TH10",
                    "rule_version": "3.0",
                    "sources": [ins["edit_id"]],
                })

        self.signals["bursts"] = bursts
        self.signals["own_p95_typed_chars"] = own_p95
        self.signals["n_typed_bursts"] = len(burst_clusters)
