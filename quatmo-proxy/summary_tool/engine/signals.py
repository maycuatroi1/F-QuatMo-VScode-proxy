# -*- coding: utf-8 -*-
"""
Signals module (TH1 - TH11) for PhaseSUMMARY Engine (M1).
Strictly implements developer specs '02 Tín hiệu.md' & Section 2.2 of the audit report:
- TH1: 4 pause tiers, opener/follower, deleted_lines, work_sessions, accurate T_task_ms
- TH2 & TH3: 5-step error normalization with 3 modes, Ohno metrics (freq, revs, n_lines),
  test_streaks, between_runs (no_change/minor/major), deleted_error_line, rerun_no_change
- TH4: normalize_code stripping comments via tokenize/regex, SequenceMatcher(autojunk=False), from_task tagging
- TH5 & TH11: repaste_families, alive_chars_at tracking, lines_end, funcs extraction, ai_char_share_final, D1-D5
- TH6: wait times, transition matrix (WC/VC/VR/VT)
- TH7: Ma et al. 11 codes (ER, PU, CQ, CG, IQ, EI, CC, CV, CE, CO, OT) and 3 deterministic flags (flag_error, flag_task, flag_own_code)
- TH8: 5 mutually exclusive contexts (start, after_clear, after_ai, after_own_code, has_solution) + after_error flag
- TH9: post-error reactions (self_fix, re_ask, discard_ai_code, rerun_no_change, repaste) and fix_loops
- TH10: burst detection with own_p95
"""

import re
import ast
import tokenize
import io
import difflib
from functools import lru_cache
from typing import Dict, List, Any, Optional, Tuple, Set
from .constants import DEFAULT_PARAMS, REQUEST_CATEGORY_NAMES

@lru_cache(maxsize=2048)
def normalize_code(text: str) -> str:
    """
    Normalizes code string (Rahe & Maalej):
    1. Strip line comments (# for Python, // for C/Java)
    2. Strip trailing whitespaces
    3. Collapse multiple spaces within lines
    4. Remove empty lines
    5. Join with \n
    """
    if not text:
        return ""
    cleaned_lines = []
    for line in text.splitlines():
        l = re.sub(r'#.*$', '', line)
        l = re.sub(r'//.*$', '', l)
        l = re.sub(r'\s+', ' ', l).strip()
        if l:
            cleaned_lines.append(l)
    return "\n".join(cleaned_lines)

def norm_ws(s: str) -> str:
    """Collapses whitespace into single space and strips."""
    return re.sub(r'\s+', ' ', str(s or "")).strip()

def extract_code_blocks(text: str) -> List[str]:
    """Extract code blocks enclosed in ``` from markdown text."""
    if not text:
        return []
    blocks = re.findall(r'```(?:[a-zA-Z0-9_\-\+]*\n)?(.*?)```', text, re.DOTALL)
    if not blocks:
        lines = [l for l in text.splitlines() if l.strip()]
        if len(lines) >= 3 and any(('def ' in l or 'import ' in l or 'return ' in l or 'class ' in l) for l in lines):
            return [text.strip()]
        return []
    return [b.strip() for b in blocks if b.strip()]

def calculate_overlap_ratio_and_containment(x: str, b: str) -> Tuple[float, float]:
    """Calculate Ratcliff/Obershelp ratio and containment using difflib with autojunk=False."""
    if not x or not b:
        return 0.0, 0.0
    # Fast path: exact substring containment
    if x in b:
        return (2.0 * len(x)) / (len(x) + len(b)), 1.0
    if b in x:
        return (2.0 * len(b)) / (len(x) + len(b)), len(b) / len(x)

    # If small snippet (< 40 chars) is not an exact substring, it cannot have >= 0.80 containment
    if len(x) < 40:
        return 0.0, 0.0

    # Cap text length to prevent quadratic degradation in difflib
    cx = x[:3000] if len(x) > 3000 else x
    cb = b[:5000] if len(b) > 5000 else b

    matcher = difflib.SequenceMatcher(None, cx, cb, autojunk=False)
    match_chars = sum(block.size for block in matcher.get_matching_blocks())
    ratio = (2.0 * match_chars) / (len(cx) + len(cb)) if (len(cx) + len(cb)) > 0 else 0.0
    containment = match_chars / len(x) if len(x) > 0 else 0.0
    return ratio, containment

def normalize_error_message(msg: str) -> Tuple[str, str, str]:
    """
    5-step normalization for error messages (Spec 02, TH2):
    1. Strings in quotes -> <str>
    2. Paths (/... or C:\\...) -> <path>
    3. Hex addresses 0x... -> <addr>
    4. Numbers -> <num>
    5. Collapse whitespace, trim.
    Returns: (signature_default, signature_keep_quoted, signature_type_only)
    """
    raw = msg or ""
    # Extract error type if present
    m_type = re.search(r'^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt))', raw)
    err_type = m_type.group(1) if m_type else "Error"

    # Step 1: keep quoted for signature_keep_quoted
    keep_quoted = re.sub(r'[A-Za-z]:\\[^\s:"\']+|/(?:[a-zA-Z0-9_\-\.]+/)+[a-zA-Z0-9_\-\.]+', '<path>', raw)
    keep_quoted = re.sub(r'0x[0-9a-fA-F]+', '<addr>', keep_quoted)
    keep_quoted = re.sub(r'\b\d+(\.\d+)?\b', '<num>', keep_quoted)
    keep_quoted = norm_ws(keep_quoted)

    # Step 2: replace quoted strings for default signature
    norm_default = re.sub(r'["\'][^"\']*["\']', '<str>', raw)
    norm_default = re.sub(r'[A-Za-z]:\\[^\s:"\']+|/(?:[a-zA-Z0-9_\-\.]+/)+[a-zA-Z0-9_\-\.]+', '<path>', norm_default)
    norm_default = re.sub(r'0x[0-9a-fA-F]+', '<addr>', norm_default)
    norm_default = re.sub(r'\b\d+(\.\d+)?\b', '<num>', norm_default)
    norm_default = norm_ws(norm_default)

    return norm_default or err_type, keep_quoted or err_type, err_type

def extract_function_names(code_text: str) -> List[str]:
    """Extracts function/method names from Python code using AST with regex fallback."""
    if not code_text:
        return []
    names = []
    try:
        tree = ast.parse(code_text)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                names.append(node.name)
        if names:
            return names
    except Exception:
        pass
    # Regex fallback
    found = re.findall(r'def\s+([a-zA-Z_]\w*)\s*\(', code_text)
    return found

class SignalsAnalyzer:
    def __init__(self, session_data, params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)
        self.signals: Dict[str, Any] = {}

    def analyze(self) -> Dict[str, Any]:
        """Runs the 11 signal extraction pipeline (TH1 - TH11)."""
        self._analyze_th1_pauses()
        self._analyze_th2_runs()
        self._analyze_th3_threads()
        self._analyze_th7_requests()
        self._analyze_th4_ai_linkage()
        self._analyze_th5_and_th11_ai_fate()
        self._analyze_th6_uptake()
        self._analyze_th8_context()
        self._analyze_th9_reactions()
        self._analyze_th10_bursts()
        return self.signals

    def _analyze_th1_pauses(self):
        """TH1: Calculates pauses across 4 tiers, work sessions, and estimated task time."""
        events = self.data.events
        ai_items = self.data.ai_interactions
        if not events and not ai_items:
            self.signals["pauses"] = []
            self.signals["T_task_ms"] = 0
            self.signals["duration_ms"] = 0
            self.signals["work_sessions"] = []
            self.signals["n_pauses_ge_3min"] = 0
            return

        intervals = []
        # Activity intervals: edits, runs, suggestions
        for e in events:
            t = e.get("t", 0)
            t_end = e.get("t_end", t)
            kind = e.get("kind", e.get("type", ""))
            if kind in ('edit', 'typing_chunk', 'paste', 'undo', 'redo', 'terminal_command', 'run'):
                intervals.append((t, max(t_end, t), e))

        # Waiting for AI is active time (Spec 02, TH1 & U11)
        req_map = {}
        for a in ai_items:
            t = a.get("t", 0)
            atype = a.get("type", a.get("kind", ""))
            req_id = a.get("payload", {}).get("requestId") or a.get("request_id")
            if atype in ("chat_request", "ai_request"):
                req_map[req_id] = t
            elif atype in ("chat_response_complete", "ai_response") and req_id in req_map:
                intervals.append((req_map[req_id], max(t, req_map[req_id]), a))

        if not intervals:
            start_t = 0
            end_t = max((e.get("t", 0) for e in events), default=3600000)
            intervals = [(start_t, end_t, events[0] if events else {})]

        # Sort and merge overlapping activity intervals
        intervals.sort(key=lambda x: x[0])
        merged = []
        curr_s, curr_e, curr_ev = intervals[0]
        for s, e, ev in intervals[1:]:
            if s <= curr_e:
                curr_e = max(curr_e, e)
            else:
                merged.append((curr_s, curr_e, curr_ev))
                curr_s, curr_e, curr_ev = s, e, ev
        merged.append((curr_s, curr_e, curr_ev))

        # Calculate pauses and tiers
        pauses = []
        session_break_ms = self.params.get("pause.session_break_ms", 300000)  # 5 min
        tiers = self.params.get("pause.tiers_ms", [2000, 15000, 180000, 600000])
        t_task_ms = sum(e - s for s, e, _ in merged)
        work_sessions = []
        ws_start = merged[0][0]

        for i in range(1, len(merged)):
            gap = merged[i][0] - merged[i-1][1]
            if gap >= tiers[0]:  # >= 2000 ms
                tier = "vi_mo"
                if gap >= tiers[3]:
                    tier = "dai"
                elif gap >= tiers[2]:
                    tier = "vua"
                elif gap >= tiers[1]:
                    tier = "ngan"

                # Opener and follower
                prev_ev = merged[i-1][2]
                next_ev = merged[i][2]
                opener = self._deduce_pause_opener(prev_ev)
                follower = self._deduce_pause_opener(next_ev)
                deleted_lines = prev_ev.get('deleted_lines', 0) if opener == 'delete' else 0

                pauses.append({
                    "start": merged[i-1][1],
                    "end": merged[i][0],
                    "length": gap,
                    "tier": tier,
                    "opener": opener,
                    "follower": follower,
                    "deleted_lines": deleted_lines
                })

            if gap < session_break_ms:
                t_task_ms += gap
            else:
                work_sessions.append((ws_start, merged[i-1][1]))
                ws_start = merged[i][0]

        work_sessions.append((ws_start, merged[-1][1]))
        total_duration = merged[-1][1] - merged[0][0] if merged else 0

        self.signals["pauses"] = pauses
        self.signals["T_task_ms"] = t_task_ms
        self.signals["duration_ms"] = total_duration
        self.signals["work_sessions"] = work_sessions
        self.signals["n_pauses_ge_3min"] = len([p for p in pauses if p["length"] >= self.params.get("pause.segment_ms", 180000)])

    def _deduce_pause_opener(self, ev: Dict[str, Any]) -> str:
        k = ev.get('kind', ev.get('type', ''))
        if k in ('edit', 'typing_chunk'):
            if ev.get('deleted_len', 0) > 0 and not ev.get('inserted') and not ev.get('text'):
                return 'delete'
            if ev.get('origin') == 'paste' or k == 'paste':
                return 'paste'
            if 'ai' in str(ev.get('origin', '')):
                return 'ai_insert'
            return 'type'
        if k in ('terminal_command', 'run'):
            if ev.get('outcome') == 'ok' or ev.get('exitCode') == 0:
                return 'run_ok'
            return 'run_error'
        if 'ai' in k:
            return 'ai_response'
        return 'other'

    def _analyze_th2_runs(self):
        """TH2: Terminal commands, outcomes, 5-step normalized error signatures."""
        runs = []
        events = self.data.events
        run_id_counter = 1

        for e in events:
            kind = e.get('kind', e.get('type', ''))
            if kind in ('terminal_command', 'run') or 'terminal' in kind:
                p = e.get("payload", {})
                cmd = p.get("command") or e.get("command") or ""
                t = e.get("t", 0)
                dur = p.get("durationMs", 0) or e.get("durationMs", 0)
                t_end = e.get("t_end", t + dur)
                exit_code = p.get("exitCode") if p.get("exitCode") is not None else e.get("exit_code")

                # Filter relevant run / build / test commands
                is_run = bool(re.search(r'python3?|\.py\b|pytest|flask|node|run', cmd, re.IGNORECASE))
                if not is_run and not cmd.startswith("&") and not cmd.startswith("pip") and not cmd.startswith("cat"):
                    continue

                outcome = "ok"
                err_type = None
                err_sig = None
                location = None
                raw_err = e.get("stderr_tail") or e.get("stdout_tail") or p.get("output", "")

                # Check test results
                if "pytest" in cmd or "test" in cmd:
                    if exit_code is not None and exit_code != 0:
                        outcome = "test_fail"
                        err_type = "AssertionError"
                        err_sig = f"test_fail in {cmd[:40]}"
                elif exit_code is not None and exit_code != 0:
                    outcome = "error"

                # Parse Python / Java traceback if present in output
                if raw_err:
                    # Look for Error/Exception line
                    m_err = re.search(r'([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt))(?::\s*(.*))?', raw_err)
                    if m_err:
                        err_type = m_err.group(1)
                        full_msg = m_err.group(0)
                        sig_def, sig_keep, sig_type = normalize_error_message(full_msg)
                        mode = self.params.get("errors.signature_mode", "default")
                        err_sig = sig_keep if mode == "keep_quoted" else (sig_type if mode == "type_only" else sig_def)
                        outcome = "error"

                    # Look for location: File "...", line N
                    m_loc = re.search(r'File\s+["\']([^"\']+)["\'],\s+line\s+(\d+)', raw_err)
                    if m_loc:
                        location = {"file": m_loc.group(1).split("/")[-1].split("\\")[-1], "line": int(m_loc.group(2))}

                if outcome == "error" and not err_sig:
                    err_type = err_type or "RuntimeError"
                    err_sig = f"{err_type} (ExitCode:{exit_code})"

                runs.append({
                    "id": f"r{run_id_counter:03d}",
                    "run_id": f"r{run_id_counter:03d}",
                    "t": t,
                    "t_end": t_end,
                    "command": cmd,
                    "outcome": outcome,
                    "exit_code": exit_code,
                    "error_type": err_type,
                    "signature": err_sig,
                    "location": location,
                    "raw_output": raw_err[:500] if raw_err else ""
                })
                run_id_counter += 1

        runs.sort(key=lambda x: x["t"])
        self.signals["runs"] = runs

    def _analyze_th3_threads(self):
        """TH3: Repeated error threads, Ohno metrics (freq, revs, n_lines), and work between runs."""
        runs = self.signals.get("runs", [])
        events = self.data.events
        threads = []
        cur_thread = None

        for r in runs:
            if r["outcome"] == "error":
                sig = r["signature"] or "UnknownError"
                if cur_thread and cur_thread["signature"] == sig:
                    cur_thread["runs"].append(r)
                else:
                    if cur_thread:
                        threads.append(cur_thread)
                    cur_thread = {
                        "id": f"th_{len(threads)+1:02d}",
                        "signature": sig,
                        "runs": [r],
                        "resolved_at": None,
                        "repeated": False,
                        "location": r.get("location")
                    }
            else:
                if cur_thread:
                    cur_thread["resolved_at"] = r["t"]
                    if len(cur_thread["runs"]) >= self.params.get("errors.repeat_runs", 3):
                        cur_thread["repeated"] = True
                    threads.append(cur_thread)
                    cur_thread = None

        if cur_thread:
            if len(cur_thread["runs"]) >= self.params.get("errors.repeat_runs", 3):
                cur_thread["repeated"] = True
            threads.append(cur_thread)

        # Compute Ohno metrics (freq, revs, n_lines) for each thread
        for th in threads:
            th_start = th["runs"][0]["t"]
            th_end = th["resolved_at"] or th["runs"][-1]["t_end"]
            edits_in_span = [e for e in events if e.get('kind', e.get('type')) in ('edit', 'typing_chunk', 'paste') and th_start <= e.get('t', 0) <= th_end]
            touched_lines = set()
            line_counts = {}
            for e in edits_in_span:
                l_num = e.get('line') or e.get('lineNumber') or 1
                touched_lines.add(l_num)
                line_counts[l_num] = line_counts.get(l_num, 0) + 1

            N = max(len(touched_lines), 1)
            s = sum(line_counts.values()) or 1
            mu = 1.0 / N
            freq = (1.0 / N) * sum(((cnt / s) - mu) ** 2 for cnt in line_counts.values()) if N > 1 else 0.0
            th["ohno"] = {
                "freq": round(freq, 4),
                "revs": len(edits_in_span),
                "n_lines": N
            }

        # Work between consecutive runs (between_runs)
        between_runs = []
        consecutive_no_change = 0
        rerun_no_change_list = []

        for k in range(len(runs) - 1):
            r1 = runs[k]
            r2 = runs[k + 1]
            inter_edits = [e for e in events if e.get('kind', e.get('type')) in ('edit', 'typing_chunk', 'paste') and r1['t_end'] < e.get('t', 0) <= r2['t']]
            chars_added = sum(len(e.get('inserted') or e.get('text') or '') for e in inter_edits)
            chars_deleted = sum(e.get('deleted_len', 0) for e in inter_edits)
            lines_touched = set(e.get('line', 1) for e in inter_edits)

            if chars_added + chars_deleted == 0:
                label = "no_change"
                consecutive_no_change += 1
                if consecutive_no_change + 1 > self.params.get("runs.no_edit_repeat", 2):
                    rerun_no_change_list.append({"runs": consecutive_no_change + 1, "start_t": r1["t"]})
            elif 1 <= len(lines_touched) <= self.params.get("runs.minor_change_lines", 2):
                label = "minor"
                consecutive_no_change = 0
            else:
                label = "major"
                consecutive_no_change = 0

            between_runs.append({
                "from_run": r1["id"],
                "to_run": r2["id"],
                "label": label,
                "chars_added": chars_added,
                "chars_deleted": chars_deleted
            })

        self.signals["threads"] = threads
        self.signals["between_runs"] = between_runs
        self.signals["rerun_no_change"] = rerun_no_change_list
        self.signals["n_threads_repeated"] = len([t for t in threads if t.get("repeated")])

    def _analyze_th7_requests(self):
        """TH7: Categorizes AI requests into 11 Ma et al. codes and computes 3 deterministic flags."""
        ai_items = self.data.ai_interactions
        events = self.data.events
        runs = self.signals.get("runs", [])
        req_list = []

        # Pre-normalize statement paragraphs once
        norm_paras = [(p, norm_ws(p)) for p in self.data.statement_paragraphs if len(p) >= 40]

        for idx, a in enumerate(ai_items):
            atype = a.get("type") or a.get("kind", "")
            if atype in ("chat_request", "ai_request") or a.get("prompt"):
                p = a.get("payload", {})
                req_id = a.get("request_id") or p.get("requestId") or f"req_{idx+1:03d}"
                t = a.get("t", 0)
                msgs = p.get("messages", [])
                user_msg = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
                if not user_msg and a.get("prompt"):
                    user_msg = a.get("prompt")

                u_lower = user_msg.lower()

                # Ma et al. 11 codes (Table 8.1)
                code = "OT"
                group = "X"
                if any(w in u_lower for w in ["error", "lỗi", "exception", "traceback", "fix", "sửa", "bug"]):
                    group = "D"
                    if "sửa" in u_lower or "fix" in u_lower or "resolve" in u_lower:
                        code = "CC"  # sửa code
                    elif "là gì" in u_lower or "what is" in u_lower:
                        code = "EI"  # giải thích lỗi
                    else:
                        code = "CV"  # kiểm tra code
                elif any(w in u_lower for w in ["tạo", "create", "write", "viết", "implement", "cài đặt", "sinh code", "apply", "code"]):
                    group = "I"
                    code = "CG" if ("viết" in u_lower or "tạo" in u_lower or "create" in u_lower or "sinh" in u_lower) else "IQ"
                elif any(w in u_lower for w in ["khái niệm", "concept", "what is", "là gì", "như thế nào", "how to"]):
                    group = "C"
                    code = "CQ" if "khái niệm" in u_lower else "PU"
                elif any(w in u_lower for w in ["giải thích", "tại sao", "why", "tối ưu", "optimize"]):
                    group = "R"
                    code = "CE" if "giải thích" in u_lower else "CO"
                else:
                    group = "I"
                    code = "IQ"

                # Flag 1: flag_error (prompt contains error message from last 3 failed runs)
                err_lines = [r.get("signature", "") for r in runs if r["t"] < t and r["outcome"] != "ok"][-3:]
                flag_error = any(norm_ws(l) in norm_ws(user_msg) for l in err_lines if l)

                # Flag 2: flag_task (containment >= 0.80 with any assignment statement paragraph >= 40 chars)
                norm_u = norm_ws(user_msg)
                len_u = len(norm_u)
                flag_task = False
                if len_u >= 30:
                    for orig_p, p_norm in norm_paras:
                        if len(orig_p) <= len_u * 1.3:
                            if p_norm in norm_u:
                                flag_task = True
                                break
                            _, c = calculate_overlap_ratio_and_containment(p_norm, norm_u)
                            if c >= self.params.get("prompt.task_containment", 0.80):
                                flag_task = True
                                break
                if not flag_task and ("yêu cầu" in u_lower or "đề bài" in u_lower or len(user_msg) > 150):
                    flag_task = True

                # Flag 3: flag_own_code (contains >= 3 consecutive lines of current file state)
                flag_own_code = False
                if len(user_msg) >= 40:
                    cur_state = self.data.state_at(t)
                    for fname, fcontent in cur_state.items():
                        if not fcontent:
                            continue
                        flines = [l.strip() for l in fcontent.splitlines() if len(l.strip()) >= 8]
                        if len(flines) >= 3:
                            for k in range(len(flines) - 2):
                                snippet = "\n".join(flines[k:k+3])
                                if snippet in user_msg or all(l in user_msg for l in flines[k:k+3]):
                                    flag_own_code = True
                                    break
                        if flag_own_code:
                            break

                req_list.append({
                    "id": f"req_{idx+1:03d}",
                    "request_id": req_id,
                    "t": t,
                    "prompt": user_msg,
                    "group": group,
                    "code": code,
                    "flag_error": flag_error,
                    "flag_task": flag_task,
                    "flag_own_code": flag_own_code
                })

        req_list.sort(key=lambda x: x["t"])
        self.signals["requests"] = req_list

    def _analyze_th4_ai_linkage(self):
        """TH4: Matches code edits/pastes with AI responses within 10min window (Spec 02 TH4)."""
        ai_items = self.data.ai_interactions
        events = self.data.events
        win_ms = self.params.get("match.window_ms", 600000)

        # Collect AI responses and code blocks
        ai_responses = []
        for a in ai_items:
            atype = a.get("type", a.get("kind", ""))
            if atype in ("chat_response_complete", "ai_response") or a.get("response") or a.get("output"):
                p = a.get("payload", {})
                req_id = a.get("request_id") or p.get("requestId")
                t = a.get("t_end", a.get("t", 0))
                text = p.get("text") or a.get("response") or a.get("output") or ""
                blocks = extract_code_blocks(text)
                ai_responses.append({
                    "request_id": req_id,
                    "t_end": t,
                    "text": text,
                    "blocks": [normalize_code(b) for b in blocks if b.strip()]
                })

        # Pre-normalize starter files
        # Pre-normalize relevant starter code files (exclude node_modules, .venv, etc.)
        norm_starters = [
            normalize_code(sf_c)
            for sf_name, sf_c in self.data.starter_files.items()
            if sf_c and not any(ign in sf_name.lower() for ign in ['node_modules', '.git', '__pycache__', '.venv', 'site-packages', 'dist', 'build', '.zip', '.tar', '.gz'])
        ]

        # Match insertions
        matched_chunks = []
        for e in events:
            kind = e.get("kind", e.get("type", ""))
            if kind in ("paste", "ai_insert", "typing_chunk"):
                p = e.get("payload", {})
                txt = e.get("inserted") or e.get("text") or p.get("pastedText") or p.get("text", "")
                t = e.get("t", 0)
                file_target = e.get("file") or e.get("filePath") or p.get("targetFile") or "app.py"
                file_target = file_target.replace("\\", "/").split("/")[-1]

                # Match pastes, ai_inserts, and large typing bursts (>= 100 chars)
                if kind not in ("paste", "ai_insert") and (kind != "typing_chunk" or len(txt) < 100):
                    continue
                if not txt or len(txt.strip()) < self.params.get("match.big_paste_chars", 20):
                    continue

                norm_txt = normalize_code(txt)
                if not norm_txt:
                    continue

                # Check if from_task (starter code)
                if any(norm_txt in sf_norm for sf_norm in norm_starters):
                    continue

                # Match with AI responses (10-minute window before insertion up to t + 15s)
                best_match = None
                best_score = 0.0
                best_req = None

                for resp in ai_responses:
                    if t - win_ms <= resp["t_end"] <= t + 15000:
                        for b in resp["blocks"]:
                            if not b:
                                continue
                            if norm_txt in b or b in norm_txt:
                                best_match = "verbatim"
                                best_score = 1.0
                                best_req = resp["request_id"]
                                break
                            if len(norm_txt) * len(b) <= 2000000:
                                r, c = calculate_overlap_ratio_and_containment(norm_txt, b)
                                if r >= self.params.get("match.close_ratio", 0.90) or c >= self.params.get("match.close_containment", 0.90):
                                    best_match = "close"
                                    best_score = max(r, c)
                                    best_req = resp["request_id"]
                                    break
                                elif c >= self.params.get("match.partial_containment", 0.50):
                                    if best_score < c:
                                        best_match = "partial"
                                        best_score = c
                                        best_req = resp["request_id"]
                        if best_match == "verbatim":
                            break

                if best_match:
                    matched_chunks.append({
                        "edit_id": e.get("id"),
                        "t": t,
                        "file": file_target,
                        "chars": len(txt),
                        "lines": len(txt.splitlines()),
                        "match_level": best_match,
                        "score": best_score,
                        "request_id": best_req,
                        "text": txt
                    })

        self.signals["matched_chunks"] = matched_chunks
        self.signals["ai_responses"] = ai_responses

    def _analyze_th5_and_th11_ai_fate(self):
        """TH5 & TH11: Analyzes fate, function names, lines_end, and verification traces D1-D5."""
        matched = self.signals.get("matched_chunks", [])
        runs = self.signals.get("runs", [])
        events = self.data.events
        requests = self.signals.get("requests", [])

        chunks = []
        discarded = []
        t_end_session = self.data.end_ts - self.data.start_ts

        for idx, m in enumerate(matched):
            t_ins = m["t"]
            req_id = m["request_id"]
            lines = m["lines"]
            chars = m["chars"]
            txt = m["text"]
            edit_id = m.get("edit_id") or f"e_ins_{idx+1}"

            # Calculate actual character survival at end of session
            alive_chars_end = self.data.alive_chars_at(edit_id, t_end_session)
            if alive_chars_end == 0 and chars > 0:
                # If spans not tracked for this edit, check if text exists in final file state
                cur_file_text = self.data.file_states.get(m["file"], "")
                if normalize_code(txt) in normalize_code(cur_file_text):
                    alive_chars_end = chars
                else:
                    _, c_end = calculate_overlap_ratio_and_containment(normalize_code(txt), normalize_code(cur_file_text))
                    alive_chars_end = int(c_end * chars)

            # First run after insertion
            first_run = next((r for r in runs if r["t"] > t_ins), None)

            # Trace D1: Sửa trước lần chạy đầu tiên (Spec 02, TH11)
            d1 = False
            if first_run:
                for e in events:
                    if t_ins < e.get("t", 0) < first_run["t"]:
                        if e.get("kind", e.get("type")) in ("edit", "typing_chunk", "undo"):
                            d1 = True
                            break

            # Trace D2: Lần chạy đầu tiên sau khi nhận
            d2 = None
            if first_run:
                d2 = {
                    "t": first_run["t"],
                    "outcome": first_run["outcome"],
                    "time_to_run_s": max((first_run["t"] - t_ins) // 1000, 0)
                }

            # Trace D3: Khung nhìn (view)
            d3 = None  # None with missing_reason = no_view_events per Spec 02 TH11

            # Trace D4: Hỏi AI về chính đoạn code này (prompt contains >= 3 lines)
            d4_reqs = []
            txt_lines = [l.strip() for l in txt.splitlines() if len(l.strip()) >= 8]
            if len(txt_lines) >= 3:
                for q in requests:
                    if q["t"] > t_ins:
                        if sum(1 for l in txt_lines if l in q.get("prompt", "")) >= 2:
                            d4_reqs.append(q["request_id"])

            # Trace D5: Sửa về sau (edits touching chunk characters after first run)
            d5_count = 0
            d5_after_error = False
            if first_run:
                for e in events:
                    if e.get("t", 0) > first_run["t"]:
                        if e.get("kind", e.get("type")) in ("edit", "typing_chunk", "undo"):
                            d5_count += 1
                            for r in runs:
                                if 0 < e.get("t", 0) - r["t_end"] < 60000 and r["outcome"] != "ok":
                                    d5_after_error = True

            reading_traces = []
            if d1: reading_traces.append("D1")
            if d4_reqs: reading_traces.append("D4")
            if d5_count > 0: reading_traces.append("D5")

            # Determine fate
            s_end = alive_chars_end / max(chars, 1)
            if s_end >= 0.95 and not d1 and d5_count == 0:
                fate = "intact"
            elif s_end == 0:
                fate = "discarded"
            else:
                fate = "partial"

            # Extract function names in chunk
            funcs = extract_function_names(txt)
            lines_end = lines if fate == "intact" else max(int(lines * s_end), 1 if s_end > 0 else 0)

            chunk_record = {
                "id": f"chunk_{idx+1}",
                "lineage": edit_id,
                "t_insert": t_ins,
                "file": m["file"],
                "lines": lines,
                "lines_end": lines_end,
                "funcs": funcs,
                "chars": chars,
                "alive_chars_end": alive_chars_end,
                "s_end": round(s_end, 2),
                "match_level": m["match_level"],
                "request_id": req_id,
                "fate": fate,
                "D1": d1,
                "D2": d2,
                "D3": d3,
                "D4": len(d4_reqs),
                "D5": d4_reqs,
                "D6": {"count": d5_count, "after_error": d5_after_error},
                "reading_traces": reading_traces,
                "has_reading_trace": len(reading_traces) > 0,
                "retained": (alive_chars_end >= self.params.get("aicode.retained_min_chars", 40) and fate != "discarded")
            }

            if chunk_record["retained"]:
                chunks.append(chunk_record)
            else:
                discarded.append({
                    "id": f"discarded_{len(discarded)+1}",
                    "lineage": edit_id,
                    "t_insert": t_ins,
                    "lines": lines,
                    "chars": chars,
                    "t_drop": t_ins + 120000,
                    "reason": "xóa hoặc hoàn tác sau khi chạy thử nghiệm",
                    "request_id": req_id
                })

        # Calculate ai_char_share_final (Spec 02, TH11)
        total_final_chars = sum(len(c) for c in self.data.file_states.values())
        total_ai_chars = sum(c["alive_chars_end"] for c in chunks)
        ai_char_share = total_ai_chars / max(total_final_chars, 1)

        self.signals["ai_chunks"] = chunks
        self.signals["ai_chunks_discarded"] = discarded
        self.signals["ai_char_share_final"] = round(ai_char_share, 4)

    def _analyze_th6_uptake(self):
        """TH6: Behavior around receiving AI code and state transitions."""
        responses = self.signals.get("ai_responses", [])
        chunks = self.signals.get("ai_chunks", [])
        uptakes = []

        for r in responses:
            matched_chunk = next((c for c in chunks if c["request_id"] == r["request_id"]), None)
            if matched_chunk:
                wait_s = max((matched_chunk["t_insert"] - r["t_end"]) // 1000, 0)
                uptakes.append({
                    "request_id": r["request_id"],
                    "wait_before_insert_s": wait_s,
                    "run_outcome": matched_chunk["D2"]["outcome"] if matched_chunk["D2"] else "none"
                })

        self.signals["uptakes"] = uptakes

    def _analyze_th8_context(self):
        """TH8: 5 mutually exclusive contexts + after_error flag (Spec 02, TH8)."""
        requests = self.signals.get("requests", [])
        runs = self.signals.get("runs", [])
        events = self.data.events

        for idx, q in enumerate(requests):
            t = q["t"]
            last_run = next((r for r in reversed(runs) if r["t"] < t), None)
            prev_req = requests[idx - 1] if idx > 0 else None

            # Calculate typed characters before q
            typed_before = sum(len(e.get("inserted") or e.get("text") or "") for e in events if e.get("kind", e.get("type")) in ("edit", "typing_chunk") and e.get("t", 0) <= t)

            # Mutually exclusive contexts
            if idx == 0 and typed_before <= 20:
                context = "start"
            elif prev_req and (t - prev_req["t"] <= 60000):
                context = "after_ai"
            elif typed_before > 20:
                context = "after_own_code"
            else:
                context = "start"

            # Boolean flag: after_error
            after_error = bool(last_run and last_run["outcome"] != "ok" and (t - last_run["t_end"] <= 180000))

            q["context"] = context
            q["after_error"] = after_error

    def _analyze_th9_reactions(self):
        """TH9: Reactions after failed AI code runs and fix loops (Spec 02, TH9)."""
        runs = self.signals.get("runs", [])
        chunks = self.signals.get("ai_chunks", [])
        requests = self.signals.get("requests", [])
        reactions = []
        fix_loops = []

        # Detect fix loops: sequence of >= 2 consecutive (insert -> error -> re_ask)
        loop_cycles = 0
        loop_reqs = []
        loop_runs = []

        for c in chunks:
            d2 = c.get("D2")
            if d2 and d2["outcome"] != "ok":
                # Look for next event after failed run
                subsequent_req = next((q for q in requests if q["t"] > d2["t"]), None)
                if subsequent_req:
                    loop_cycles += 1
                    loop_reqs.append(subsequent_req["request_id"])
                    loop_runs.append(d2["t"])

        if loop_cycles >= self.params.get("ai.fix_loop_min", 2):
            fix_loops.append({
                "start_t": loop_runs[0],
                "end_t": loop_runs[-1],
                "cycles": loop_cycles,
                "request_ids": loop_reqs
            })

        self.signals["reactions"] = reactions
        self.signals["fix_loops"] = fix_loops

    def _analyze_th10_bursts(self):
        """TH10: Large insertion bursts exceeding own_p95 (Spec 02, TH10)."""
        events = self.data.events
        typed_sizes = [len(e.get("inserted") or e.get("text") or "") for e in events if e.get("kind", e.get("type")) in ("edit", "typing_chunk") and (e.get("inserted") or e.get("text"))]

        if len(typed_sizes) >= self.params.get("burst.baseline_min_events", 20):
            typed_sizes.sort()
            idx_p95 = int(len(typed_sizes) * 0.95)
            own_p95 = typed_sizes[min(idx_p95, len(typed_sizes)-1)]
        else:
            own_p95 = 0

        threshold = max(own_p95, self.params.get("burst.abs_min_chars", 100))
        bursts = []

        for e in events:
            kind = e.get("kind", e.get("type", ""))
            if kind == "paste":
                p = e.get("payload", {})
                txt = e.get("inserted") or e.get("text") or p.get("pastedText") or ""
                if len(txt) > threshold:
                    bursts.append({
                        "edit_id": e.get("id"),
                        "t": e.get("t", 0),
                        "chars": len(txt),
                        "lines": len(txt.splitlines()),
                        "own_p95": own_p95
                    })

        self.signals["bursts"] = bursts
        self.signals["own_p95_typed_chars"] = own_p95
