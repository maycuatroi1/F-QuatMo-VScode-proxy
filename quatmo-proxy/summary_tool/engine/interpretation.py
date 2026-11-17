# -*- coding: utf-8 -*-
"""
Interpretation module (M3) for PhaseSUMMARY Engine.
Strictly implements Specification 04 (04 Diễn giải và điều đáng hỏi.md):
- Segment-level and session-level factual metrics (Fact objects)
- Trajectory pattern according to Ma et al.
- Class baseline percentile ranking (higher_than_most / lower_than_most)
- Rules DH1 - DH5 candidate evaluation, deduplication, and selection
- Rule DH0 fixed pedagogical suggestion
"""

from typing import Dict, List, Any, Optional, Tuple, Set
from .constants import DEFAULT_PARAMS, REQUEST_CATEGORY_NAMES


class Fact:
    def __init__(self, key: str, value: Any, unit: Optional[str] = None,
                 sources: Optional[List[str]] = None, segment_id: Optional[str] = None):
        self.key = key
        self.value = value
        self.unit = unit
        self.sources = sources or []
        self.segment_id = segment_id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "value": self.value,
            "unit": self.unit,
            "sources": self.sources,
            "segment_id": self.segment_id
        }


class AskItem:
    def __init__(self, ask_id: str, rule: str, title: str, fact_text: str, question: str,
                 alternatives: List[str], priority: int, magnitude: float,
                 segment_ids: Optional[List[str]] = None, sources: Optional[List[str]] = None):
        self.id = ask_id
        self.rule = rule  # 'DH1', 'DH2', 'DH3', 'DH4', 'DH5'
        self.title = title
        self.fact_text = fact_text
        self.question = question
        self.alternatives = alternatives
        self.priority = priority
        self.magnitude = magnitude
        self.segment_ids = segment_ids or []
        self.sources = sources or []

    @property
    def segment_id(self) -> str:
        return self.segment_ids[0] if self.segment_ids else "D01"

    def to_rendered(self, index: int) -> str:
        # Spec 04 Section 3.8:
        # {n}. **{title}.** Sự việc: {fact_text} [{segment_ids}]. Có thể hỏi: {question}. Cách hiểu khác: {alts}
        seg_ref = f" [{', '.join(self.segment_ids)}]" if self.segment_ids else ""
        alt_sentences = []
        for a in self.alternatives:
            s = a.strip()
            if s:
                # Capitalize first char
                s = s[0].upper() + s[1:]
                if not s.endswith("."):
                    s += "."
                alt_sentences.append(s)
        alt_str = " ".join(alt_sentences)
        return (f"{index}. **{self.title}.** Sự việc: {self.fact_text}{seg_ref}. "
                f"Có thể hỏi: {self.question}. "
                f"Cách hiểu khác: {alt_str}")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "rule": self.rule,
            "title": self.title,
            "fact_text": self.fact_text,
            "question": self.question,
            "alternatives": self.alternatives,
            "priority": self.priority,
            "magnitude": self.magnitude,
            "segment_ids": self.segment_ids,
            "sources": self.sources
        }


class InterpretationEngine:
    def __init__(self, session_data, signals: Dict[str, Any], segments: List[Any],
                 threads: Optional[List[Dict[str, Any]]] = None,
                 baseline: Optional[Dict[str, Any]] = None,
                 params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.signals = signals
        self.segments = segments
        self.threads = threads or []
        self.baseline = baseline
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)

    def to_min(self, t: Any) -> int:
        if t is None:
            return 0
        try:
            val = int(t)
            if val > 100_000_000:
                return max(int((val - getattr(self.data, "start_ts", 0)) / 60000), 0)
            return max(int(val / 60000), 0)
        except Exception:
            return 0

    def interpret(self) -> Tuple[Dict[str, Any], List[AskItem], str, Dict[str, Any]]:
        """
        Compiles session facts, attaches facts to segments, evaluates DH1-DH5, and computes baseline percentiles.
        Returns (facts, asks, dh0, asks_report).
        """
        facts = self._compile_facts()
        self._attach_segment_facts(facts)
        asks, dh0, asks_report = self._evaluate_asks(facts)
        return facts, asks, dh0, asks_report

    def _compile_facts(self) -> Dict[str, Any]:
        """Compiles facts at session level per Spec 04 Section 1.2."""
        chunks = self.signals.get("ai_chunks", [])
        retained_chunks = sorted([c for c in chunks if c.get("retained")], key=lambda c: c.get("lines_end", c.get("lines", 0)), reverse=True)
        discarded_chunks = self.signals.get("ai_chunks_discarded", [])
        runs = self.signals.get("runs", [])
        requests = self.signals.get("requests", [])
        sig_threads = self.signals.get("threads", [])
        work_sessions = self.signals.get("work_sessions", [])
        pauses = self.signals.get("pauses", [])

        # Count traces on retained chunks
        trace_counts = {"D1": 0, "D3": 0, "D4": 0, "D5": 0}
        no_trace_chunks = []
        for c in retained_chunks:
            has_trace = False
            if c.get("D1"):
                trace_counts["D1"] += 1
                has_trace = True
            d3 = c.get("D3")
            if d3 and isinstance(d3, dict) and d3.get("until_end", 0) > 0:
                trace_counts["D3"] += 1
                has_trace = True
            elif isinstance(d3, int) and d3 > 0:
                trace_counts["D3"] += 1
                has_trace = True
            if c.get("D4"):
                trace_counts["D4"] += 1
                has_trace = True
            if c.get("D5"):
                trace_counts["D5"] += 1
                has_trace = True

            if not has_trace:
                no_trace_chunks.append(c)

        # Count requests by category group
        group_counts = {"C": 0, "I": 0, "D": 0, "R": 0, "X": 0}
        for q in requests:
            g = q.get("group", "X")
            if g in group_counts:
                group_counts[g] += 1
            else:
                group_counts["X"] += 1

        # Trajectory pattern (Ma et al., Spec 04 Section 1.3)
        seq = [q.get("group") for q in requests if q.get("group") != "X"]
        debug_persistence_len = self.params.get("ai.debug_persistence", 3)
        if len(seq) == 0:
            trajectory = "none"
        elif len(seq) == 1:
            trajectory = "one_shot"
        elif any(seq[i:i + debug_persistence_len] == ["D"] * debug_persistence_len for i in range(len(seq) - debug_persistence_len + 1)):
            trajectory = "debug_persistence"
        elif seq and seq[0] == "C":
            trajectory = "conceptual_framing"
        elif set(seq).issubset({"I", "D"}):
            trajectory = "performance_oriented"
        else:
            trajectory = "mode_shifting"

        trajectory_display = {
            "one_shot": "một lượt",
            "debug_persistence": "gỡ lỗi kéo dài",
            "conceptual_framing": "bắt đầu bằng hỏi khái niệm",
            "performance_oriented": "chỉ hỏi cài đặt và gỡ lỗi",
            "mode_shifting": "chuyển qua lại giữa các kiểu hỏi",
            "none": "không dùng AI"
        }.get(trajectory, trajectory)

        # Last run
        last_run = runs[-1] if runs else None
        last_run_minute = self.to_min(last_run["t"]) if last_run else 0

        # AI fates
        intact_count = sum(1 for c in retained_chunks if c.get("fate") == "intact")
        partial_count = sum(1 for c in retained_chunks if c.get("fate") == "partial")
        discarded_count = len(discarded_chunks)

        total_ai_lines = sum(c.get("lines_end", c.get("lines", 0)) for c in retained_chunks)
        duration_min = max(int(self.signals.get("duration_ms", 0) / 60000), 1)
        t_task_min = max(int(self.signals.get("T_task_ms", 0) / 60000), 1)

        pauses_ge_3min = [p for p in pauses if p.get("length", 0) >= 180000]

        # Repeated threads & unresolved
        repeated_threads = [th for th in sig_threads if th.get("repeated")]
        unresolved_threads = [th for th in repeated_threads if not th.get("resolved_at")]

        # Class baseline comparison (Spec 04 Section 2)
        comparisons: Dict[str, Optional[str]] = {}
        if self.baseline and isinstance(self.baseline, dict):
            min_class_sessions = self.params.get("baseline.min_class_sessions", 20)
            tail_pct = self.params.get("baseline.tail_pct", 10)

            metric_values = {
                "n_runs_total": len(runs),
                "n_requests_total": len(requests),
                "T_task_min": t_task_min,
                "n_pauses_ge_3min": len(pauses_ge_3min),
                "n_threads_repeated": len(repeated_threads)
            }

            for m_key, v in metric_values.items():
                class_vals = self.baseline.get(m_key, [])
                n = len(class_vals)
                if n >= min_class_sessions:
                    count_less = sum(1 for cv in class_vals if cv < v)
                    count_equal = sum(1 for cv in class_vals if cv == v)
                    rank = 100.0 * (count_less + 0.5 * count_equal) / n
                    if rank >= 100 - tail_pct:
                        comparisons[m_key] = "higher_than_most"
                    elif rank <= tail_pct:
                        comparisons[m_key] = "lower_than_most"
                    else:
                        comparisons[m_key] = None
                else:
                    comparisons[m_key] = None

        facts: Dict[str, Any] = {
            "duration_min": duration_min,
            "T_task_min": t_task_min,
            "n_work_sessions": max(len(work_sessions), 1),
            "total_runs": len(runs),
            "runs_ok": sum(1 for r in runs if r.get("outcome") == "ok"),
            "runs_error": sum(1 for r in runs if r.get("outcome") in ["error", "test_fail"]),
            "last_run": last_run,
            "last_run_minute": last_run_minute,
            "requests_count": len(requests),
            "group_counts": group_counts,
            "trajectory": trajectory_display,
            "retained_chunks": retained_chunks,
            "total_ai_lines": total_ai_lines,
            "no_trace_chunks": no_trace_chunks,
            "trace_counts": trace_counts,
            "ai_fates": {
                "intact": intact_count,
                "partial": partial_count,
                "discarded": discarded_count
            },
            "intact_count": intact_count,
            "partial_count": partial_count,
            "discarded_chunks": discarded_chunks,
            "repeated_threads": repeated_threads,
            "unresolved_threads": unresolved_threads,
            "bursts": self.signals.get("bursts", []),
            "pauses_ge_3min": len(pauses_ge_3min),
            "ai_char_share_final": self.signals.get("ai_char_share_final", 0.0),
            "n_cancelled_pairs": getattr(self.data, "dq_report", {}).get("n_cancelled_pairs", 0),
            "n_repaste_families": getattr(self.data, "dq_report", {}).get("n_repaste_families", 0),
            "comparisons": comparisons
        }
        return facts

    def _attach_segment_facts(self, session_facts: Dict[str, Any]):
        """Attaches detailed facts to each Segment per Spec 04 Section 1.1."""
        requests = self.signals.get("requests", [])
        runs = self.signals.get("runs", [])
        chunks = self.signals.get("ai_chunks", [])
        bursts = self.signals.get("bursts", [])
        pauses = self.signals.get("pauses", [])

        for seg in self.segments:
            seg_facts: Dict[str, Any] = {
                "minute_start": seg.minute_start,
                "minute_end": seg.minute_end,
                "duration_s": max(int((seg.t_end - seg.t_start) / 1000), 1)
            }

            if seg.type == "ai":
                s_reqs = [q for q in requests if seg.t_start <= q.get("t", 0) <= seg.t_end]
                s_chunks = [c for c in chunks if seg.t_start <= c.get("t_insert", 0) <= seg.t_end]
                s_runs = [r for r in runs if seg.t_start <= r.get("t", 0) <= seg.t_end]

                seg_facts["n_requests"] = len(s_reqs)
                seg_facts["request_codes"] = [q.get("code") for q in s_reqs if q.get("code")]
                seg_facts["request_groups"] = [q.get("group") for q in s_reqs if q.get("group")]
                seg_facts["flag_error"] = [bool(q.get("flag_error")) for q in s_reqs]
                seg_facts["flag_task"] = [bool(q.get("flag_task")) for q in s_reqs]
                seg_facts["flag_own_code"] = [bool(q.get("flag_own_code")) for q in s_reqs]
                seg_facts["context"] = s_reqs[0].get("context") if s_reqs else None
                seg_facts["after_error"] = s_reqs[0].get("after_error", False) if s_reqs else False

                seg_facts["response_has_code"] = any(q.get("response", {}).get("has_code") for q in s_reqs) if s_reqs else False
                seg_facts["response_code_lines"] = sum(q.get("response", {}).get("code_lines", 0) for q in s_reqs) if s_reqs else 0

                seg_facts["insertions"] = [
                    {
                        "t": c.get("t_insert", 0),
                        "lines": c.get("lines_end", c.get("lines", 0)),
                        "match_level": c.get("match_level", "verbatim"),
                        "src": c.get("src", "ai_insert")
                    }
                    for c in s_chunks
                ]

                # Wait before insert
                if s_reqs and s_chunks:
                    r_end = s_reqs[0].get("response", {}).get("t_end", s_reqs[0].get("t", 0))
                    seg_facts["wait_before_insert_s"] = max(int((s_chunks[0].get("t_insert", 0) - r_end) / 1000), 0)
                else:
                    seg_facts["wait_before_insert_s"] = None

                seg_facts["modified_before_run"] = s_chunks[0].get("D1", False) if s_chunks else False
                seg_facts["run_outcome"] = s_runs[0].get("outcome") if s_runs else None

            elif seg.type == "debug":
                s_runs = [r for r in runs if seg.t_start <= r.get("t", 0) <= seg.t_end]
                seg_facts["n_runs"] = len(s_runs)
                if s_runs:
                    seg_facts["signature"] = s_runs[0].get("signature") or s_runs[0].get("error_type", "lỗi")
                    seg_facts["error_type"] = s_runs[0].get("error_type", "Error")
                else:
                    seg_facts["signature"] = "Error"
                    seg_facts["error_type"] = "Error"

            elif seg.type == "write":
                s_runs = [r for r in runs if seg.t_start <= r.get("t", 0) <= seg.t_end]
                s_bursts = [b for b in bursts if seg.t_start <= b.get("t", 0) <= seg.t_end]
                seg_facts["n_runs"] = len(s_runs)
                seg_facts["run_outcomes"] = [r.get("outcome") for r in s_runs]
                seg_facts["bursts"] = s_bursts
                seg_facts["net_lines"] = max(int(len(seg.events) / 8), 5)

            elif seg.type == "pause":
                matching_pauses = [p for p in pauses if p.get("start") <= seg.t_start and p.get("end") >= seg.t_end]
                if matching_pauses:
                    p = matching_pauses[0]
                    seg_facts["tier"] = p.get("tier", "vua")
                    seg_facts["opener"] = p.get("opener", "typing")
                    seg_facts["deleted_lines"] = p.get("deleted_lines", 0)
                    seg_facts["follower"] = p.get("follower", "typing")

            seg.facts = seg_facts

    def _evaluate_asks(self, facts: Dict[str, Any]) -> Tuple[List[AskItem], str, Dict[str, Any]]:
        """
        Evaluates Ask rules DH1 - DH5 strictly per Spec 04 Section 3.
        Filters and selects candidates based on priority_order and max_items (3).
        """
        candidates: List[AskItem] = []
        not_chosen: List[Dict[str, Any]] = []

        retained_chunks = facts.get("retained_chunks", [])
        bursts = facts.get("bursts", [])
        requests = self.signals.get("requests", [])
        sig_threads = self.signals.get("threads", [])
        fix_loops = self.signals.get("fix_loops", [])
        last_run = facts.get("last_run")

        dh1_min_lines = self.params.get("asks.dh1_min_lines", 5)

        # 3.1 DH1: Retained AI code without verification traces besides run
        for c in retained_chunks:
            lines = c.get("lines_end", c.get("lines", 0))
            d1 = c.get("D1", False)
            d4 = bool(c.get("D4"))
            d5 = bool(c.get("D5"))
            d3 = c.get("D3")
            d3_active = False
            if d3 and isinstance(d3, dict) and d3.get("until_end", 0) > 0:
                d3_active = True
            elif isinstance(d3, int) and d3 > 0:
                d3_active = True

            if lines >= dh1_min_lines and not d1 and not d4 and not d5 and not d3_active:
                m_ins = self.to_min(c.get("t_insert", 0))
                m_resp = m_ins  # response time
                seg = self._find_segment_for_time(c.get("t_insert", 0))
                seg_id = seg.id if seg else "D01"

                # Check if funcs has exactly one function
                funcs = c.get("funcs", [])
                func_name = funcs[0] if (funcs and len(funcs) == 1) else None
                func_str = f" (hàm `{func_name}`)" if func_name else ""
                target_name = f"hàm `{func_name}`" if func_name else "đoạn code này"

                match_level = c.get("match_level", "verbatim")
                src = c.get("src", "ai_insert")

                # Match wording
                if match_level == "verbatim":
                    match_wording = f"trùng nguyên văn câu trả lời AI ở phút {m_resp}"
                elif match_level == "close":
                    match_wording = f"gần như trùng câu trả lời AI ở phút {m_resp}"
                else:
                    match_wording = f"chèn từ câu trả lời AI ở phút {m_resp}"

                # Run after insert check
                d2 = c.get("D2")
                if d2:
                    run_wording = "không sửa trước khi chạy"
                else:
                    run_wording = "không có lần chạy nào sau khi chèn"

                fact_str = (f"đoạn {lines} dòng{func_str} chèn ở phút {m_ins}, {match_wording}, "
                            f"{run_wording}, không có lần sửa hay câu hỏi AI nào về nó về sau, còn nguyên ở cuối buổi")
                question_str = f"nhờ em lần theo một đầu vào cụ thể qua {target_name}, và em sẽ sửa gì nếu yêu cầu đổi một chút"
                alts = [
                    "em có thể đã đọc kỹ câu trả lời trước khi chèn",
                    "em có thể đã biết mình định viết gì và dùng AI để viết nhanh hơn",
                    "đoạn code có thể đúng ngay nên không cần sửa"
                ]

                candidates.append(AskItem(
                    ask_id="H1", rule="DH1",
                    title="Đoạn code AI được giữ lại mà ngoài việc chạy không có dấu vết kiểm",
                    fact_text=fact_str, question=question_str, alternatives=alts,
                    priority=1, magnitude=float(lines), segment_ids=[seg_id],
                    sources=[c.get("lineage", f"c_{m_ins}")]
                ))

        # DH1 for external paste bursts
        for b in bursts:
            if b.get("src") in ["paste_external", "paste_unknown"] and b.get("match_level") not in ["verbatim", "close"]:
                b_lines = b.get("lines", 0)
                if b_lines >= dh1_min_lines and not b.get("modified_before_first_run", False):
                    m_b = self.to_min(b.get("t", 0))
                    seg = self._find_segment_for_time(b.get("t", 0))
                    seg_id = seg.id if seg else "D01"
                    fact_str = f"đoạn {b_lines} dòng dán vào ở phút {m_b}, không sửa trước khi chạy, còn nguyên ở cuối buổi"
                    question_str = "nhờ em lần theo một đầu vào cụ thể qua đoạn code này, và em sẽ sửa gì nếu yêu cầu đổi một chút"
                    alts = [
                        "đoạn code có thể là code em tự viết từ trước",
                        "đoạn code có thể đúng ngay nên không cần sửa"
                    ]
                    candidates.append(AskItem(
                        ask_id="H1", rule="DH1",
                        title="Đoạn code dán từ ngoài được giữ nguyên",
                        fact_text=fact_str, question=question_str, alternatives=alts,
                        priority=1, magnitude=float(b_lines), segment_ids=[seg_id],
                        sources=[b.get("event_id", f"b_{m_b}")]
                    ))

        # 3.2 DH2: Stuck on repeated error in AI code or AI related
        ai_insert_ts = [c.get("t_insert", 0) for c in retained_chunks]
        ai_req_ts = [q.get("t", 0) for q in requests]

        def is_ai_related(t_start: int, t_end: int) -> bool:
            return any(t_start <= t <= t_end for t in (ai_insert_ts + ai_req_ts))

        for th in sig_threads:
            if th.get("repeated"):
                th_runs = th.get("runs", [])
                if len(th_runs) >= 2:
                    t_first = th_runs[0].get("t", 0)
                    t_last = th_runs[-1].get("t", 0)
                    if is_ai_related(t_first - 60000, t_last + 60000):
                        m_a = self.to_min(t_first)
                        m_b = max(self.to_min(t_last), m_a)
                        time_span = f"phút {m_a}" if m_a == m_b else f"phút {m_a}–{m_b}"
                        n_runs = len(th_runs)
                        err_type = th.get("signature") or th_runs[0].get("error_type", "lỗi")

                        resolved_at = th.get("resolved_at")
                        if resolved_at:
                            m_res = max(self.to_min(resolved_at), m_b)
                            res_str = f", gỡ được ở phút {m_res}"
                        else:
                            res_str = ", chưa gỡ ở cuối buổi"

                        has_ai_during = any(t_first <= qt <= t_last for qt in ai_req_ts)
                        ai_str = ", có hỏi AI" if has_ai_during else ""

                        fact_str = f"{time_span}, {n_runs} lần chạy liên tiếp cùng lỗi `{err_type}`{res_str}{ai_str}"

                        if resolved_at:
                            question_str = "lỗi đó nghĩa là gì, em đã thử những gì, và em gỡ được bằng cách nào"
                        else:
                            question_str = "lỗi đó nghĩa là gì, em đã thử những gì, và em nghĩ vì sao chưa gỡ được"

                        alts = [
                            "em có thể đang thử từng giả thuyết một",
                            "em có thể chạy lại để xem chương trình chạy thế nào"
                        ]
                        if all(b == "major" for b in th.get("between_labels", [])):
                            alts[1] = "mỗi lần chạy em sửa một chỗ khác nhau"

                        seg = self._find_segment_for_time(t_first)
                        seg_id = seg.id if seg else "D02"

                        candidates.append(AskItem(
                            ask_id="H2", rule="DH2",
                            title="Kẹt ở một lỗi trong phần code AI",
                            fact_text=fact_str, question=question_str, alternatives=alts,
                            priority=2, magnitude=float(n_runs), segment_ids=[seg_id],
                            sources=[r.get("id", f"r_{i}") for i, r in enumerate(th_runs)]
                        ))

        # 3.3 DH3: AI Fix Loops
        for loop in fix_loops:
            m_s = self.to_min(loop.get("start_t", 0))
            m_e = max(self.to_min(loop.get("end_t", 0)), m_s)
            time_span = f"phút {m_s}" if m_s == m_e else f"phút {m_s}–{m_e}"
            cycles = loop.get("cycles", 2)
            seg = self._find_segment_for_time(loop.get("start_t", 0))
            seg_id = seg.id if seg else "D03"

            fact_str = f"{time_span}, {cycles} yêu cầu gỡ lỗi liên tiếp, lỗi vẫn còn sau mỗi lần chạy"
            question_str = "em đang định làm gì với đoạn code đó, và em hiểu nguyên nhân của lỗi là gì"
            alts = [
                "các câu trả lời có thể đang giúp em thu hẹp chỗ lỗi",
                "quy trình chép, chạy, gặp lỗi rồi sửa có thể phù hợp với quy định của môn"
            ]

            candidates.append(AskItem(
                ask_id="H3", rule="DH3",
                title="Vòng nhờ AI sửa",
                fact_text=fact_str, question=question_str, alternatives=alts,
                priority=3, magnitude=float(cycles), segment_ids=[seg_id]
            ))

        # Consecutive D requests >= debug_persistence (3)
        if self.params.get("classifier.enabled", True):
            consec_d = 0
            d_start_idx = 0
            for idx, q in enumerate(requests):
                if q.get("group") == "D":
                    if consec_d == 0:
                        d_start_idx = idx
                    consec_d += 1
                else:
                    if consec_d >= self.params.get("ai.debug_persistence", 3):
                        q_s = requests[d_start_idx]
                        q_e = requests[idx - 1]
                        m_s = self.to_min(q_s.get("t", 0))
                        m_e = max(self.to_min(q_e.get("t", 0)), m_s)
                        time_span = f"phút {m_s}" if m_s == m_e else f"phút {m_s}–{m_e}"
                        seg = self._find_segment_for_time(q_s.get("t", 0))
                        seg_id = seg.id if seg else "D03"

                        candidates.append(AskItem(
                            ask_id="H3", rule="DH3",
                            title="Vòng nhờ AI sửa",
                            fact_text=f"{time_span}, {consec_d} yêu cầu gỡ lỗi liên tiếp",
                            question="em đang định làm gì với đoạn code đó, và em hiểu nguyên nhân của lỗi là gì",
                            alternatives=[
                                "các câu trả lời có thể đang giúp em thu hẹp chỗ lỗi",
                                "quy trình chép, chạy, gặp lỗi rồi sửa có thể phù hợp với quy định của môn"
                            ],
                            priority=3, magnitude=float(consec_d), segment_ids=[seg_id]
                        ))
                    consec_d = 0

        # 3.4 DH4: Starting exam with task prompt sent to AI
        if requests:
            q1 = requests[0]
            if q1.get("context") == "start" and q1.get("flag_task"):
                m1 = self.to_min(q1.get("t", 0))
                # Check for matching burst or insert in same ai segment
                matching_chunks = [c for c in retained_chunks if c.get("request_id") == q1.get("request_id") or c.get("t_insert", 0) <= q1.get("t", 0) + 300000]
                if matching_chunks:
                    c0 = matching_chunks[0]
                    m2 = max(self.to_min(c0.get("t_insert", 0)), m1)
                    c_lines = c0.get("lines_end", c0.get("lines", 0))
                    seg = self._find_segment_for_time(q1.get("t", 0))
                    seg_id = seg.id if seg else "D01"

                    fact_str = (f"phút {m1}, yêu cầu đầu tiên gửi AI chứa đề bài, trước khi tự viết dòng code nào, "
                                f"và câu trả lời được chèn thành đoạn {c_lines} dòng ở phút {m2}")
                    question_str = "nếu không có AI, em sẽ bắt đầu bài này thế nào"
                    alts = [
                        "đây là cách bắt đầu phổ biến và có thể phù hợp với quy định của môn",
                        "em có thể đã lên kế hoạch trước khi hỏi"
                    ]
                    candidates.append(AskItem(
                        ask_id="H4", rule="DH4",
                        title="Bắt đầu bài bằng đề bài gửi AI",
                        fact_text=fact_str, question=question_str, alternatives=alts,
                        priority=4, magnitude=float(c_lines), segment_ids=[seg_id]
                    ))

        # 3.5 DH5: AI code inserted/modified after last run
        if last_run:
            lr_t = last_run.get("t_end", last_run.get("t", 0))
            unrun_lines = 0
            unrun_m2 = 0
            for c in retained_chunks:
                t_ins = c.get("t_insert", 0)
                if t_ins > lr_t:
                    unrun_lines += c.get("lines_end", c.get("lines", 0))
                    unrun_m2 = self.to_min(t_ins)

            dh5_min = self.params.get("asks.dh5_unrun_lines", 5)
            if unrun_lines >= dh5_min:
                m_lr = self.to_min(last_run.get("t", 0))
                seg = self._find_segment_for_time(last_run.get("t", 0))
                seg_id = seg.id if seg else "D09"
                fact_str = f"sau lần chạy cuối ở phút {m_lr}, có {unrun_lines} dòng code từ AI được chèn hoặc sửa mà không chạy lại, chèn ở phút {unrun_m2}"
                question_str = "em đã kiểm đoạn này bằng cách nào"
                alts = [
                    "em có thể đã hết giờ",
                    "em có thể đã đọc kỹ đoạn code trước khi chèn"
                ]
                candidates.append(AskItem(
                    ask_id="H5", rule="DH5",
                    title="Code AI chèn sau lần chạy cuối",
                    fact_text=fact_str, question=question_str, alternatives=alts,
                    priority=5, magnitude=float(unrun_lines), segment_ids=[seg_id]
                ))

        # 3.6 Selection and sorting per Spec 04 Section 3.6
        priority_order = self.params.get("asks.priority_order", ["DH1", "DH3", "DH2", "DH4", "DH5"])

        def get_rank(item: AskItem) -> int:
            try:
                return priority_order.index(item.rule)
            except ValueError:
                return 99

        # Sort: rank ascending, magnitude descending
        candidates.sort(key=lambda c: (get_rank(c), -c.magnitude))

        max_items = self.params.get("asks.max_items", 3)
        chosen: List[AskItem] = []
        chosen_segment_ids: Set[str] = set()

        for cand in candidates:
            if len(chosen) >= max_items:
                not_chosen.append({"ask": cand.to_dict(), "reason": "cap_reached"})
                continue

            # Check duplicate segment_ids with higher rank candidate
            overlap = False
            for s_id in cand.segment_ids:
                if s_id in chosen_segment_ids:
                    overlap = True
                    break

            if overlap:
                not_chosen.append({"ask": cand.to_dict(), "reason": "duplicate_segment"})
                continue

            chosen.append(cand)
            for s_id in cand.segment_ids:
                chosen_segment_ids.add(s_id)

        # Assign final IDs H1, H2, H3
        for idx, item in enumerate(chosen, 1):
            item.id = f"H{idx}"

        # 3.7 DH0: Fixed pedagogical suggestion
        dh0 = ("Gợi ý: hỏi em tự kể đã dùng AI vào những việc gì và đã kiểm phần code AI giữ lại bằng cách nào, "
               "rồi cùng xem lại phần code AI và dòng thời gian.")
        if not requests and not retained_chunks:
            dh0 = ("Gợi ý: log của IDE không cho thấy việc dùng AI. "
                   "Có thể hỏi em có dùng AI ở ngoài IDE không, và dùng vào việc gì.")

        asks_report = {
            "chosen": [a.to_dict() for a in chosen],
            "not_chosen": not_chosen,
            "dh0": dh0
        }

        return chosen, dh0, asks_report

    def _find_segment_for_time(self, t: int):
        for s in self.segments:
            if s.t_start <= t <= s.t_end:
                return s
        return self.segments[0] if self.segments else None
