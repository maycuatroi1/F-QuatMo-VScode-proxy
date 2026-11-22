# -*- coding: utf-8 -*-
"""
Interpretation module (M3) for PhaseSUMMARY Engine.
Implements Spec 04 (Diễn giải: sự việc, mốc so sánh và sự việc lớn nhất - Version 3.0, 30/10/2026):
1. Per-segment facts and session-level facts (Section 1)
2. Class baseline percentile comparisons (Section 2: top/bottom 10% when N >= 20)
3. Five Largest Events LN1 - LN5 and not_chosen tracking (Section 3, QĐ25)
"""

import math
from typing import Dict, List, Any, Optional, Tuple
from .constants import DEFAULT_PARAMS, minute_label


class LargestEvent:
    def __init__(
        self,
        event_id: str,
        magnitude: float,
        t_start: int,
        t_end: int,
        segment_ids: List[str],
        sources: List[str],
        facts: Dict[str, Any],
    ):
        self.id = event_id
        self.magnitude = magnitude
        self.t_start = t_start
        self.t_end = t_end
        self.segment_ids = segment_ids
        self.sources = sources
        self.facts = facts

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "magnitude": self.magnitude,
            "t_start": self.t_start,
            "t_end": self.t_end,
            "segment_ids": self.segment_ids,
            "sources": self.sources,
            "facts": self.facts,
        }


class InterpretationEngine:
    def __init__(
        self,
        session_data,
        signals: Dict[str, Any],
        segments: List[Any],
        params: Optional[Dict[str, Any]] = None,
        baseline: Optional[Dict[str, Any]] = None,
    ):
        self.data = session_data
        self.signals = signals
        self.segments = segments
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)
        self.baseline = baseline or {}
        self.not_chosen: List[Dict[str, Any]] = []

    def interpret(self) -> Tuple[Dict[str, Any], List[LargestEvent], List[Dict[str, Any]]]:
        """
        Compiles segment & session facts, compares with class baseline,
        and selects the five largest events LN1 - LN5 (Spec 04).
        """
        self._populate_segment_facts()
        facts = self._compile_session_facts()
        largest_events, not_chosen = self._evaluate_largest(facts)
        self.not_chosen = not_chosen
        return facts, largest_events, not_chosen

    def _find_segment_ids_for_span(self, t_start: int, t_end: int) -> List[str]:
        seg_ids = []
        for s in self.segments:
            if max(s.t_start, t_start) <= min(s.t_end, t_end):
                seg_ids.append(s.id)
        if not seg_ids:
            for s in self.segments:
                if s.t_start <= t_start <= s.t_end:
                    return [s.id]
        return seg_ids if seg_ids else [self.segments[0].id if self.segments else "D01"]

    def _find_segment_id_for_time(self, t: int) -> str:
        for s in self.segments:
            if s.t_start <= t <= s.t_end:
                return s.id
        return self.segments[0].id if self.segments else "D01"

    # =========================================================================
    # 1. Segment-level and Session-level Facts (Spec 04 Section 1)
    # =========================================================================
    def _populate_segment_facts(self):
        """Populates segment facts strictly per Spec 04 Section 1.1."""
        requests = self.signals.get("requests", [])
        runs = self.signals.get("runs", [])
        pauses = self.signals.get("pauses", [])
        chains = self.signals.get("chains", self.signals.get("threads", []))
        insert_chains = self.signals.get("insert_error_ask_chains", [])
        bursts = self.signals.get("bursts", [])
        # resync (A5) không phải thao tác của sinh viên: không vào sự việc của đoạn
        edits = [e for e in getattr(self.data, "edits", []) if not e.get("cancelled") and e.get("origin") != "resync"]
        chunks = self.signals.get("ai_chunks", [])

        req_by_id = {q["request_id"]: q for q in requests}
        chunk_by_id = {c["lineage"]: c for c in chunks}

        for seg in self.segments:
            s_start, s_end = seg.t_start, seg.t_end
            seg_runs = [r for r in runs if r.get("segment_id") == seg.id or (r.get("segment_id") is None and s_start <= r["t"] <= s_end)]
            seg_edits = [e for e in edits if e.get("segment_id") == seg.id or (e.get("segment_id") is None and s_start <= e["t"] <= s_end)]
            seg_reqs = [q for q in requests if q.get("segment_id") == seg.id or (q.get("segment_id") is None and s_start <= q["t"] <= s_end)]

            seg.facts = {
                "minute_start": seg.minute_start,
                "minute_end": seg.minute_end,
                "duration_s": max(0, int((s_end - s_start) // 1000)),
            }

            if seg.type == "ai":
                flag_err = [bool(q.get("flag_error")) for q in seg_reqs]
                flag_tsk = [bool(q.get("flag_task")) for q in seg_reqs]
                flag_own = [bool(q.get("flag_own_code")) for q in seg_reqs]
                prompt_sigs = [q.get("prompt_error_signature") for q in seg_reqs if q.get("prompt_error_signature")]
                matches_run = [q.get("matches_run") for q in seg_reqs if q.get("matches_run")]
                contexts = [q.get("context", "after_own_code") for q in seg_reqs]
                after_err = any(q.get("after_error") for q in seg_reqs)
                resp_has_code = [bool(q.get("response_has_code")) for q in seg_reqs]
                resp_lines = [q.get("response_code_lines", 0) for q in seg_reqs]
                resp_rejected = [bool(q.get("response_rejected")) for q in seg_reqs]

                insertions = []
                for e in seg_edits:
                    # Đợt do chương trình (A4) là một lần thêm: chỉ kể ở chunk đầu đợt, số dòng lấy theo cả đợt.
                    # Chunk khác của đợt và chunk chỉ xoá kế thừa nhãn khớp của chunk đầu, không phải lần thêm riêng.
                    if e.get("burst_head") not in (None, e["id"]) or e.get("whitespace_only"):
                        continue
                    ins_txt = e.get("burst_text") or e.get("inserted") or ""
                    if not ins_txt.strip():
                        continue
                    src = e.get("src", "typed")
                    m_info = e.get("match") or {}
                    m_level = m_info.get("level", "none")
                    if src in ("ai_insert", "ai_agent", "paste_chat") or m_level in ("verbatim", "close", "partial"):
                        lines = e.get("burst_lines") or len(ins_txt.splitlines()) or 1
                        req_id = m_info.get("request_id") or e.get("ai_request_id")
                        rq = req_by_id.get(req_id) if req_id else (seg_reqs[-1] if seg_reqs else None)
                        wait_s = None
                        if rq and rq.get("t_end") is not None and e["t"] >= rq["t_end"]:
                            wait_s = max(0, int((e["t"] - rq["t_end"]) // 1000))
                        c_obj = chunk_by_id.get(e["id"])
                        insertions.append({
                            "edit_id": e["id"],
                            "t": e["t"],
                            "file": e.get("file"),
                            "minute": minute_label(e["t"]),
                            "lines": lines,
                            "chars": e.get("burst_chars") or len(e.get("inserted", "")),
                            "src": src,
                            "group": e.get("group", "ai"),
                            "match_level": m_level if m_level != "none" else ("verbatim" if src in ("ai_insert", "ai_agent") else "none"),
                            "match_score": m_info.get("score"),
                            "response_minute": minute_label(rq.get("t_end", rq["t"])) if rq else minute_label(e["t"]),
                            "wait_s": wait_s,
                            "before_response_end": bool(rq and rq.get("t_end") is not None and e["t"] < rq["t_end"]),
                            "modified_before_run": bool(c_obj.get("D1")) if c_obj else False,
                        })

                wait_before_insert_s = insertions[0]["wait_s"] if insertions else None
                modified_before_run = any(ins.get("modified_before_run") for ins in insertions)
                first_run = seg_runs[0] if seg_runs else None
                time_to_run_s = None
                if first_run and seg_reqs:
                    r_end = seg_reqs[-1].get("t_end") or seg_reqs[-1]["t"]
                    if first_run["t"] >= r_end:
                        time_to_run_s = max(0, int((first_run["t"] - r_end) // 1000))

                next_action = None
                for r in seg_runs:
                    if r.get("next_action"):
                        next_action = r["next_action"]
                        break

                in_insert_chain = any(c["start_t"] <= s_start <= c["end_t"] for c in insert_chains)

                seg.facts.update({
                    "n_requests": len(seg_reqs),
                    "request_minutes": [minute_label(q["t"]) for q in seg_reqs],
                    "flag_error": flag_err,
                    "flag_task": flag_tsk,
                    "flag_own_code": flag_own,
                    "prompt_error_signature": prompt_sigs,
                    "matches_run": matches_run,
                    "context": contexts,
                    "after_error": after_err,
                    "response_has_code": resp_has_code,
                    "response_code_lines": resp_lines,
                    "response_rejected": resp_rejected,
                    "insertions": insertions,
                    "wait_before_insert_s": wait_before_insert_s,
                    "modified_before_run": modified_before_run,
                    "time_to_run_s": time_to_run_s,
                    "run_outcome": first_run.get("outcome") if first_run else None,
                    "next_action": next_action,
                    "in_insert_error_ask_chain": in_insert_chain,
                })

            elif seg.type == "error_chain":
                m_th = next((th for th in chains if th.get("id") == seg.raw_thread_id or th.get("m_id") == seg.thread_id), None)
                script = m_th.get("script", "main.py") if m_th else "main.py"
                sig = m_th.get("signature", "") if m_th else (seg_runs[0].get("signature", "") if seg_runs else "")
                err_type = m_th.get("error_type", "") if m_th else (seg_runs[0].get("error_type", "") if seg_runs else "")
                loc = m_th.get("location") if m_th else (seg_runs[0].get("location") if seg_runs else None)
                loc_line = loc.get("line") if loc else None
                unknown_between = m_th.get("unknown_between", 0) if m_th else 0
                b_labels = m_th.get("between_labels", []) if m_th else []
                del_err_line = m_th.get("deleted_error_line", False) if m_th else False
                n_reqs_in_th = len(m_th.get("requests_in_span", [])) if m_th else 0
                ended_min = minute_label(m_th["ended_at_t"]) if m_th and m_th.get("ended_at_t") is not None else None
                ended_by = m_th.get("ended_by_outcome") if m_th else None

                seg.facts.update({
                    "script": script,
                    "signature": sig,
                    "error_type": err_type,
                    "location_line": loc_line,
                    "n_runs": len(seg_runs),
                    # Mạch lỗi bị đoạn hỏi AI cắt thành nhiều đoạn: câu kể dùng số lần chạy và khoảng phút của cả mạch
                    "n_runs_thread": len(m_th.get("runs", [])) if m_th else len(seg_runs),
                    "thread_minute_start": minute_label(m_th["runs"][0]["t"]) if m_th and m_th.get("runs") else seg.minute_start,
                    "thread_minute_end": minute_label(m_th["runs"][-1]["t"]) if m_th and m_th.get("runs") else seg.minute_end,
                    "unknown_between": unknown_between,
                    "between_labels": b_labels,
                    "deleted_error_line": del_err_line,
                    "n_requests_in_thread": n_reqs_in_th,
                    "ended_minute": ended_min,
                    "ended_by_outcome": ended_by,
                })

            elif seg.type == "write":
                typed_chars = sum(len(e.get("inserted", "")) for e in seg_edits if e.get("origin") == "typed")
                pasted_chars = sum(len(e.get("inserted", "")) for e in seg_edits if e.get("src", "").startswith("paste_") or e.get("origin") == "paste")
                ai_chars = sum(len(e.get("inserted", "")) for e in seg_edits if e.get("group") == "ai")
                unknown_chars = sum(len(e.get("inserted", "")) for e in seg_edits if e.get("group") == "unknown")
                del_chars = sum(e.get("deleted_len", 0) for e in seg_edits)

                # Pasted lines: line count of the inserted text (including blank lines, trimmed of trailing newline)
                pasted_lines = 0
                for e in seg_edits:
                    if e.get("src", "").startswith("paste_") or e.get("origin") == "paste":
                        ins_txt = e.get("inserted", "")
                        if ins_txt:
                            pasted_lines += len(ins_txt.splitlines())

                # Typed lines: number of distinct lines, in the code state at the END of the segment,
                # that contain at least one character whose provenance origin is typed AND whose edit happened inside the segment
                typed_lines = 0
                state_end = self.data.state_at(s_end)
                spans_end = self.data.spans_at(s_end)
                for f_rel, content in state_end.items():
                    sps = spans_end.get(f_rel, [])
                    if not content or not sps:
                        continue
                    char_info = []
                    for sp in sps:
                        char_info.extend([(sp.origin, sp.t_insert)] * sp.length)
                    cur_off = 0
                    for line_str in content.splitlines(keepends=True):
                        l_len = len(line_str)
                        line_chars = char_info[cur_off : cur_off + l_len]
                        cur_off += l_len
                        if any(orig == "typed" and s_start <= t_ins <= s_end for orig, t_ins in line_chars):
                            typed_lines += 1

                net_lines = typed_lines
                run_outcomes: Dict[str, int] = {}
                for r in seg_runs:
                    oc = r.get("outcome", "unknown")
                    run_outcomes[oc] = run_outcomes.get(oc, 0) + 1

                seg_bursts = [b for b in bursts if s_start <= b["t"] <= s_end]
                reruns = [rn for rn in self.signals.get("rerun_no_change", []) if s_start <= rn["start_t"] <= s_end]

                seg.facts.update({
                    "typed_chars": typed_chars,
                    "pasted_chars": pasted_chars,
                    "ai_chars": ai_chars,
                    "unknown_chars": unknown_chars,
                    "del_chars": del_chars,
                    "typed_lines": typed_lines,
                    "pasted_lines": pasted_lines,
                    "net_lines": net_lines,
                    "n_runs": len(seg_runs),
                    "run_outcomes": run_outcomes,
                    "n_capture_runs": sum(1 for r in seg_runs if r.get("t_source") == "capture"),
                    "capture_upper_minute": max([minute_label(r["t"]) for r in seg_runs if r.get("t_source") == "capture"], default=None),
                    "bursts": seg_bursts,
                    "rerun_no_change": reruns[0] if reruns else None,
                })

            elif seg.type == "pause":
                matched_p = next((p for p in pauses if abs(p["start"] - s_start) <= 2000), None)
                tier = matched_p.get("tier", "vua") if matched_p else "vua"
                opener = matched_p.get("opener", "none") if matched_p else "none"
                del_lines = matched_p.get("deleted_lines", 0) if matched_p else 0
                follower = matched_p.get("follower", "none") if matched_p else "none"

                seg.facts.update({
                    "tier": tier,
                    "opener": opener,
                    "deleted_lines": del_lines,
                    "follower": follower,
                })

    def _last_page_minute(self, run: Dict[str, Any]) -> Optional[int]:
        """Phút của lần tải trang cuối: mốc dòng truy cập, không có thì lần chụp terminal."""
        ts = (run.get("observed") or {}).get("observed_until") or run.get("observed_at_ts")
        return minute_label(max(int(ts) - self.data.start_ts, 0)) if ts and run.get("page_loads") else None

    def _compile_session_facts(self) -> Dict[str, Any]:
        """Compiles session-level facts strictly per Spec 04 Section 1.2."""
        sigs = self.signals
        runs = sigs.get("runs", [])
        pauses = sigs.get("pauses", [])
        requests = sigs.get("requests", [])
        chains = sigs.get("chains", sigs.get("threads", []))
        chunks = sigs.get("ai_chunks", [])
        chunks_disc = sigs.get("ai_chunks_discarded", [])
        all_edits = getattr(self.data, "edits", [])
        edits = [e for e in all_edits if e.get("origin") != "resync"]
        resync_edits = [e for e in all_edits if e.get("origin") == "resync"]
        tot_dur_ms = sigs.get("duration_ms", 0)
        t_task_ms = sigs.get("T_task_ms", 0)

        duration_min = max(int(round(tot_dur_ms / 60000.0)), 1)
        t_task_min = max(int(round(t_task_ms / 60000.0)), 1)
        work_sessions = sigs.get("work_sessions", [])

        # Runs by outcome
        runs_by_outcome = sigs.get("runs_by_outcome") or {
            k: sum(1 for r in runs if r.get("outcome") == k)
            for k in ("error", "test_fail", "server_started", "no_error_seen", "unknown")
        }

        # Last run and last observed run
        last_run = None
        if runs:
            lr = runs[-1]
            last_run = {
                "minute": minute_label(lr["t"]),
                "script": lr.get("script", "main.py"),
                "outcome": lr["outcome"],
                "error_type": lr.get("error_type"),
                "last_page_code": lr.get("last_page_code"),
                "page_loads": lr.get("page_loads"),
                "last_page_minute": self._last_page_minute(lr),
                "observed_until_minute": minute_label(lr["t_end"]),
                "tests": lr.get("tests"),
                "t_source": lr.get("t_source", "log"),
                "capture_minute": minute_label(max(int(lr["observed_at_ts"]) - self.data.start_ts, 0)) if lr.get("observed_at_ts") else None,
            }

        observed_runs = [r for r in runs if r["outcome"] != "unknown"]
        last_observed_run = None
        if observed_runs:
            lor = observed_runs[-1]
            last_observed_run = {
                "minute": minute_label(lor["t"]),
                "script": lor.get("script", "main.py"),
                "outcome": lor["outcome"],
                "error_type": lor.get("error_type"),
                "last_page_code": lor.get("last_page_code"),
                "page_loads": lor.get("page_loads"),
                "last_page_minute": self._last_page_minute(lor),
                "observed_until_minute": minute_label(lor["t_end"]),
                "tests": lor.get("tests"),
            }

        # Errors at last observed run for each script
        errors_at_last_observed = []
        scripts = sorted(list({r.get("script") for r in runs if r.get("script")}))
        for sc in scripts:
            sc_obs = [r for r in runs if r.get("script") == sc and r["outcome"] != "unknown"]
            if sc_obs and sc_obs[-1]["outcome"] == "error":
                err_t = sc_obs[-1].get("error_type") or "RuntimeError"
                if err_t not in errors_at_last_observed:
                    errors_at_last_observed.append(err_t)

        test_runs = [r for r in runs if r.get("kind") == "test" and r.get("tests") is not None]
        failing_tests_last = []
        if test_runs:
            failing_tests_last = test_runs[-1]["tests"].get("failed", [])

        # Session typed lines: lines of final code containing typed chars
        session_typed_lines = 0
        for f_rel, content in getattr(self.data, "final_files", {}).items():
            sps = getattr(self.data, "final_spans", {}).get(f_rel, [])
            if not content or not sps:
                continue
            char_origins = []
            for sp in sps:
                char_origins.extend([sp.origin] * sp.length)
            cur_off = 0
            for line_str in content.splitlines(keepends=True):
                l_len = len(line_str)
                line_origs = char_origins[cur_off : cur_off + l_len]
                cur_off += l_len
                if any(orig == "typed" for orig in line_origs):
                    session_typed_lines += 1

        # Chars and lines by group (typed, paste_other, ai, unknown)
        chars_by_group = {"typed": 0, "paste_other": 0, "ai": 0, "unknown": 0}
        lines_by_group = {"typed": session_typed_lines, "paste_other": 0, "ai": 0, "unknown": 0}

        by_id = {e["id"]: e for e in edits}
        for e in edits:
            if e.get("cancelled") or e.get("whitespace_only"):
                continue
            b_head = e.get("burst_head")
            if b_head and by_id.get(b_head, {}).get("whitespace_only"):
                continue
            txt = e.get("inserted", "")
            if not txt:
                continue
            c_len = len(txt)
            l_cnt = len(txt.splitlines()) if txt else 0
            if not l_cnt and txt:
                l_cnt = 1
            # Đợt do chương trình: số dòng tính một lần theo cả đợt ở chunk đầu, chunk khác chỉ cộng ký tự
            if b_head:
                l_cnt = (e.get("burst_lines") or l_cnt) if b_head == e["id"] else 0
            src = e.get("src", "typed")
            grp = e.get("group", "other")

            if src == "typed":
                chars_by_group["typed"] += c_len
                # lines_by_group["typed"] is session_typed_lines (lines of final code containing typed chars)
            elif grp == "ai":
                chars_by_group["ai"] += c_len
                lines_by_group["ai"] += l_cnt
            elif grp == "unknown":
                chars_by_group["unknown"] += c_len
                lines_by_group["unknown"] += l_cnt
            else:
                chars_by_group["paste_other"] += c_len
                lines_by_group["paste_other"] += l_cnt

        # Code do resync đưa vào (log IDE không ghi thay đổi): nhóm riêng, không gộp vào không rõ nguồn
        chars_by_group["unlogged"] = sum(e.get("new_chars", 0) for e in resync_edits)
        lines_by_group["unlogged"] = sum(e.get("new_lines", 0) for e in resync_edits)
        unlogged_minutes = sorted({minute_label(e["t"]) for e in resync_edits if e.get("new_lines", 0) > 0})

        # Final chars by group (share of final files, excluding starter)
        final_chars_by_grp = {"typed": 0, "paste_other": 0, "ai": 0, "unknown": 0}
        for f_rel, spans in getattr(self.data, "final_spans", {}).items():
            for sp in spans:
                if sp.origin != "starter" and sp.lineage != "starter":
                    grp = getattr(sp, "group", None)
                    if grp is None:
                        if sp.origin in ("ai_insert", "ai_agent", "ai_autocomplete", "paste_chat"):
                            grp = "ai"
                        elif sp.origin == "typed":
                            grp = "typed"
                        elif sp.origin in ("unknown_source", "resync", "unknown", "programmatic"):
                            grp = "unknown"
                        else:
                            grp = "paste_other"
                    if grp in final_chars_by_grp:
                        final_chars_by_grp[grp] += sp.length

        # AI flags
        n_req_error = sum(1 for q in requests if q.get("flag_error"))
        n_req_task = sum(1 for q in requests if q.get("flag_task"))
        n_req_own = sum(1 for q in requests if q.get("flag_own_code"))
        n_resp_no_code = sum(1 for q in requests if not q.get("response_has_code") and not q.get("response_rejected"))
        n_requests_rejected = sum(1 for q in requests if q.get("response_rejected"))

        # AI fates
        ai_fates = {"intact": 0, "partial": 0, "discarded": 0}
        for c in chunks:
            ft = c.get("fate", "intact")
            if ft in ai_fates:
                ai_fates[ft] += 1

        # Class comparisons (Spec 04 Section 2)
        comparisons = self._compute_comparisons(len(runs), len(requests), t_task_min,
                                                sum(1 for p in pauses if p.get("length", 0) >= 180000),
                                                sum(1 for c in chains if c.get("repeated")))

        session_facts = {
            "duration_min": duration_min,
            "T_task_min": t_task_min,
            "n_work_sessions": len(work_sessions),
            "n_pauses_ge_3min": sum(1 for p in pauses if p.get("length", 0) >= 180000),
            "n_pauses_ge_10min": sum(1 for p in pauses if p.get("length", 0) >= 600000),
            "runs_by_outcome": runs_by_outcome,
            "last_run": last_run,
            "last_observed_run": last_observed_run,
            "errors_at_last_observed": errors_at_last_observed,
            "n_chains_repeated": sum(1 for c in chains if c.get("repeated")),
            "failing_tests_last_test_run": failing_tests_last,
            "chars_by_group": chars_by_group,
            "lines_by_group": lines_by_group,
            "unlogged_minutes": unlogged_minutes,
            "chars_final_by_group": final_chars_by_grp,
            "n_requests": len(requests),
            "n_requests_by_flag": {
                "error": n_req_error,
                "task": n_req_task,
                "own_code": n_req_own,
            },
            "n_responses_no_code": n_resp_no_code,
            "n_requests_rejected": n_requests_rejected,
            "conversations_by_label": sigs.get("conversations_by_label", {"I": 0, "M": 0, "E": 0, "unknown": 0}),
            "n_request_error_chains": len(sigs.get("request_error_chains", [])),
            "n_insert_error_ask_chains": len(sigs.get("insert_error_ask_chains", [])),
            "ai_fates": ai_fates,
            "ai_chunks_retained": [c for c in chunks if c.get("retained")],
            "ai_chunks_discarded": chunks_disc,
            "n_cancelled_pairs": getattr(self.data, "dq_report", {}).get("undo", {}).get("cancelled_pairs", 0),
            "n_repaste_families": len(getattr(self.data, "provenance", {}).get("repaste_families", [])),
            "reconstruction": self.data.dq_report.get("reconstruction"),
            "share_runs_observed": round(len(observed_runs) / len(runs), 3) if runs else 1.0,
            "runs_from_capture": sum(1 for r in runs if r.get("t_source") == "capture"),
            "terminal_source": "log terminal của F-VSCode",
            "comparisons": comparisons,
        }
        return session_facts

    def _compute_comparisons(self, n_runs: int, n_reqs: int, t_task: int, n_pauses_3m: int, n_chains: int) -> Dict[str, Optional[str]]:
        """Spec 04 Section 2: Baseline percentile comparisons (top/bottom 10% when N >= 20)."""
        metrics = {
            "n_runs_total": n_runs,
            "n_requests_total": n_reqs,
            "T_task_min": t_task,
            "n_pauses_ge_3min": n_pauses_3m,
            "n_chains_repeated": n_chains,
        }
        comparisons = {}
        min_class = self.params.get("baseline.min_class_sessions", 20)
        tail_pct = self.params.get("baseline.tail_pct", 10)
        base_metrics = self.baseline.get("metrics", {}) if isinstance(self.baseline, dict) else {}

        for m_name, cur_val in metrics.items():
            vals = base_metrics.get(m_name, [])
            if len(vals) >= min_class:
                rank = 100.0 * (sum(1 for v in vals if v < cur_val) + 0.5 * sum(1 for v in vals if v == cur_val)) / len(vals)
                if rank >= 100 - tail_pct:
                    comparisons[m_name] = "higher_than_most"
                elif rank <= tail_pct:
                    comparisons[m_name] = "lower_than_most"
                else:
                    comparisons[m_name] = None
            else:
                comparisons[m_name] = None
        return comparisons

    # =========================================================================
    # 2. Five Largest Events LN1 - LN5 (Spec 04 Section 3, QĐ25)
    # =========================================================================
    def _evaluate_largest(self, facts: Dict[str, Any]) -> Tuple[List[LargestEvent], List[Dict[str, Any]]]:
        """
        Extracts up to 5 largest events: LN1, LN2, LN3, LN4, LN5.
        Tracks all unselected candidates in not_chosen with reasons.
        """
        sigs = self.signals
        insertions = sigs.get("insertions", [])
        chains = sigs.get("chains", sigs.get("threads", []))
        test_streaks = sigs.get("test_streaks", [])
        pauses = sigs.get("pauses", [])
        insert_chains = sigs.get("insert_error_ask_chains", [])
        req_chains = sigs.get("request_error_chains", [])
        requests = sigs.get("requests", [])
        bursts = sigs.get("bursts", [])
        burst_ids = {b["edit_id"] for b in bursts}
        chunk_by_id = {c["lineage"]: c for c in sigs.get("ai_chunks", [])}

        largest_map: Dict[str, LargestEvent] = {}
        not_chosen: List[Dict[str, Any]] = []

        # ---------------------------------------------------------------------
        # LN1: Đợt chèn hoặc dán lớn nhất (Spec 04 Section 3: lines >= largest.ln1_min_lines (5))
        # ---------------------------------------------------------------------
        ln1_min_lines = self.params.get("largest.ln1_min_lines", 5)
        cands_ln1 = [
            ins for ins in insertions
            if ins.get("src") not in ("typed", "undo", "redo", "from_task")
            and not ins.get("repaste_of")
        ]
        eligible_ln1 = [ins for ins in cands_ln1 if ins.get("lines", 0) >= ln1_min_lines]

        if eligible_ln1:
            eligible_ln1.sort(key=lambda x: (-x["lines"], x["t"]))
            best_ln1 = eligible_ln1[0]
            eid = best_ln1["edit_id"]
            c_meta = chunk_by_id.get(eid, {})
            req_min = None
            if best_ln1["match"].get("response_t_end") is not None:
                req_min = minute_label(best_ln1["match"]["response_t_end"])

            seg_ids = self._find_segment_ids_for_span(best_ln1["t"], best_ln1["t"])
            ln1_event = LargestEvent(
                event_id="LN1",
                magnitude=best_ln1["lines"],
                t_start=best_ln1["t"],
                t_end=best_ln1["t"],
                segment_ids=seg_ids,
                sources=[eid],
                facts={
                    "minute": minute_label(best_ln1["t"]),
                    "file": best_ln1["file"],
                    "lines": best_ln1["lines"],
                    "chars": best_ln1["chars"],
                    "src": best_ln1["src"],
                    "group": best_ln1.get("group", "other"),
                    "match_level": best_ln1["match"].get("level", "none"),
                    "response_minute": req_min,
                    "fate": c_meta.get("fate", "intact"),
                    "s_end": c_meta.get("s_end", 1.0),
                    "is_burst": eid in burst_ids,
                },
            )
            largest_map["LN1"] = ln1_event

            for ins in eligible_ln1[1:]:
                not_chosen.append({
                    "type": "LN1",
                    "id": ins.get("edit_id") or ins.get("id"),
                    "reason": "smaller",
                    "magnitude": ins["lines"],
                    "edit_id": ins["edit_id"],
                })
        for ins in cands_ln1:
            if ins.get("lines", 0) < ln1_min_lines:
                not_chosen.append({
                    "type": "LN1",
                    "id": ins.get("edit_id") or ins.get("id"),
                    "reason": "below_threshold",
                    "magnitude": ins.get("lines", 0),
                    "edit_id": ins["edit_id"],
                })

        # ---------------------------------------------------------------------
        # LN2: Chuỗi lỗi dài nhất (Spec 04 Section 3: repeated, len(runs) >= 3)
        # ---------------------------------------------------------------------
        cands_ln2 = [ch for ch in chains if ch.get("repeated")]
        eligible_streaks = [st for st in test_streaks if st.get("runs", 0) >= 3]

        best_chain = None
        best_n_runs = -1
        is_test_streak = False

        for ch in cands_ln2:
            n_r = len(ch.get("runs", []))
            if n_r > best_n_runs:
                best_n_runs = n_r
                best_chain = ch
                is_test_streak = False

        for st in eligible_streaks:
            if st.get("runs", 0) > best_n_runs:
                best_n_runs = st["runs"]
                best_chain = st
                is_test_streak = True

        if best_chain:
            if not is_test_streak:
                ch = best_chain
                ch_runs = ch.get("runs", [])
                t_s = ch_runs[0]["t"]
                t_e = ch.get("ended_at_t") if ch.get("ended_at_t") is not None else ch_runs[-1]["t"]
                seg_ids = self._find_segment_ids_for_span(t_s, t_e)
                ln2_event = LargestEvent(
                    event_id="LN2",
                    magnitude=len(ch_runs),
                    t_start=t_s,
                    t_end=t_e,
                    segment_ids=seg_ids,
                    sources=[r["id"] for r in ch_runs],
                    facts={
                        "script": ch.get("script", "main.py"),
                        "error_type": ch.get("error_type", "RuntimeError"),
                        "signature": ch.get("signature", ""),
                        "n_runs": len(ch_runs),
                        "unknown_between": ch.get("unknown_between", 0),
                        "minute_start": minute_label(t_s),
                        "minute_last_error": minute_label(ch_runs[-1]["t"]),
                        "ended_minute": minute_label(ch["ended_at_t"]) if ch.get("ended_at_t") is not None else None,
                        "ended_by_outcome": ch.get("ended_by_outcome"),
                        "n_requests_in_span": len(ch.get("requests_in_span", [])),
                    },
                )
            else:
                st = best_chain
                t_s = st["start_t"]
                t_e = st["end_t"]
                seg_ids = self._find_segment_ids_for_span(t_s, t_e)
                ln2_event = LargestEvent(
                    event_id="LN2",
                    magnitude=st["runs"],
                    t_start=t_s,
                    t_end=t_e,
                    segment_ids=seg_ids,
                    sources=st.get("sources", []),
                    facts={
                        "kind": "test_streak",
                        "script": "test",
                        "error_type": "AssertionError",
                        "signature": f"test_fail:{st.get('test_id')}",
                        "n_runs": st["runs"],
                        "unknown_between": 0,
                        "minute_start": minute_label(t_s),
                        "minute_last_error": minute_label(t_e),
                        "ended_minute": minute_label(st["resolved_at_t"]) if st.get("resolved_at_t") is not None else None,
                        "ended_by_outcome": "no_error_seen" if st.get("resolved_at_t") is not None else None,
                        "n_requests_in_span": 0,
                    },
                )
            largest_map["LN2"] = ln2_event

        for ch in chains:
            if not ch.get("repeated"):
                not_chosen.append({
                    "type": "LN2",
                    "reason": "below_threshold",
                    "magnitude": len(ch.get("runs", [])),
                    "id": ch.get("id"),
                })
            elif best_chain and ch != best_chain:
                not_chosen.append({
                    "type": "LN2",
                    "reason": "smaller",
                    "magnitude": len(ch.get("runs", [])),
                    "id": ch.get("id"),
                })

        # ---------------------------------------------------------------------
        # LN3: Khoảng không thao tác dài nhất (Spec 04 Section 3: length >= 600000 (10 min))
        # ---------------------------------------------------------------------
        ln3_min_ms = self.params.get("largest.ln3_min_ms", 600000)
        eligible_pauses = [p for p in pauses if p.get("length", 0) >= ln3_min_ms]

        if eligible_pauses:
            eligible_pauses.sort(key=lambda x: (-x["length"], x["start"]))
            best_pause = eligible_pauses[0]
            t_s = best_pause["start"]
            t_e = best_pause["end"]
            dur_min = max(int(round(best_pause["length"] / 60000.0)), 1)
            seg_ids = self._find_segment_ids_for_span(t_s, t_e)

            ln3_event = LargestEvent(
                event_id="LN3",
                magnitude=dur_min,
                t_start=t_s,
                t_end=t_e,
                segment_ids=seg_ids,
                sources=best_pause.get("sources", []),
                facts={
                    "minute_start": minute_label(t_s),
                    "minute_end": minute_label(t_e),
                    "duration_min": dur_min,
                    "opener": best_pause.get("opener", "none"),
                    "follower": best_pause.get("follower", "none"),
                },
            )
            largest_map["LN3"] = ln3_event

            for p in eligible_pauses[1:]:
                not_chosen.append({
                    "type": "LN3",
                    "reason": "smaller",
                    "magnitude": int(round(p["length"] / 60000.0)),
                    "id": p.get("id"),
                })
        for p in pauses:
            if p.get("length", 0) < ln3_min_ms:
                not_chosen.append({
                    "type": "LN3",
                    "reason": "below_threshold",
                    "magnitude": int(round(p["length"] / 60000.0)),
                    "id": p.get("id"),
                })

        # ---------------------------------------------------------------------
        # LN4: Chuỗi chèn, lỗi, hỏi lại hoặc chuỗi yêu cầu kèm lỗi (Spec 04 Section 3)
        # ---------------------------------------------------------------------
        if insert_chains:
            insert_chains_sorted = sorted(insert_chains, key=lambda x: (-x["cycles"], x["start_t"]))
            best_ic = insert_chains_sorted[0]
            t_s = best_ic["start_t"]
            t_e = best_ic["end_t"]
            seg_ids = self._find_segment_ids_for_span(t_s, t_e)
            ln4_event = LargestEvent(
                event_id="LN4",
                magnitude=best_ic["cycles"],
                t_start=t_s,
                t_end=t_e,
                segment_ids=seg_ids,
                sources=best_ic.get("sources", best_ic.get("request_ids", [])),
                facts={
                    "kind": "insert_error_ask",
                    "cycles": best_ic["cycles"],
                    "minute_start": minute_label(t_s),
                    "minute_end": minute_label(t_e),
                },
            )
            largest_map["LN4"] = ln4_event
        elif req_chains:
            req_chains_sorted = sorted(req_chains, key=lambda x: (-x["n_requests"], x["start_t"]))
            best_rc = req_chains_sorted[0]
            t_s = best_rc["start_t"]
            t_e = best_rc["end_t"]
            seg_ids = self._find_segment_ids_for_span(t_s, t_e)
            ln4_event = LargestEvent(
                event_id="LN4",
                magnitude=best_rc["n_requests"],
                t_start=t_s,
                t_end=t_e,
                segment_ids=seg_ids,
                sources=best_rc.get("request_ids", []),
                facts={
                    "kind": "request_error",
                    "n_requests": best_rc["n_requests"],
                    "minute_start": minute_label(t_s),
                    "minute_end": minute_label(t_e),
                },
            )
            largest_map["LN4"] = ln4_event

        # ---------------------------------------------------------------------
        # LN5: Cách bắt đầu bài (Spec 04 Section 3: chỉ khi có ít nhất một yêu cầu AI)
        # ---------------------------------------------------------------------
        if requests:
            q1 = requests[0]
            # Time of first typed edit exceeding context_typed_chars tolerance
            base_chars = self.params.get("prompt.context_typed_chars", 20)
            t_type1 = None
            acc_chars = 0
            for e in getattr(self.data, "edits", []):
                if e.get("origin") == "typed" and not e.get("cancelled"):
                    acc_chars += len(e.get("inserted", ""))
                    if acc_chars > base_chars:
                        t_type1 = e["t"]
                        break

            burst_match = next((b for b in bursts if b.get("request_id") == q1["request_id"]), None)
            burst_lines = burst_match["lines"] if burst_match else 0
            inserted_as_burst = bool(burst_match)
            magnitude = burst_lines if inserted_as_burst else 0

            seg_ids = self._find_segment_ids_for_span(q1["t"], q1.get("t_end", q1["t"]))
            ln5_event = LargestEvent(
                event_id="LN5",
                magnitude=magnitude,
                t_start=q1["t"],
                t_end=q1.get("t_end", q1["t"]),
                segment_ids=seg_ids,
                sources=[q1["request_id"]] + ([burst_match["id"]] if burst_match else []),
                facts={
                    "request_minute": minute_label(q1["t"]),
                    "first_typing_minute": minute_label(t_type1) if t_type1 is not None else None,
                    "request_before_typing": (t_type1 is None or q1["t"] < t_type1),
                    "context": q1.get("context", "start"),
                    "flag_task": q1.get("flag_task", False),
                    "response_has_code": q1.get("response_has_code", False),
                    "inserted_as_burst": inserted_as_burst,
                    "burst_lines": burst_lines,
                },
            )
            largest_map["LN5"] = ln5_event

        # Return chosen events in canonical keypoint order (Spec 04 Section 3: [LN1, LN2, LN4, LN3, LN5])
        order = self.params.get("largest.keypoint_order", ["LN1", "LN2", "LN4", "LN3", "LN5"])
        chosen_events = [largest_map[ln_id] for ln_id in order if ln_id in largest_map]
        return chosen_events, not_chosen
