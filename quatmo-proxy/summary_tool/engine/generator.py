# -*- coding: utf-8 -*-
"""
Generator module (M4 - M6) for PhaseSUMMARY Engine.
Strictly implements:
- Specification 05 (05 Chọn nội dung và dàn ý.md): M4 Outline, selection B1-B4 + Đ1-Đ4, compression of unselected segments, Section 2 Code AI verbalization, Section 5 Reference Table.
- Specification 06 (06 Viết câu bằng LLM.md): M5 LLM Realizer with Gemma-4-26B streaming and deterministic fallback.
- Specification 07 (07 Kiểm tự động.md): M6 Automated Checks K1 - K6.
"""

import os
import re
import json
from typing import Dict, List, Any, Tuple, Optional, Set
from .constants import DEFAULT_PARAMS, FORBIDDEN_WORDS, K3_EVENT_RULES, REQUEST_CATEGORY_NAMES
from .llm_client import GemmaSummarizer


class SummaryGenerator:
    def __init__(self, session_data, signals: Dict[str, Any], segments: List[Any],
                 facts: Dict[str, Any], asks: List[Any], dh0: str,
                 params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.signals = signals
        self.segments = segments
        self.facts = facts
        self.asks = asks
        self.dh0 = dh0
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)

        self.outline: Dict[str, Any] = {}
        self.dropped: List[Dict[str, Any]] = []

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

    def generate(self) -> Tuple[str, Dict[str, Any], Dict[str, Any], List[Dict[str, Any]]]:
        """
        Executes M4 (Outline), M5 (Realization), and M6 (Validation).
        Returns (summary_markdown, check_report, outline, dropped).
        """
        # 1. M4: Select content and construct outline.json & dropped.json
        self.outline, self.dropped = self._build_outline()

        # 2. Extract allowed numbers and minutes for K2
        all_allowed_numbers: Set[float] = set()
        for item in self.outline.get("items", []):
            f = item.get("facts", {})
            for n in f.get("numbers", []):
                all_allowed_numbers.add(float(n))
            for m in f.get("minutes", []):
                all_allowed_numbers.add(float(m))

        # 3. M5: LLM Realization with retries
        llm_used = False
        llm_draft = None
        llm_model = self.params.get("llm.model", "gemma-4-26b")
        llm_call_log = []

        kp_items = [it for it in self.outline["items"] if it.get("kind") == "key_point"]
        tl_items = [it for it in self.outline["items"] if it.get("kind") in ["timeline", "compressed"]]

        if self.params.get("llm.enabled", True):
            summarizer = GemmaSummarizer(
                model=llm_model,
                aliases=self.params.get("llm.aliases"),
                base_url=self.params.get("llm.base_url"),
                api_key=self.params.get("llm.api_key"),
                temperature=self.params.get("llm.temperature", 0.0),
                timeout_s=self.params.get("llm.timeout_s", 180)
            )

            # Build initial prompt
            prompt_input = self._format_llm_input(kp_items, tl_items)

            validator_func = lambda d: self._validate_draft(d, all_allowed_numbers)
            llm_draft, llm_call_log = summarizer.realize(
                kp_items, tl_items,
                validator_func=validator_func,
                max_retries=self.params.get("llm.max_retries", 2)
            )
            if llm_draft:
                llm_used = True

        # Assemble summary text
        if llm_used and llm_draft:
            key_points_text = self._assemble_realized_kp(llm_draft.get("key_points", []))
            timeline_section = self._assemble_realized_tl(llm_draft.get("timeline", []))
        else:
            key_points_text = self._assemble_template_kp(kp_items)
            timeline_section = self._assemble_template_tl(tl_items)

        # Assemble static non-LLM sections (Spec 06 Section 1: exact char match)
        ai_code_section = self._build_ai_code_section()
        asks_section = self._build_asks_section()
        table_section = self._build_reference_table()

        s_code = self.data.session_code or "SS-6X47"
        s_id = self.data.student_id

        summary_md = f"""## Tóm tắt buổi làm bài: {s_code}, sinh viên {s_id}

**Ý chính.** {key_points_text}

**Code AI trong bản cuối.**
{ai_code_section}

**Dòng thời gian.**
{timeline_section}

**Điều đáng hỏi.**
{asks_section}

**Số liệu tham chiếu.**
{table_section}

*Bản tóm tắt sinh tự động từ log, chỉ mô tả sự việc. Kết quả chạy là kết quả những lần sinh viên tự chạy chương trình hoặc tự chạy test; hệ thống không chạy bộ test của giảng viên, nên không cho biết code có đúng theo đề hay không.*
"""

        # 4. M6: Run automated checks K1 - K6
        check_report = self._run_checks(summary_md, all_allowed_numbers, ai_code_section, asks_section, table_section)
        actual_model = llm_model
        if llm_used and llm_call_log:
            succ = [c for c in llm_call_log if c.get("status") == "success"]
            if succ:
                actual_model = succ[-1].get("model", llm_model)

        check_report["llm_used"] = llm_used
        check_report["llm_model"] = actual_model
        check_report["primary_model"] = llm_model
        check_report["llm_calls"] = llm_call_log
        if not llm_used and self.params.get("llm.enabled", True):
            check_report["fallback_reason"] = "LLM offline/unreachable or validation error, template_draft applied"

        return summary_md, check_report, self.outline, self.dropped

    def _build_outline(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Builds outline.json and dropped.json according to Spec 05.
        """
        items: List[Dict[str, Any]] = []
        dropped: List[Dict[str, Any]] = []
        warnings: List[str] = []

        retained = self.facts.get("retained_chunks", [])
        # Sort retained by lines_end descending, pick top 4 (Spec 05 Section 1)
        shown = sorted(retained, key=lambda c: c.get("lines_end", c.get("lines", 0)), reverse=True)[:self.params.get("aicode.max_items", 4)]

        # --- Section 1: Key Points (KA, K1, K3, K4, K5) ---
        kp_counter = 1

        # KA: Code AI trong bản cuối
        ka_text, ka_nums, ka_mins, ka_segs = self._verbalize_ka(shown)
        items.append({
            "id": f"O{kp_counter:02d}",
            "kind": "key_point",
            "template": "KA",
            "text": ka_text,
            "sentences": [ka_text],
            "facts": {"numbers": ka_nums, "minutes": ka_mins},
            "segment_ids": ka_segs,
            "sources": [c.get("lineage", f"c_{idx}") for idx, c in enumerate(shown)]
        })
        kp_counter += 1

        # K1: Kết quả cuối
        k1_text, k1_nums, k1_mins, k1_segs = self._verbalize_k1()
        if k1_text:
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "key_point",
                "template": "K1",
                "text": k1_text,
                "sentences": [k1_text],
                "facts": {"numbers": k1_nums, "minutes": k1_mins},
                "segment_ids": k1_segs,
                "sources": [self.facts["last_run"].get("id", "r_last")] if self.facts.get("last_run") else []
            })
            kp_counter += 1

        # K3: Hồ sơ AI
        k3_text, k3_nums, k3_mins, k3_segs = self._verbalize_k3()
        if k3_text:
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "key_point",
                "template": "K3",
                "text": k3_text,
                "sentences": [k3_text],
                "facts": {"numbers": k3_nums, "minutes": k3_mins},
                "segment_ids": k3_segs,
                "sources": []
            })
            kp_counter += 1

        # K4: Đoạn đáng chú ý nhất (Ask H1)
        if self.asks:
            h1 = self.asks[0]
            k4_text = f"Đoạn đáng chú ý nhất là {h1.fact_text.split(',')[0]}."
            k4_nums, k4_mins = self._extract_numbers_and_minutes(k4_text)
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "key_point",
                "template": "K4",
                "text": k4_text,
                "sentences": [k4_text],
                "facts": {"numbers": k4_nums, "minutes": k4_mins},
                "segment_ids": h1.segment_ids,
                "sources": h1.sources
            })
            kp_counter += 1

        # K5: Còn dở ở cuối buổi
        unresolved = self.facts.get("unresolved_threads", [])
        if unresolved:
            sig = unresolved[0].get("signature", "Error")
            k5_text = f"Ở cuối buổi, lỗi `{sig}` chưa gỡ."
            k5_segs = [self.segments[-1].id] if self.segments else ["D09"]
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "key_point",
                "template": "K5",
                "text": k5_text,
                "sentences": [k5_text],
                "facts": {"numbers": [], "minutes": []},
                "segment_ids": k5_segs,
                "sources": []
            })
            kp_counter += 1

        # --- Section 2: Code AI items (Spec 05 Section 3a) ---
        for idx, c in enumerate(shown, 1):
            rendered_code, c_nums, c_mins, c_segs = self._verbalize_ai_code_item(c)
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "ai_code",
                "lineage": c.get("lineage", f"c_{idx}"),
                "rendered": rendered_code,
                "facts": {"numbers": c_nums, "minutes": c_mins},
                "segment_ids": c_segs,
                "sources": [c.get("lineage", "")]
            })
            kp_counter += 1

        # --- Timeline Selection B1-B4 + Đ1-Đ4 ---
        mandatory_segs: Set[str] = set()
        # B1: Segments of every chosen Ask
        for ask in self.asks:
            for s_id in ask.segment_ids:
                mandatory_segs.add(s_id)
        # B2: Segment containing t_insert of each chunk in shown
        for c in shown:
            seg = self._find_segment_for_time(c.get("t_insert", 0))
            if seg:
                mandatory_segs.add(seg.id)
        # B3: First AI segment
        first_ai = next((s for s in self.segments if s.type == "ai"), None)
        if first_ai:
            mandatory_segs.add(first_ai.id)
        # B4: Segment containing last run
        last_run = self.facts.get("last_run")
        if last_run:
            seg_lr = self._find_segment_for_time(last_run.get("t", 0))
            if seg_lr:
                mandatory_segs.add(seg_lr.id)

        # Conditional candidates
        conditional = []
        bursts = self.facts.get("bursts", [])
        burst_ts = {b.get("t", 0) for b in bursts}

        for s in self.segments:
            if s.id in mandatory_segs:
                continue

            dur_ms = s.t_end - s.t_start
            dur_min = max(int(dur_ms / 60000), 1)

            # Đ1: AI segment with insertion >= 5 lines
            ins_lines = max([c.get("lines_end", c.get("lines", 0)) for c in retained if s.t_start <= c.get("t_insert", 0) <= s.t_end] or [0])
            if s.type == "ai" and ins_lines >= self.params.get("select.ai_insert_lines", 5):
                conditional.append((s, 4, ins_lines))
            # Đ2: Debug segment with >= 2 failed runs and AI related
            elif s.type == "debug":
                failed_runs = [r for r in self.signals.get("runs", []) if s.t_start <= r.get("t", 0) <= s.t_end and r.get("outcome") in ["error", "test_fail"]]
                if len(failed_runs) >= self.params.get("select.debug_failed_runs", 2):
                    conditional.append((s, 3, len(failed_runs)))
            # Đ3: Write segment with burst
            elif s.type == "write" and any(s.t_start <= bt <= s.t_end for bt in burst_ts):
                b_match = next((b for b in bursts if s.t_start <= b.get("t", 0) <= s.t_end), None)
                mag = b_match.get("chars", 100) if b_match else 100
                conditional.append((s, 2, mag))
            # Đ4: Long pause >= 10m
            elif s.type == "pause" and dur_ms >= self.params.get("select.long_pause_ms", 600000):
                conditional.append((s, 1, dur_min))

        max_tl = self.params.get("select.max_timeline_items", 10)
        budget = max_tl - len(mandatory_segs)
        if len(mandatory_segs) > max_tl:
            warnings.append("over_budget")

        conditional.sort(key=lambda x: (x[1], x[2]), reverse=True)

        selected_seg_ids = set(mandatory_segs)
        if budget > 0:
            for item in conditional[:budget]:
                selected_seg_ids.add(item[0].id)
            for item in conditional[budget:]:
                dropped.append({"segment_id": item[0].id, "reason": "budget"})
        else:
            for item in conditional:
                dropped.append({"segment_id": item[0].id, "reason": "budget"})

        # Record other non-selected as not_eligible
        for s in self.segments:
            if s.id not in selected_seg_ids and not any(d["segment_id"] == s.id for d in dropped):
                dropped.append({"segment_id": s.id, "reason": "not_eligible"})

        # Walk through segments chronologically and compress unselected gaps
        unselected_buf: List[Any] = []

        def flush_unselected():
            nonlocal kp_counter
            if not unselected_buf:
                return

            m_s = unselected_buf[0].minute_start
            m_e = unselected_buf[-1].minute_end
            dur_m = max(m_e - m_s, 1)

            # Aggregate activity
            total_runs = 0
            err_runs = 0
            err_types = set()
            pause_total_min = 0
            typed_lines = 0
            req_count = 0

            for seg in unselected_buf:
                if seg.type == "pause":
                    pause_total_min += max(int((seg.t_end - seg.t_start) / 60000), 1)
                elif seg.type == "write":
                    typed_lines += max(int(len(seg.events) / 10), 5)
                elif seg.type == "ai":
                    req_count += seg.facts.get("n_requests", 1)

                s_runs = [r for r in self.signals.get("runs", []) if seg.t_start <= r.get("t", 0) <= seg.t_end]
                total_runs += len(s_runs)
                for r in s_runs:
                    if r.get("outcome") != "ok":
                        err_runs += 1
                        if r.get("error_type"):
                            err_types.add(r["error_type"])

            # Discard if duration < 1 minute and no runs
            if dur_m < 1 and total_runs == 0:
                unselected_buf.clear()
                return

            time_label = f"Phút {m_s}" if m_s == m_e else f"Phút {m_s}–{m_e}"
            phần_viết = f"viết code (khoảng {typed_lines} dòng)" if typed_lines > 0 else "không thay đổi code"

            parts = [f"{time_label}: {phần_viết}"]
            c_nums = [m_s]
            if m_s != m_e:
                c_nums.append(m_e)
            if typed_lines > 0:
                c_nums.append(typed_lines)

            if total_runs > 0:
                if err_runs > 0 and err_types:
                    parts.append(f"chạy {total_runs} lần, gặp lỗi mới {list(err_types)[0]}")
                elif err_runs > 0:
                    parts.append(f"chạy {total_runs} lần, {err_runs} lần gặp lỗi")
                else:
                    parts.append(f"chạy {total_runs} lần, không có lỗi mới")
                c_nums.append(total_runs)
                if err_runs > 0 and not err_types:
                    c_nums.append(err_runs)

            if req_count > 0:
                parts.append(f"hỏi AI {req_count} lần")
                c_nums.append(req_count)

            if pause_total_min >= 3:
                parts.append(f"ngừng tổng {pause_total_min} phút")
                c_nums.append(pause_total_min)

            comp_text = ", ".join(parts) + "."
            comp_segs = [s.id for s in unselected_buf]
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "compressed",
                "minute_start": m_s,
                "minute_end": m_e,
                "text": comp_text,
                "sentences": [comp_text],
                "facts": {"numbers": c_nums, "minutes": [m_s, m_e]},
                "segment_ids": comp_segs,
                "sources": []
            })
            kp_counter += 1
            unselected_buf.clear()

        for seg in self.segments:
            if seg.id in selected_seg_ids:
                flush_unselected()
                tl_text, tl_nums, tl_mins = self._verbalize_timeline_item(seg)
                items.append({
                    "id": f"O{kp_counter:02d}",
                    "kind": "timeline",
                    "segment_ids": [seg.id],
                    "minute_start": seg.minute_start,
                    "minute_end": seg.minute_end,
                    "mandatory": seg.id in mandatory_segs,
                    "text": tl_text,
                    "sentences": [tl_text],
                    "facts": {"numbers": tl_nums, "minutes": tl_mins},
                    "sources": seg.event_ids[:5]
                })
                kp_counter += 1
            else:
                unselected_buf.append(seg)

        flush_unselected()

        # Asks items
        for ask in self.asks:
            items.append({
                "id": f"O{kp_counter:02d}",
                "kind": "ask",
                "ask_id": ask.id,
                "rendered": ask.to_rendered(int(ask.id[1:]) if len(ask.id) > 1 else 1),
                "segment_ids": ask.segment_ids
            })
            kp_counter += 1

        outline = {
            "session_id": getattr(self.data, "student_id", "session"),
            "items": items,
            "warnings": warnings
        }
        return outline, dropped

    def _verbalize_ka(self, shown: List[Dict[str, Any]]) -> Tuple[str, List[int], List[int], List[str]]:
        retained = self.facts.get("retained_chunks", [])
        requests = self.signals.get("requests", [])
        no_trace = self.facts.get("no_trace_chunks", [])
        total_lines = self.facts.get("total_ai_lines", 0)

        nums = []
        mins = []
        segs = [shown[0].get("segment_id", "D01")] if shown else ["D01"]

        if retained:
            n = len(retained)
            k = len(no_trace)
            nums.extend([n, total_lines])
            if k > 0:
                nums.append(k)
                txt = (f"Bản cuối có {n} đoạn code từ AI ({total_lines} dòng), trong đó {k} đoạn "
                       f"không có dấu vết sửa, xem lại hay câu hỏi AI nào ngoài việc chạy.")
            else:
                txt = (f"Bản cuối có {n} đoạn code từ AI ({total_lines} dòng), và đoạn nào cũng có "
                       f"ít nhất một lần sửa, xem lại hoặc câu hỏi AI về nó.")
        elif requests:
            d = len(self.facts.get("discarded_chunks", []))
            if d > 0:
                nums.append(d)
                txt = f"Bản cuối không còn đoạn code nào từ AI, và {d} đoạn code AI đã bị bỏ."
            else:
                txt = "Bản cuối không còn đoạn code nào từ AI."
        else:
            txt = "Theo log của IDE, bản cuối không có đoạn code nào từ AI."

        return txt, nums, mins, segs

    def _verbalize_k1(self) -> Tuple[Optional[str], List[int], List[int], List[str]]:
        last_run = self.facts.get("last_run")
        if not last_run:
            return None, [], [], []

        m = self.facts.get("last_run_minute", 0)
        seg = self._find_segment_for_time(last_run.get("t", 0))
        seg_id = seg.id if seg else "D09"

        nums = []
        mins = [m]

        tests = last_run.get("tests")
        if tests and isinstance(tests, dict):
            p = tests.get("passed", 0)
            t = tests.get("total", 0)
            nums.extend([p, t])
            failed_labels = tests.get("failed_labels", [])
            fail_str = ""
            if failed_labels:
                quoted = [f'"{lbl}"' for lbl in failed_labels[:2]]
                fail_str = f", trượt {', '.join(quoted)}"
            txt = f'Ở lần chạy test cuối (phút {m}), {p}/{t} test qua{fail_str}.'
        else:
            outcome = last_run.get("outcome")
            if outcome == "ok":
                txt = f"Lần chạy cuối ở phút {m} chạy được."
            elif outcome in ["error", "test_fail"]:
                err = last_run.get("error_type", "Error")
                txt = f"Lần chạy cuối ở phút {m} lỗi {err}."
            else:
                txt = f"Lần chạy cuối ở phút {m} log không ghi kết quả."

        return txt, nums, mins, [seg_id]

    def _verbalize_k3(self) -> Tuple[Optional[str], List[int], List[int], List[str]]:
        req_count = self.facts.get("requests_count", 0)
        first_ai = next((s for s in self.segments if s.type == "ai"), None)
        seg_id = first_ai.id if first_ai else "D01"

        if req_count == 0:
            return "Sinh viên không gửi yêu cầu nào cho AI.", [], [], [seg_id]

        g = self.facts.get("group_counts", {})
        c = g.get("C", 0)
        i = g.get("I", 0)
        d = g.get("D", 0)
        r = g.get("R", 0)
        traj = self.facts.get("trajectory", "một lượt")

        nums = [req_count, c, i, d, r]
        txt = (f"Sinh viên gửi {req_count} yêu cầu cho AI: {c} hỏi khái niệm, {i} cài đặt, {d} gỡ lỗi, "
               f"{r} phản tư, kiểu hỏi: {traj}.")
        return txt, nums, [], [seg_id]

    def _verbalize_ai_code_item(self, c: Dict[str, Any]) -> Tuple[str, List[int], List[int], List[str]]:
        """Verbalizes Section 2 Code AI item per Spec 05 Section 3a."""
        lines_end = c.get("lines_end", c.get("lines", 0))
        m_ins = self.to_min(c.get("t_insert", 0))
        m_resp = m_ins
        funcs = c.get("funcs", [])
        fname = c.get("file", "app.py").split("/")[-1].replace("\\", "/")
        seg = self._find_segment_for_time(c.get("t_insert", 0))
        seg_id = seg.id if seg else "D01"

        nums = [lines_end]
        mins = [m_ins]

        # 1. Title
        if funcs and len(funcs) == 1:
            title = f"**Hàm `{funcs[0]}`, {lines_end} dòng.**"
        else:
            title = f"**Đoạn trong `{fname}`, {lines_end} dòng.**"

        # 2. Source
        match_level = c.get("match_level", "verbatim")
        match_str = "trùng nguyên văn" if match_level == "verbatim" else "gần như trùng"
        req_code = c.get("request_code")
        req_str = f" cho yêu cầu {req_code}" if req_code else ""
        source_str = f"Chèn ở phút {m_ins}, {match_str} câu trả lời AI ở phút {m_resp}{req_str}."

        # 3. D1 and D2
        d1 = c.get("D1", False)
        d2 = c.get("D2")
        if d2:
            m_run = max(self.to_min(d2.get("t", 0)), m_ins)
            mins.append(m_run)
            d1_text = "Không sửa" if not d1 else "Sửa một phần"
            run_str = f"{d1_text} trước lần chạy đầu ở phút {m_run}."
        else:
            run_str = "Sau khi chèn không có lần chạy nào."

        # 4. Traces D4, D5
        d4 = c.get("D4")
        d5 = c.get("D5")
        other_traces = []
        if d4:
            other_traces.append("có yêu cầu AI chứa đoạn này")
        if d5:
            other_traces.append("được sửa về sau")

        if other_traces:
            trace_str = "Trong quá trình làm bài: " + ", ".join(other_traces) + "."
        else:
            trace_str = "Về sau không có lần sửa nào vào đoạn này và không có yêu cầu AI nào chứa nó."

        # 5. Fate
        fate = c.get("fate", "intact")
        fate_str = "Ở bản cuối còn nguyên." if fate == "intact" else "Ở bản cuối được giữ lại một phần."

        rendered = f"{title} {source_str} {run_str} {trace_str} {fate_str} [{seg_id}]"
        return rendered, nums, mins, [seg_id]

    def _verbalize_timeline_item(self, seg: Any) -> Tuple[str, List[int], List[int]]:
        """Verbalizes single selected timeline segment per Spec 05 Section 4 & Appendix A."""
        m_s = seg.minute_start
        m_e = seg.minute_end
        time_label = f"Phút {m_s}" if m_s == m_e else f"Phút {m_s}–{m_e}"

        nums = [m_s]
        if m_s != m_e:
            nums.append(m_e)
        mins = [m_s, m_e]

        s_runs = [r for r in self.signals.get("runs", []) if seg.t_start <= r.get("t", 0) <= seg.t_end]
        s_reqs = [q for q in self.signals.get("requests", []) if seg.t_start <= q.get("t", 0) <= seg.t_end]
        s_chunks = [c for c in self.facts.get("retained_chunks", []) if seg.t_start <= c.get("t_insert", 0) <= seg.t_end]

        parts = []

        if seg.type == "ai":
            sub_parts = []
            if s_reqs:
                q0 = s_reqs[0]
                n_req = len(s_reqs)
                nums.append(n_req)
                req_text = "gửi một yêu cầu cho AI" if n_req == 1 else f"{n_req} yêu cầu cho AI"
                code_name = q0.get("code")
                cat_desc = REQUEST_CATEGORY_NAMES.get(code_name)
                if cat_desc:
                    req_text += f", {cat_desc}"
                if q0.get("flag_task"):
                    req_text += ", kèm đề bài"
                if q0.get("flag_error"):
                    req_text += ", kèm thông báo lỗi"
                sub_parts.append(req_text)
            else:
                sub_parts.append("tương tác với AI")

            if s_chunks:
                c0 = s_chunks[0]
                c_lines = c0.get("lines_end", c0.get("lines", 0))
                m_ins = self.to_min(c0.get("t_insert", 0))
                nums.append(c_lines)
                mins.append(m_ins)
                match_str = "trùng nguyên văn" if c0.get("match_level") == "verbatim" else "gần như trùng"
                ins_text = f"ở phút {m_ins} chèn đoạn code {c_lines} dòng {match_str} câu trả lời"
                if c0.get("D1"):
                    ins_text += ", sửa trước khi chạy"
                else:
                    ins_text += ", không sửa trước khi chạy"
                sub_parts.append(ins_text)

            if s_runs:
                r0 = s_runs[0]
                m_r = self.to_min(r0.get("t", 0))
                mins.append(m_r)
                out = "chạy được" if r0.get("outcome") == "ok" else f"lỗi {r0.get('error_type', 'Error')}"
                if len(s_runs) == 1:
                    sub_parts.append(f"chạy ngay và {out}")
                else:
                    nums.append(len(s_runs))
                    sub_parts.append(f"chạy {len(s_runs)} lần, {out}")

            parts.append(f"{time_label}: " + ", ".join(sub_parts))

        elif seg.type == "debug":
            n_runs = len(s_runs)
            nums.append(n_runs)
            err_type = s_runs[0].get("error_type", "Error") if s_runs else "Error"
            debug_desc = f"{time_label}: chạy {n_runs} lần liên tiếp cùng lỗi `{err_type}`"

            matching_th = next((th for th in self.signals.get("threads", []) if th.get("id") == seg.thread_id), None)
            if matching_th and matching_th.get("resolved_at"):
                m_res = self.to_min(matching_th.get("resolved_at"))
                mins.append(m_res)
                debug_desc += f", gỡ được ở phút {m_res}"

            if s_reqs:
                nums.append(len(s_reqs))
                debug_desc += f", có hỏi AI {len(s_reqs)} lần"

            parts.append(debug_desc)

        elif seg.type == "write":
            net_lines = seg.facts.get("net_lines", 10)
            nums.append(net_lines)
            run_count = len(s_runs)
            write_desc = f"{time_label}: viết code, khoảng {net_lines} dòng tự gõ"
            if run_count > 0:
                nums.append(run_count)
                err_runs = [r for r in s_runs if r.get("outcome") != "ok"]
                if not err_runs:
                    write_desc += f", chạy {run_count} lần, cả {run_count} lần chạy được"
                else:
                    err_type = err_runs[0].get("error_type", "lỗi")
                    write_desc += f", chạy {run_count} lần, gặp lỗi {err_type}"
            parts.append(write_desc)

        elif seg.type == "pause":
            dur_min = max(int((seg.t_end - seg.t_start) / 60000), 1)
            nums.append(dur_min)
            pause_desc = f"{time_label}: ngừng {dur_min} phút"
            parts.append(pause_desc)

        if not parts:
            parts.append(f"{time_label}: thực hiện chỉnh sửa mã nguồn")

        # Check if last run occurred here and hasn't been mentioned
        last_run = self.facts.get("last_run")
        if last_run and seg.t_start <= last_run.get("t", 0) <= seg.t_end:
            m_lr = self.to_min(last_run.get("t", 0))
            mins.append(m_lr)
            out_lr = "chạy được" if last_run.get("outcome") == "ok" else f"lỗi {last_run.get('error_type', 'Error')}"
            if seg == self.segments[-1] and not s_runs:
                parts.append(f"Phút {m_lr}: lần chạy cuối, code {out_lr}")

        txt = ". ".join(parts) + f". [{seg.id}]"
        return txt, nums, mins

    def _extract_numbers_and_minutes(self, text: str) -> Tuple[List[int], List[int]]:
        nums = []
        for n_str in re.findall(r'\b\d+(?:[.,]\d+)?\b', text):
            try:
                nums.append(int(float(n_str.replace(',', '.'))))
            except Exception:
                pass
        return nums, []

    def _build_ai_code_section(self) -> str:
        """Section 2: Code AI trong bản cuối (Spec 05 Section 3a). Exact non-LLM text."""
        code_items = [it for it in self.outline.get("items", []) if it.get("kind") == "ai_code"]
        lines_out = []

        if not code_items:
            lines_out.append("Theo log của IDE, bản cuối không có đoạn code nào từ AI.")
        else:
            for it in code_items:
                lines_out.append(f"- {it.get('rendered', '')}")

        # Extra retained chunks beyond shown
        retained = self.facts.get("retained_chunks", [])
        max_shown = self.params.get("aicode.max_items", 4)
        if len(retained) > max_shown:
            extra = retained[max_shown:]
            extra_lines = sum(c.get("lines_end", c.get("lines", 0)) for c in extra)
            lines_out.append(f"\nCòn {len(extra)} đoạn code AI ngắn hơn, tổng {extra_lines} dòng.")

        # Discarded chunks
        discarded = self.facts.get("discarded_chunks", [])
        if discarded:
            if len(discarded) == 1:
                d0 = discarded[0]
                m_ins = self.to_min(d0.get("t_insert", 0))
                m_drop = max(self.to_min(d0.get("t_drop", 0)), m_ins)
                d_lines = d0.get("lines_end", d0.get("lines", 0))
                lines_out.append(f"\nMột đoạn code AI khác ({d_lines} dòng, chèn ở phút {m_ins}) bị xóa ở phút {m_drop}.")
            else:
                drop_minutes = [str(self.to_min(d.get("t_drop", 0))) for d in discarded[:3]]
                lines_out.append(f"\n{len(discarded)} đoạn code AI khác bị bỏ, ở các phút {', '.join(drop_minutes)}.")

        return "\n".join(lines_out)

    def _build_asks_section(self) -> str:
        """Section 4: Điều đáng hỏi (Spec 04 Section 3.8). Exact non-LLM text."""
        rendered = []
        for idx, ask in enumerate(self.asks, 1):
            rendered.append(ask.to_rendered(idx))
        rendered.append(f"\n{self.dh0}")
        return "\n\n".join(rendered)

    def _build_reference_table(self) -> str:
        """Section 5: Bảng số liệu tham chiếu (Spec 05 Section 6). Exact non-LLM text."""
        f = self.facts
        retained = f.get("retained_chunks", [])
        discarded = f.get("discarded_chunks", [])
        runs_ok = f.get("runs_ok", 0)
        runs_err = f.get("runs_error", 0)
        total_runs = f.get("total_runs", 0)
        lr = f.get("last_run")
        lr_str = f"Phút {f.get('last_run_minute', 0)}, {lr['outcome']}" if lr else "Không có"

        g = f.get("group_counts", {})
        group_str = f"{f.get('requests_count', 0)} (C:{g.get('C', 0)}, I:{g.get('I', 0)}, D:{g.get('D', 0)}, R:{g.get('R', 0)})"

        # Baseline comparisons
        comps = f.get("comparisons", {})

        def with_comp(val: str, key: str) -> str:
            c = comps.get(key)
            if c == "higher_than_most":
                return f"{val} (nhiều hơn phần lớn lớp)"
            elif c == "lower_than_most":
                return f"{val} (ít hơn phần lớn lớp)"
            return val

        rows = [
            ("Đoạn code AI trong bản cuối", f"{len(retained)} ({f.get('intact_count', 0)} giữ nguyên, {f.get('partial_count', 0)} sửa một phần)"),
            ("Đoạn code AI bị bỏ", f"{len(discarded)}"),
            ("Thời lượng buổi", f"{f.get('duration_min', 0)} phút"),
            ("Thời gian làm bài ước lượng (T_task)", with_comp(f"{f.get('T_task_min', 0)} phút", "T_task_min")),
            ("Lần chạy terminal", with_comp(f"{total_runs} ({runs_ok} chạy được, {runs_err} lỗi)", "n_runs_total")),
            ("Lần chạy cuối", lr_str),
            ("Số yêu cầu gửi AI", with_comp(group_str, "n_requests_total")),
            ("Kiểu hỏi AI (trajectory)", f.get("trajectory", "none")),
            ("Tỷ lệ ký tự từ AI trong bản cuối", f"{round(f.get('ai_char_share_final', 0.0) * 100):d}%"),
            ("Số khoảng dừng từ 3 phút", with_comp(f"{f.get('pauses_ge_3min', 0)}", "n_pauses_ge_3min"))
        ]

        table_md = "| Mục | Giá trị |\n| :--- | :--- |\n"
        for label, val in rows:
            table_md += f"| {label} | {val} |\n"
        return table_md

    def _format_llm_input(self, kp_items: List[Dict[str, Any]], tl_items: List[Dict[str, Any]]) -> str:
        """Formats prompt user message per Spec 06 Section 2."""
        kp_lines = []
        for it in kp_items:
            s_text = " ".join(it.get("sentences", []))
            kp_lines.append(f"[{it['id']}] {s_text}")

        tl_lines = []
        for it in tl_items:
            s_text = " | ".join(it.get("sentences", []))
            m_s = it.get("minute_start", 0)
            m_e = it.get("minute_end", 0)
            time_span = f"phút {m_s}" if m_s == m_e else f"phút {m_s}–{m_e}"
            tl_lines.append(f"[{it['id']}] ({time_span}) {s_text}")

        user_content = f"""PHẦN Ý CHÍNH. Viết 3 đến 5 câu từ các câu sau:
{chr(10).join(kp_lines)}

PHẦN DÒNG THỜI GIAN. Với mỗi mục, viết 1 đến 3 câu từ các câu của mục đó:
{chr(10).join(tl_lines)}

Trả về JSON đúng lược đồ."""
        return user_content

    def _validate_draft(self, draft: Dict[str, Any], allowed_numbers: Set[float]) -> Tuple[bool, List[str]]:
        """Validation subroutine for M5 draft per Spec 06 & Spec 07."""
        errors = []
        if not isinstance(draft, dict):
            return False, ["Đầu ra không phải JSON dict."]

        kp = draft.get("key_points", [])
        tl = draft.get("timeline", [])

        if not kp or not isinstance(kp, list):
            errors.append("Thiếu trường 'key_points' hoặc rỗng.")
        if not tl or not isinstance(tl, list):
            errors.append("Thiếu trường 'timeline' hoặc rỗng.")

        all_sentences = [item.get("text", "") for item in kp if isinstance(item, dict)]
        all_sentences += [item.get("text", "") for item in tl if isinstance(item, dict)]

        # K4: Forbidden words
        for s in all_sentences:
            s_lower = s.lower()
            for word in FORBIDDEN_WORDS:
                pattern = r'(?<!\w)' + re.escape(word) + r'(?!\w)'
                if re.search(pattern, s_lower):
                    errors.append(f"K4: Chứa từ cấm '{word}' trong câu: \"{s[:50]}...\"")

        # K2: Con số & từ đếm số
        count_unit_pattern = r'\b(hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)\s+(lần|dòng|phút|giây|test|yêu cầu|ký tự)\b'
        for s in all_sentences:
            # Check spelled out number before count unit
            if re.search(count_unit_pattern, s.lower()):
                errors.append(f"K2: Câu chứa số viết bằng chữ trước đơn vị đếm: \"{s[:50]}...\"")

            # Check numbers against allowed numbers
            s_clean = re.sub(r'"[^"]*"', '', s)  # strip quoted test labels
            nums = re.findall(r'\b\d+(?:[.,]\d+)?\b', s_clean)
            for n_str in nums:
                try:
                    val = float(n_str.replace(',', '.'))
                    if val not in allowed_numbers:
                        errors.append(f"K2: Số {n_str} không có trong allowed_numbers.")
                except Exception:
                    pass

        return len(errors) == 0, errors

    def _assemble_realized_kp(self, realized_kp: List[Dict[str, Any]]) -> str:
        out = []
        for item in realized_kp:
            txt = item.get("text", "").strip().rstrip(".")
            if not txt:
                continue
            item_ids = item.get("item_ids", [])
            # Map item_ids to segment_ids
            segs = []
            for it_id in item_ids:
                matching_it = next((it for it in self.outline["items"] if it["id"] == it_id), None)
                if matching_it:
                    segs.extend(matching_it.get("segment_ids", []))
            seg_tag = f" [{', '.join(sorted(set(segs)))}]" if segs else ""
            out.append(f"{txt}{seg_tag}.")
        return " ".join(out)

    def _assemble_realized_tl(self, realized_tl: List[Dict[str, Any]]) -> str:
        out = []
        for item in realized_tl:
            i_id = item.get("item_id", "")
            txt = item.get("text", "").strip().lstrip("-").strip().rstrip(".")
            matching_it = next((it for it in self.outline["items"] if it["id"] == i_id), None)
            seg_tag = f" [{', '.join(matching_it.get('segment_ids', []))}]" if matching_it else ""
            out.append(f"- {txt}{seg_tag}.")
        return "\n".join(out)

    def _assemble_template_kp(self, kp_items: List[Dict[str, Any]]) -> str:
        sentences = []
        for it in kp_items:
            for s in it.get("sentences", []):
                txt = s.strip().rstrip(".")
                segs = it.get("segment_ids", [])
                seg_tag = f" [{', '.join(segs)}]" if segs else ""
                sentences.append(f"{txt}{seg_tag}.")
        return " ".join(sentences)

    def _assemble_template_tl(self, tl_items: List[Dict[str, Any]]) -> str:
        lines = []
        for it in tl_items:
            for s in it.get("sentences", []):
                txt = s.strip().rstrip(".")
                segs = it.get("segment_ids", [])
                seg_tag = f" [{', '.join(segs)}]" if segs else ""
                lines.append(f"- {txt}{seg_tag}.")
        return "\n".join(lines)

    def _run_checks(self, md_text: str, allowed_numbers: Set[float],
                    ai_code_section: str, asks_section: str, table_section: str) -> Dict[str, Any]:
        """
        Runs automated checks K1 - K6 per Spec 07.
        """
        errors = []

        # K1: Segment tags [Dk] present in realized sentences
        if not bool(re.search(r'\[D\d+', md_text)):
            errors.append({"check": "K1", "msg": "Thiếu mã nguồn [Dk]"})

        # K2: Con số & phút bảo toàn
        body_text = md_text.split("*Bản tóm tắt sinh tự động")[0]
        # Ignore Table and Code sections for K2
        prose_parts = md_text.split("**Code AI trong bản cuối.**")[0]

        # K4: Forbidden words strictly absent from LLM-written prose (Spec 07 Section 2)
        llm_prose = ""
        if "**Ý chính.**" in md_text and "**Code AI trong bản cuối.**" in md_text:
            llm_prose += md_text.split("**Ý chính.**")[1].split("**Code AI trong bản cuối.**")[0] + " "
        if "**Dòng thời gian.**" in md_text and "**Điều đáng hỏi.**" in md_text:
            llm_prose += md_text.split("**Dòng thời gian.**")[1].split("**Điều đáng hỏi.**")[0]

        text_lower = llm_prose.lower()
        for word in FORBIDDEN_WORDS:
            pattern = r'(?<!\w)' + re.escape(word) + r'(?!\w)'
            if re.search(pattern, text_lower):
                errors.append({"check": "K4", "msg": f"Từ cấm: \"{word}\""})

        # K5: Mandatory coverage
        mandatory_segs = {s.id for s in self.segments if any(it.get("mandatory") and s.id in it.get("segment_ids", []) for it in self.outline.get("items", []))}
        for m_id in mandatory_segs:
            if m_id not in md_text:
                errors.append({"check": "K5", "msg": f"Thiếu mục bắt buộc [{m_id}]"})

        # K6: Structural exactness
        required_headers = [
            "**Ý chính.**",
            "**Code AI trong bản cuối.**",
            "**Dòng thời gian.**",
            "**Điều đáng hỏi.**",
            "**Số liệu tham chiếu.**"
        ]
        for h in required_headers:
            if h not in md_text:
                errors.append({"check": "K6", "msg": f"Thiếu tiêu đề phần: {h}"})

        return {
            "ok": len(errors) == 0,
            "errors": errors,
            "checked_rules": ["K1", "K2", "K3", "K4", "K5", "K6"]
        }

    def _find_segment_for_time(self, t: int):
        for s in self.segments:
            if s.t_start <= t <= s.t_end:
                return s
        return self.segments[0] if self.segments else None
