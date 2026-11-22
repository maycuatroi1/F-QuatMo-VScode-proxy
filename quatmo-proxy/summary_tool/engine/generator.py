# -*- coding: utf-8 -*-
"""
Generator module (M4, M5, M6) for PhaseSUMMARY Engine.
Implements:
- Spec 05 (Chọn nội dung, ý chính, dàn ý và bảng số liệu - M4, Version 3.0):
  Mandatory (B1-B4) + Conditional (Đ1-Đ5) segment selection, compression of unselected segments,
  Key Points (KC1 - KC6), 12-row Reference Table, Retained AI Code (D1-D5), Outline & Dropped JSON.
- Spec 06 (Viết câu bằng LLM và ghép bản tóm tắt - M5, Version 3.0):
  GemmaSummarizer invocation with retry feedback loop and template_draft fallback.
  Assembling 4-section summary.md (Ý chính, Dòng thời gian, Số liệu tham chiếu, Đoạn code AI trong bản cuối).
- Spec 07 (Kiểm tự động - M6, Version 3.0):
  Full K1, K2, K3, K4, K5, K6 automated checks on per-sentence item provenance.
"""

import re
from typing import Dict, List, Any, Tuple, Optional, Set
from .constants import DEFAULT_PARAMS, FORBIDDEN_WORDS, TASK_DIRS, minute_label, minute_start_ms
from .llm_client import GemmaSummarizer


def _split_sentences(text: str) -> List[str]:
    """
    Spec 07 Section 1:
    Split timeline text into sentences at '.', ';', '!', '?' followed by whitespace and uppercase,
    without splitting decimals (3.5) or minute ranges (22–26).
    """
    if not text or not text.strip():
        return []
    parts = re.split(r'(?<=[.!?;])\s+(?=[A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ])', text.strip())
    return [p.strip() for p in parts if p.strip()]


def _display_file(path: Optional[str]) -> str:
    """Tên file trong câu: file trong thư mục bài giữ đường dẫn (`Q1/app.py`), còn lại chỉ tên file."""
    parts = (path or "app.py").replace("\\", "/").split("/")
    return "/".join(parts) if parts[0] in TASK_DIRS else parts[-1]


def _fmt_wait(wait_s: int) -> str:
    """Khoảng chờ sau khi câu trả lời AI xong: dưới 2 phút ghi giây, từ 2 phút ghi phút làm tròn."""
    return f"{wait_s} giây" if wait_s < 120 else f"khoảng {int(round(wait_s / 60.0))} phút"


def _extract_numbers_from_sentence(s: str) -> List[float]:
    """
    Spec 07 Section 2 (K2):
    Extract all numbers after removing quoted test labels ("...").
    Also ignores numbers inside segment badges [D01] or backtick identifiers (`func2`).
    """
    # Strip quoted test labels "..."
    s_clean = re.sub(r'"[^"]*"', '', s)
    # Strip [Dk] badges and backtick code identifiers
    s_clean = re.sub(r'\[D\d+\]', '', s_clean)
    s_clean = re.sub(r'`[^`]*`', '', s_clean)
    nums = []
    # Match intervals like a–b or a-b
    for m in re.finditer(r'(?<![A-Za-z_])\d+(?:[.,]\d+)?(?![A-Za-z_])', s_clean):
        tok = m.group(0).replace(',', '.')
        try:
            nums.append(float(tok))
        except ValueError:
            pass
    return nums


class SummaryGenerator:
    def __init__(
        self,
        session_data,
        signals: Dict[str, Any],
        segments: List[Any],
        facts: Dict[str, Any],
        largest_events: List[Any],
        not_chosen: Optional[List[Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ):
        self.data = session_data
        self.signals = signals
        self.segments = segments
        self.facts = facts
        self.largest_events = largest_events
        self.not_chosen = not_chosen or []
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)

        self.outline: Dict[str, Any] = {}
        self.dropped: Dict[str, Any] = {}
        self.draft: Dict[str, Any] = {}
        self.outline_warnings: List[str] = []

    def generate(self) -> Tuple[str, Dict[str, Any]]:
        """Executes M4 -> M5 -> M6 and returns (summary_md, check_report)."""
        # 1. Build M4 Outline: key_points (KC1-KC6), timeline, compressed, table_rows, ai_chunk_rows
        kp_items = self._build_kp_items()
        tl_all_items, dropped_list = self._build_timeline_and_compressed_items()
        table_items, table_md = self._build_reference_table_items()
        ai_code_items, ai_code_md = self._build_ai_code_items()

        all_outline_items = kp_items + tl_all_items + table_items + ai_code_items
        s_code = self.data.session_code or "SS-QLHK"
        s_id = self.data.student_id

        self.outline = {
            "session_id": f"{s_code}_{s_id}",
            "items": all_outline_items,
            "warnings": self.outline_warnings,
        }
        self.dropped = {
            "session_id": f"{s_code}_{s_id}",
            "dropped": dropped_list,
        }

        # Separate LLM-eligible timeline items from compressed items (Spec 06 Section 1)
        tl_llm_items = [it for it in tl_all_items if it["kind"] == "timeline"]

        # 2. M5: LLM Realization with retry loop & M6 validation (Spec 06)
        llm_used = False
        llm_draft = None
        llm_model = self.params.get("llm.model", "gemma-4-26b")
        llm_call_log = []
        attempt_count = 1

        if self.params.get("llm.enabled", True) and (kp_items or tl_llm_items):
            summarizer = GemmaSummarizer(
                model=llm_model,
                base_url=self.params.get("llm.base_url"),
                api_key=self.params.get("llm.api_key"),
                temperature=self.params.get("llm.temperature", 0.0),
                timeout_s=self.params.get("llm.timeout_s", 15),
                prompt_version=self.params["llm.prompt_version"],
                input_variant=self.params.get("llm.input_variant", "sentences"),
                session_id=f"{s_code}_{s_id}",
                max_tokens=self.params.get("llm.max_tokens", 4096),
                network_retries=self.params.get("llm.max_retries", 1),
            )

            def _validator(cand_draft: Dict[str, Any]) -> Tuple[bool, List[Dict[str, Any]]]:
                errs = self._check_draft_k1_to_k5(cand_draft, kp_items, tl_llm_items)
                return len(errs) == 0, errs

            llm_draft, llm_call_log = summarizer.realize(
                kp_items,
                tl_llm_items,
                validator_func=_validator,
                max_retries=self.params.get("llm.max_regenerations", 2),
            )
            attempt_count = max(len(llm_call_log), 1)
            if llm_draft:
                llm_used = True

        # Fallback to deterministic template_draft (Spec 06 Section 5)
        if not llm_used or not llm_draft:
            llm_draft = self._build_template_draft(kp_items, tl_llm_items)
            fallback_used = True
        else:
            fallback_used = False

        self.draft = llm_draft

        # 3. Render Key Points and Timeline
        key_points_text = self._render_key_points_from_draft(llm_draft.get("key_points", []), kp_items)
        timeline_section = self._render_timeline_from_draft(llm_draft.get("timeline", []), tl_all_items)

        # 4. Assemble summary.md strictly per Spec 06 Section 7
        md_content = f"""## Tóm tắt buổi làm bài: {s_code}, sinh viên {s_id}

**Ý chính.** {key_points_text}

**Dòng thời gian.**
{timeline_section}

**Số liệu tham chiếu.**
{table_md}

**Đoạn code AI trong bản cuối.**
{ai_code_md}
"""

        # 5. M6: Run full K1 - K6 checks
        check_errors = self._check_draft_k1_to_k5(llm_draft, kp_items, tl_llm_items)
        k6_errors = self._check_k6_sections(md_content, table_md, ai_code_md)
        check_errors.extend(k6_errors)

        check_report = {
            "summary_rule_version": "phase-summary-3.1-2026-11-18",
            "prompt_version": self.params.get("llm.prompt_version"),
            "session_id": f"{s_code}_{s_id}",
            "attempt": attempt_count,
            "ok": len(check_errors) == 0,
            "errors": check_errors,
            "fallback_used": fallback_used,
            "checked_rules": ["K1", "K2", "K3", "K4", "K5", "K6"],
            "llm_used": llm_used,
            "llm_model": llm_model,
            "llm_calls": llm_call_log,
        }
        if fallback_used and self.params.get("llm.enabled", True):
            check_report["fallback_reason"] = "LLM offline/unreachable or validation error, template_draft applied"

        return md_content, check_report

    # =========================================================================
    # M4.3: Ý CHÍNH (KC1 - KC6)
    # =========================================================================
    def _build_kp_items(self) -> List[Dict[str, Any]]:
        """Spec 05 Section 3: Build KC1 to KC6 key point items."""
        f = self.facts
        items = []
        idx = 1

        def _add_kc(template: str, sentence: str, numbers: List[Any], minutes: List[int], seg_ids: List[str], sources: List[str]):
            nonlocal idx
            clean_nums = []
            for n in numbers:
                if n is not None:
                    try:
                        clean_nums.append(float(n))
                    except (ValueError, TypeError):
                        pass
            clean_mins = []
            for m in minutes:
                if m is not None:
                    try:
                        clean_mins.append(int(m))
                    except (ValueError, TypeError):
                        pass

            items.append({
                "id": f"O{idx:02d}",
                "kind": "key_point",
                "template": template,
                "sentences": [sentence],
                "text": sentence,
                "facts": {
                    "numbers": clean_nums,
                    "minutes": clean_mins,
                },
                # Khuôn cấp buổi (KC2–KC5) không gắn với đoạn nào; khi viết ra được ghi [cả buổi]
                "segment_ids": seg_ids or [],
                "sources": sources,
                "event_types": self._infer_item_event_types(template, sentence),
            })
            idx += 1

        # ---------------------------------------------------------------------
        # KC1: Lần chạy cuối (Spec 05 Section 3)
        # ---------------------------------------------------------------------
        last_run = f.get("last_run")
        last_obs = f.get("last_observed_run")
        errs_at_last = f.get("errors_at_last_observed", [])
        if last_run:
            m1 = last_run["minute"]
            sc = last_run["script"]
            c_phrase1 = self._format_run_outcome_phrase(last_run)
            seg_lr = [self._find_seg_id(minute_start_ms(m1))]
            srcs = ["last_run"]
            nums = _extract_numbers_from_sentence(c_phrase1)
            mins = [m1]

            if last_run.get("t_source") == "capture":
                # A17: log IDE không ghi lệnh chạy, chỉ biết lần chạy có trước mốc này
                cap_m = last_run.get("capture_minute")
                cap_str = f" ở phút {cap_m}" if cap_m else ""
                s_kc1 = f"Lần chạy cuối thấy trong terminal chụp{cap_str} là `{sc}`, chạy chậm nhất ở phút {m1}, {c_phrase1}."
                if cap_m:
                    nums.append(cap_m)
                    mins.append(cap_m)
            else:
                s_kc1 = f"Lần chạy cuối mà log ghi là `{sc}` ở phút {m1}, {c_phrase1}."
            if last_run["outcome"] == "unknown" and last_obs:
                m2 = last_obs["minute"]
                c_phrase2 = self._format_run_outcome_phrase(last_obs)
                s_kc1 += f" Lần chạy cuối có kết quả là ở phút {m2}, {c_phrase2}."
                mins.append(m2)
                nums.extend(_extract_numbers_from_sentence(c_phrase2))
            if errs_at_last:
                err_str = ", ".join(f"`{e}`" for e in errs_at_last)
                s_kc1 += f" Lỗi {err_str} vẫn xuất hiện ở lần chạy có kết quả cuối cùng."

            _add_kc("KC1", s_kc1, nums, mins, seg_lr, srcs)
        else:
            _add_kc("KC1", "Trong log không có lần chạy nào.", [], [], [], [])

        # ---------------------------------------------------------------------
        # KC2: Viết code (Spec 05 Section 3)
        # ---------------------------------------------------------------------
        t_task = f.get("T_task_min", 1)
        dur = f.get("duration_min", 1)
        lines_grp = f.get("lines_by_group", {})
        t_lines = lines_grp.get("typed", 0)
        p_lines = lines_grp.get("paste_other", 0)
        a_lines = lines_grp.get("ai", 0)
        u_lines = lines_grp.get("unknown", 0)

        parts = [f"khoảng {t_lines} dòng tự gõ" if t_lines > 0 else "0 dòng tự gõ"]
        nums_kc2 = [t_task, dur, t_lines]
        if p_lines > 0:
            parts.append(f"{p_lines} dòng dán")
            nums_kc2.append(p_lines)
        if a_lines > 0:
            parts.append(f"{a_lines} dòng thêm từ câu trả lời AI")
            nums_kc2.append(a_lines)
        if u_lines > 0:
            parts.append(f"{u_lines} dòng được thêm không qua gõ phím mà log không ghi nguồn")
            nums_kc2.append(u_lines)

        detail_str = ", ".join(parts[:-1]) + (" và " + parts[-1] if len(parts) > 1 else parts[0])
        s_kc2 = f"Thời gian làm bài ước lượng khoảng {t_task} phút trong buổi dài {dur} phút. Trong buổi có {detail_str}."
        # Log IDE thiếu thay đổi (A5): ảnh chụp code ở log máy chủ có dòng mà log IDE không ghi
        ul_lines = lines_grp.get("unlogged", 0)
        ul_mins = f.get("unlogged_minutes", [])
        if ul_lines >= self.params.get("dq.unlogged_mention_lines", 10) and ul_mins:
            m_str = ", ".join(str(m) for m in ul_mins)
            s_kc2 += (f" Log IDE không ghi một phần thay đổi code: ảnh chụp code ở log máy chủ lúc gửi yêu cầu AI "
                      f"(phút {m_str}) có {ul_lines} dòng mới mà log IDE không có. Các số liệu trên không gồm phần này.")
            nums_kc2.append(ul_lines)
            nums_kc2.extend(ul_mins)
        _add_kc("KC2", s_kc2, nums_kc2, [], [], [])

        # ---------------------------------------------------------------------
        # KC3: Chạy và lỗi (Spec 05 Section 3: có lần chạy)
        # ---------------------------------------------------------------------
        runs_cnt = len(self.signals.get("runs", []))
        if runs_cnt > 0:
            n_chains = f.get("n_chains_repeated", 0)
            oc_group = self._format_grouped_run_outcomes(f.get("runs_by_outcome", {}))
            nums_kc3 = [runs_cnt] + _extract_numbers_from_sentence(oc_group)
            chain_part = ""
            if n_chains > 0:
                chain_part = f", có {n_chains} chuỗi lỗi từ 3 lần chạy"
                nums_kc3.extend([n_chains, 3])
            s_kc3 = f"Sinh viên chạy chương trình {runs_cnt} lần ({oc_group}){chain_part}."
            _add_kc("KC3", s_kc3, nums_kc3, [], [], ["runs"])

        # ---------------------------------------------------------------------
        # KC4: Nhịp (Spec 05 Section 3)
        # ---------------------------------------------------------------------
        n_ws = f.get("n_work_sessions", 1)
        p10 = f.get("n_pauses_ge_10min", 0)
        nums_kc4 = [n_ws]
        if n_ws == 1 and p10 == 0:
            s_kc4 = "Buổi liền một phiên và không có khoảng không thao tác nào từ 10 phút."
            nums_kc4.append(10)
        elif p10 > 0:
            s_kc4 = f"Buổi gồm {n_ws} phiên làm việc và {p10} khoảng không thao tác từ 10 phút."
            nums_kc4.extend([p10, 10])
        else:
            s_kc4 = f"Buổi gồm {n_ws} phiên làm việc và không có khoảng không thao tác nào từ 10 phút."
            nums_kc4.append(10)
        _add_kc("KC4", s_kc4, nums_kc4, [], [], ["pauses"])

        # ---------------------------------------------------------------------
        # KC5: Dùng AI (Spec 05 Section 3)
        # ---------------------------------------------------------------------
        n_req = f.get("n_requests", 0)
        if n_req > 0:
            req_flags = f.get("n_requests_by_flag", {})
            e_req = req_flags.get("error", 0)
            t_req = req_flags.get("task", 0)
            c_req = req_flags.get("own_code", 0)
            nc_resp = f.get("n_responses_no_code", 0)
            rej_req = f.get("n_requests_rejected", 0)
            retained_cnt = len(f.get("ai_chunks_retained", []))
            disc_cnt = len(f.get("ai_chunks_discarded", []))

            flag_parts = []
            nums_kc5 = [n_req]
            if e_req > 0:
                flag_parts.append(f"{e_req} yêu cầu kèm thông báo lỗi")
                nums_kc5.append(e_req)
            if t_req > 0:
                flag_parts.append(f"{t_req} yêu cầu kèm một đoạn đề bài")
                nums_kc5.append(t_req)
            if c_req > 0:
                flag_parts.append(f"{c_req} yêu cầu kèm code của mình")
                nums_kc5.append(c_req)

            f_str = (", trong đó " + ", ".join(flag_parts)) if flag_parts else ""
            nc_str = f"; {nc_resp} câu trả lời không có khối code" if nc_resp > 0 else ""
            if nc_resp > 0:
                nums_kc5.append(nc_resp)
            rej_str = f"; {rej_req} yêu cầu bị hệ thống từ chối" if rej_req > 0 else ""
            if rej_req > 0:
                nums_kc5.append(rej_req)

            fate_str = f"Bản cuối còn {retained_cnt} đoạn code từ AI"
            nums_kc5.append(retained_cnt)
            if disc_cnt > 0:
                fate_str += f", {disc_cnt} đoạn khác đã bị xóa"
                nums_kc5.append(disc_cnt)
            fate_str += "."

            s_kc5 = f"Sinh viên gửi {n_req} yêu cầu cho AI{f_str}{nc_str}{rej_str}. {fate_str}"
            _add_kc("KC5", s_kc5, nums_kc5, [], [], ["ai_requests"])
        else:
            _add_kc("KC5", "Theo log của IDE, sinh viên không gửi yêu cầu AI nào trong buổi.", [], [], [], [])

        # ---------------------------------------------------------------------
        # KC6: Sự việc lớn nhất LN (Spec 05 Section 3)
        # ---------------------------------------------------------------------
        if self.largest_events:
            first_ln = self.largest_events[0]
            s_kc6, nums_kc6, mins_kc6 = self._format_largest_sentence(first_ln)
            _add_kc("KC6", s_kc6, nums_kc6, mins_kc6, first_ln.segment_ids, first_ln.sources)

        return items

    def _format_largest_sentence(self, ln: Any) -> Tuple[str, List[Any], List[int]]:
        """Formats canonical LN sentence according to Spec 05 Section 3.1."""
        ln_id = ln.id if hasattr(ln, "id") else ln.get("id")
        facts = ln.facts if hasattr(ln, "facts") else ln.get("facts", {})
        nums = []
        mins = []

        if ln_id == "LN1":
            lines = facts.get("lines", 0)
            fn = _display_file(facts.get("file"))
            m = facts.get("minute", 0)
            src = facts.get("src", "paste")
            ml = facts.get("match_level", "none")
            mr = facts.get("response_minute")
            fate = facts.get("fate", "intact")
            s_end = facts.get("s_end", 1.0)

            c_them = "dán"
            if src == "ai_insert":
                c_them = "dán từ khung chat AI"
            elif src == "ai_agent":
                c_them = "do AI agent sửa file"
            elif src == "unknown_source":
                c_them = "không qua gõ phím"

            match_clause = ""
            if ml == "verbatim" and mr is not None:
                match_clause = f", trùng nguyên văn câu trả lời AI ở phút {mr}"
                mins.append(mr)
            elif ml == "close" and mr is not None:
                match_clause = f", gần như trùng câu trả lời AI ở phút {mr}"
                mins.append(mr)
            elif src == "unknown_source" and ml not in ("verbatim", "close"):
                match_clause = ", log không ghi nguồn và đoạn này không khớp câu trả lời AI nào"

            fate_clause = "còn nguyên"
            if fate == "discarded" or s_end == 0:
                fate_clause = "đã bị xóa hết"
            elif fate == "partial":
                pct = int(round(s_end * 10) * 10)
                fate_clause = f"còn khoảng {pct}% ký tự"
                nums.append(pct)

            nums.extend([lines])
            mins.append(m)
            s = f"Lần thêm lớn nhất là {lines} dòng vào `{fn}` ở phút {m}, {c_them}{match_clause}; ở cuối buổi đoạn này {fate_clause}."
            return s, nums, mins

        elif ln_id == "LN2":
            sc = facts.get("script", "main.py")
            x = facts.get("error_type", "RuntimeError")
            n = facts.get("n_runs", 3)
            a = facts.get("minute_start", 0)
            b = facts.get("minute_last_error", a)
            u = facts.get("unknown_between", 0)
            e = facts.get("ended_minute")

            nums.append(n)
            mins.extend([a, b])
            u_part = f", xen giữa có {u} lần chạy không rõ kết quả" if u > 0 else ""
            if u > 0:
                nums.append(u)

            if e is not None:
                mins.append(e)
                tail = f"Từ lần chạy ở phút {e}, lỗi này không còn xuất hiện."
            else:
                tail = "Tới lần chạy có kết quả cuối cùng, lỗi này vẫn còn."

            s = f"Lỗi `{x}` của `{sc}` xuất hiện ở {n} lần chạy có kết quả liên tiếp, từ phút {a} đến phút {b}{u_part}. {tail}"
            return s, nums, mins

        elif ln_id == "LN3":
            d = facts.get("duration_min", 10)
            a = facts.get("minute_start", 0)
            b = facts.get("minute_end", a + d)
            op = self._event_type_name(facts.get("opener", "none"))
            fl = self._event_type_name(facts.get("follower", "none"))
            nums.append(d)
            mins.extend([a, b])
            s = f"Khoảng không thao tác dài nhất là khoảng {d} phút, từ phút {a} đến phút {b}. Trước đó là {op}, sau đó là {fl}."
            return s, nums, mins

        elif ln_id == "LN4":
            kind = facts.get("kind", "insert_error_ask")
            a = facts.get("minute_start", 0)
            b = facts.get("minute_end", a)
            mins.extend([a, b])
            if kind == "insert_error_ask":
                k = facts.get("cycles", 2)
                nums.append(k)
                s = f"Từ phút {a} đến phút {b}, dãy thêm code từ câu trả lời AI, chạy có lỗi, rồi gửi yêu cầu AI mới lặp lại {k} lần."
            else:
                n = facts.get("n_requests", 3)
                nums.append(n)
                s = f"Từ phút {a} đến phút {b}, có {n} yêu cầu AI liên tiếp kèm thông báo lỗi."
            return s, nums, mins

        elif ln_id == "LN5":
            m = facts.get("request_minute", 0)
            mins.append(m)
            t_typ = facts.get("first_typing_minute")
            before_typ = facts.get("request_before_typing", True)
            flag_task = facts.get("flag_task", False)
            burst = facts.get("inserted_as_burst", False)
            b_lines = facts.get("burst_lines", 0)

            if before_typ or t_typ is None:
                typ_clause = ", khi trong file chưa có thay đổi tự gõ nào ngoài code khởi đầu"
            else:
                mins.append(t_typ)
                typ_clause = f", sau khi đã tự gõ từ phút {t_typ}"

            task_clause = ", có kèm một đoạn đề bài" if flag_task else ""
            burst_clause = ""
            if burst and b_lines > 0:
                nums.append(b_lines)
                burst_clause = f", và code trong câu trả lời được thêm vào thành 1 đợt {b_lines} dòng"

            s = f"Yêu cầu AI đầu tiên ở phút {m}{typ_clause}{task_clause}{burst_clause}."
            return s, nums, mins

        return "", [], []

    def _event_type_name(self, ev_type: str) -> str:
        """Spec 05 Section 4.2: Tên loại sự kiện cho khoảng dừng."""
        if ev_type == "type":
            return "thao tác gõ"
        if ev_type == "delete":
            return "thao tác xóa"
        if ev_type == "paste":
            return "thao tác dán"
        if ev_type == "ai_insert":
            return "thao tác dán từ khung chat AI"
        if ev_type == "unknown_insert":
            return "lần thêm code không qua gõ phím"
        if ev_type.startswith("run_"):
            oc = ev_type[4:]
            if oc == "error":
                return "lần chạy có lỗi"
            elif oc == "test_fail":
                return "lần chạy có test trượt"
            elif oc == "server_started":
                return "lần chạy server đã lên"
            elif oc == "no_error_seen":
                return "lần chạy không thấy lỗi"
            else:
                return "lần chạy không rõ kết quả"
        if ev_type == "page_load":
            return "lần tải trang"
        if ev_type == "ai_response":
            return "câu trả lời AI"
        if ev_type == "ai_request":
            return "yêu cầu gửi AI"
        return "thao tác trên giao diện"

    # =========================================================================
    # M4.1 & M4.2: DÒNG THỜI GIAN & NÉN (B1 - B4, Đ1 - Đ5)
    # =========================================================================
    def _build_timeline_and_compressed_items(self) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Spec 05 Section 1 & 2: Select timeline segments and compress unselected gaps."""
        mandatory = set()
        rules_by_seg: Dict[str, List[str]] = {}

        # B1: Segments of every LN in largest
        for ln in self.largest_events:
            for s_id in ln.segment_ids:
                mandatory.add(s_id)
                rules_by_seg.setdefault(s_id, []).append("B1")

        # B2: First segment with code change or AI request
        for seg in self.segments:
            if seg.type in ("ai", "write", "error_chain"):
                mandatory.add(seg.id)
                rules_by_seg.setdefault(seg.id, []).append("B2")
                break

        # B3: Every error_chain segment belonging to a repeated chain (TH3)
        chains = self.signals.get("chains", self.signals.get("threads", []))
        rep_th_ids = {th["id"] for th in chains if th.get("repeated")}
        for seg in self.segments:
            if seg.type == "error_chain" and seg.raw_thread_id in rep_th_ids:
                mandatory.add(seg.id)
                rules_by_seg.setdefault(seg.id, []).append("B3")

        # B4: Segment containing the last run
        runs = self.signals.get("runs", [])
        if runs:
            last_r_seg = self._find_seg_id(runs[-1]["t"])
            mandatory.add(last_r_seg)
            rules_by_seg.setdefault(last_r_seg, []).append("B4")

        # Conditional candidates Đ1 - Đ5
        conditional = []
        ai_insert_min_lines = self.params.get("select.ai_insert_lines", 5)
        chain_failed_min = self.params.get("select.chain_failed_runs", 2)
        long_pause_min = self.params.get("select.long_pause_ms", 600000)

        for seg in self.segments:
            if seg.id in mandatory:
                continue
            sf = seg.facts
            if seg.type == "ai":
                max_lines = max([ins.get("lines", 0) for ins in sf.get("insertions", [])], default=0)
                if max_lines >= ai_insert_min_lines:
                    conditional.append((seg, 5, max_lines, "Đ1"))
            elif seg.type == "error_chain":
                n_runs = sf.get("n_runs", 0)
                if n_runs >= chain_failed_min:
                    conditional.append((seg, 4, n_runs, "Đ2"))
            elif seg.type == "write":
                has_burst = len(sf.get("bursts", [])) > 0
                pasted_chars = sf.get("pasted_chars", 0)
                if has_burst or pasted_chars >= ai_insert_min_lines * 30:
                    conditional.append((seg, 3, sf.get("typed_chars", 0) + pasted_chars, "Đ3"))
                else:
                    conditional.append((seg, 2, sf.get("typed_chars", 0), "Đ4"))
            elif seg.type == "pause":
                dur_ms = sf.get("duration_s", 0) * 1000
                if dur_ms >= long_pause_min:
                    conditional.append((seg, 1, dur_ms, "Đ5"))

        max_items = self.params.get("select.max_timeline_items", 12)
        # Các đoạn của cùng một mạch lỗi chỉ thành một mục (gộp khi dựng), nên chỉ tính một chỗ trong trần mục
        seg_by_id = {s.id: s for s in self.segments}
        mandatory_units = {("chain", seg_by_id[s_id].raw_thread_id) if s_id in seg_by_id and seg_by_id[s_id].type == "error_chain" and seg_by_id[s_id].raw_thread_id else s_id
                           for s_id in mandatory}
        budget = max(max_items - len(mandatory_units), 0)

        conditional.sort(key=lambda x: (-x[1], -x[2], x[0].t_start))
        selected_cond = conditional[:budget]
        dropped_cond = conditional[budget:]

        selected_seg_ids = set(mandatory)
        for cand, rank, mag, rule in selected_cond:
            selected_seg_ids.add(cand.id)
            rules_by_seg.setdefault(cand.id, []).append(rule)

        dropped_list = [
            {"segment_id": cand.id, "reason": "budget", "rank": rank, "magnitude": mag, "rule": rule}
            for cand, rank, mag, rule in dropped_cond
        ]

        if len(mandatory_units) > max_items:
            self.outline_warnings.append(f"over_budget: mandatory items ({len(mandatory)}) exceed max_timeline_items ({max_items})")

        # Assemble timeline items and compressed items along the timeline
        tl_all_items = []
        idx = 10
        cur_unselected: List[Any] = []

        chain_items: Dict[str, Dict[str, Any]] = {}
        for seg in self.segments:
            if seg.id in selected_seg_ids:
                # Đoạn sau của một mạch lỗi đã kể: gộp mã đoạn vào mục đã có, không kể lại cả câu mạch
                prev_chain = chain_items.get(seg.raw_thread_id) if seg.type == "error_chain" else None
                if prev_chain is not None:
                    prev_chain["segment_ids"].append(seg.id)
                    if cur_unselected:
                        comp_item = self._build_compressed_item(cur_unselected, idx)
                        if comp_item:
                            tl_all_items.append(comp_item)
                            idx += 1
                        cur_unselected = []
                    continue
                if cur_unselected:
                    comp_item = self._build_compressed_item(cur_unselected, idx)
                    if comp_item:
                        tl_all_items.append(comp_item)
                        idx += 1
                    cur_unselected = []

                tl_item = self._build_single_timeline_item(seg, idx, rules_by_seg.get(seg.id, []))
                tl_all_items.append(tl_item)
                if seg.type == "error_chain" and seg.raw_thread_id:
                    chain_items[seg.raw_thread_id] = tl_item
                idx += 1
            else:
                cur_unselected.append(seg)

        if cur_unselected:
            comp_item = self._build_compressed_item(cur_unselected, idx)
            if comp_item:
                tl_all_items.append(comp_item)

        return tl_all_items, dropped_list

    def _build_single_timeline_item(self, seg: Any, idx: int, rules: List[str]) -> Dict[str, Any]:
        """Formats a single selected timeline segment per Spec 05 Section 4.3."""
        sf = seg.facts
        m_a = seg.minute_start
        m_b = seg.minute_end
        sents = []
        nums: List[Any] = []
        mins: List[int] = [m_a]
        if m_b != m_a:
            mins.append(m_b)
        detail_md = ""

        # Segment-specific realization
        if seg.type == "ai":
            n_req = sf.get("n_requests", 0)
            req_mins = sorted(set(sf.get("request_minutes") or [m_a]))
            # Câu về yêu cầu và câu về các lần dán được xếp theo thời gian: một đoạn hỏi AI có thể chứa
            # các lần dán từ câu trả lời của yêu cầu trước (đoạn bị khoảng dừng cắt đôi).
            timed: List[Tuple[int, int, List[str]]] = []

            if n_req > 0:
                req_word = f"{n_req} yêu cầu"
                nums.append(n_req)

                err_sigs = sf.get("prompt_error_signature", [])
                err_part = f", kèm thông báo lỗi `{err_sigs[0]}`" if err_sigs else ""
                task_part = ", kèm một đoạn đề bài" if any(sf.get("flag_task", [])) else ""
                own_part = ", kèm code của mình" if any(sf.get("flag_own_code", [])) else ""

                # Context condition
                ctx_list = sf.get("context", [])
                ctx = ctx_list[0] if ctx_list else "after_own_code"
                ctx_phrase = ""
                if ctx == "start":
                    ctx_phrase = ", khi trong file chưa có thay đổi tự gõ nào ngoài code khởi đầu"
                elif ctx == "after_clear":
                    ctx_phrase = ", sau khi file trở về code khởi đầu"
                elif ctx == "after_ai":
                    ctx_phrase = ", ngay sau lần dùng AI trước, không có thay đổi tự gõ xen giữa"
                elif ctx == "after_all_pass":
                    ctx_phrase = ", khi lần chạy test gần nhất qua mọi test"

                req_when = f"Phút {req_mins[0]}" if len(req_mins) == 1 else f"Phút {req_mins[0]}–{req_mins[-1]}"
                mins.extend(req_mins)
                req_sents = [f"{req_when}: gửi {req_word} cho AI{err_part}{task_part}{own_part}{ctx_phrase}."]

                # Response
                resp_has_code = sf.get("response_has_code", [])
                resp_lines = sf.get("response_code_lines", [])
                resp_rejected = sf.get("response_rejected", [])

                k_resp = 0
                n_resp = 0
                x_resp = 0
                for i in range(n_req):
                    h = resp_has_code[i] if i < len(resp_has_code) else False
                    r = resp_rejected[i] if i < len(resp_rejected) else False
                    if r:
                        x_resp += 1
                    elif h:
                        k_resp += 1
                    else:
                        n_resp += 1
                L_resp = sum(resp_lines)

                if k_resp > 0:
                    resp_sentence = f"Câu trả lời có khối code {L_resp} dòng" if L_resp > 0 else "Câu trả lời có khối code"
                    if L_resp > 0:
                        nums.append(L_resp)
                    if n_resp > 0:
                        resp_sentence += f", {n_resp} câu trả lời không có khối code"
                        nums.append(n_resp)
                    if x_resp > 0:
                        resp_sentence += f", {x_resp} yêu cầu bị hệ thống từ chối"
                        nums.append(x_resp)
                    resp_sentence += "."
                    req_sents.append(resp_sentence)
                elif n_resp > 0:
                    resp_sentence = "Câu trả lời không có khối code"
                    if x_resp > 0:
                        resp_sentence += f", {x_resp} yêu cầu bị hệ thống từ chối"
                        nums.append(x_resp)
                    resp_sentence += "."
                    req_sents.append(resp_sentence)
                elif x_resp > 0:
                    nums.append(x_resp)
                    req_sents.append(f"{x_resp} yêu cầu bị hệ thống từ chối.")

                timed.append((req_mins[0], 0, req_sents))

            # Insertions: từ render.insert_table_min lần trở lên thì kể một câu gộp, chi tiết từng lần
            # vào bảng ngay dưới mục (dựng theo mẫu, không qua LLM); ít hơn thì kể từng câu
            ins_list = sf.get("insertions", [])
            use_table = len(ins_list) >= self.params.get("render.insert_table_min", 3)
            table_rows = []
            for k, ins in enumerate(ins_list):
                m_ins = ins["minute"]
                mins.append(m_ins)
                l_ins = ins["lines"]
                nums.append(l_ins)
                fn = _display_file(ins.get("file"))
                c_action = {"ai_insert": "dán từ khung chat AI", "unknown_source": "thêm không qua gõ phím"}.get(ins.get("src"), "dán")
                ml = ins.get("match_level", "verbatim")
                r_min = ins.get("response_minute")
                wait_s = ins.get("wait_s")
                if use_table:
                    ml_cell = {"verbatim": "trùng nguyên văn", "close": "gần như trùng"}.get(ml, "")
                    if ml == "partial":
                        ml_cell = f"khớp một phần (khoảng {int((ins.get('match_score') or 0) * 100)}% ký tự)"
                    if ml_cell and r_min is not None:
                        ml_cell += f" với câu trả lời ở phút {r_min}"
                    wait_cell = _fmt_wait(wait_s) if wait_s is not None else ("trước khi câu trả lời xong" if ins.get("before_response_end") else "–")
                    table_rows.append(f"| {m_ins} | `{fn}` | {l_ins} | {c_action} | {ml_cell or '–'} | {wait_cell} |")
                    continue
                ml_str = ", trùng nguyên văn" if ml == "verbatim" else (", gần như trùng" if ml == "close" else "")
                resp_ref = "câu trả lời" if r_min is None or r_min >= req_mins[0] else f"câu trả lời ở phút {r_min}"
                if r_min is not None and r_min < req_mins[0]:
                    mins.append(r_min)
                wait_str = ""
                if wait_s is not None and wait_s > 0:
                    nums.extend(_extract_numbers_from_sentence(_fmt_wait(wait_s)))
                    wait_str = f", {_fmt_wait(wait_s)} sau khi câu trả lời xong"
                if not ml_str:
                    resp_ref = ""
                timed.append((m_ins, 1 + k, [f"Phút {m_ins}: {c_action} {l_ins} dòng vào `{fn}`{ml_str}{' với ' + resp_ref if resp_ref else ''}{wait_str}."]))

            if table_rows:
                i_mins = [ins["minute"] for ins in ins_list]
                n_ins = len(ins_list)
                tot_lines = sum(ins["lines"] for ins in ins_list)
                n_files = len({ins.get("file") for ins in ins_list})
                nums.extend([n_ins, tot_lines, n_files])
                when = f"Phút {i_mins[0]}" if i_mins[0] == i_mins[-1] else f"Từ phút {i_mins[0]} đến phút {i_mins[-1]}"
                timed.append((i_mins[0], 1, [f"{when}, code được thêm vào {n_files} file trong {n_ins} lần, tổng {tot_lines} dòng."]))
                detail_md = (
                    "| Phút | File | Số dòng | Cách thêm | So với câu trả lời AI | Sau khi câu trả lời xong |\n"
                    "| :--- | :--- | :--- | :--- | :--- | :--- |\n" + "\n".join(table_rows)
                )

            for _, _, group in sorted(timed, key=lambda x: (x[0], x[1])):
                sents.extend(group)

            # Run after insertion
            if sf.get("time_to_run_s") is not None:
                if sf.get("modified_before_run"):
                    sents.append("Có thay đổi vào đoạn này trước lần chạy kế tiếp.")
                else:
                    sents.append("Không có thay đổi vào đoạn này trước lần chạy kế tiếp.")

            if sf.get("run_outcome"):
                oc_str = self._format_single_run_outcome(sf.get("run_outcome"), sf.get("error_type"))
                nums.extend(_extract_numbers_from_sentence(oc_str))
                sents.append(f"Phút {m_b}: chạy, {oc_str}.")

            # Next action
            nxt = sf.get("next_action")
            if nxt == "self_edit":
                sents.append(f"việc kế tiếp là thay đổi tự gõ ở phút {m_b}.")
            elif nxt == "new_request":
                sents.append(f"việc kế tiếp là yêu cầu AI mới ở phút {m_b}.")
            elif nxt == "delete_ai_code":
                sents.append(f"việc kế tiếp là xóa đoạn code vừa thêm ở phút {m_b}.")
            elif nxt == "rerun_no_change":
                sents.append("việc kế tiếp là chạy lại mà code không đổi.")
            elif nxt == "delete_and_repaste":
                sents.append("việc kế tiếp là xóa rồi dán lại đoạn code vừa thêm.")

        elif seg.type == "error_chain":
            sc = sf.get("script", "main.py")
            n_r = sf.get("n_runs_thread", sf.get("n_runs", 2))
            m_a = sf.get("thread_minute_start", m_a)
            m_b = max(sf.get("thread_minute_end", m_b), m_a)
            mins.extend([m_a, m_b])
            nums.append(n_r)
            x_err = sf.get("error_type", "RuntimeError")
            loc_l = sf.get("location_line")
            loc_str = f" ở dòng {loc_l}" if loc_l else ""
            if loc_l:
                nums.append(loc_l)
            u_r = sf.get("unknown_between", 0)
            u_str = f", xen giữa có {u_r} lần chạy không rõ kết quả" if u_r > 0 else ""
            if u_r > 0:
                nums.append(u_r)

            b_labels = sf.get("between_labels", [])
            edit_clause = ""
            if "none" in b_labels:
                edit_clause = "; có lần chạy lại mà code không đổi"
            elif b_labels and all(b == "minor" for b in b_labels):
                nums.extend([1, 2])
                edit_clause = "; giữa các lần chạy, mỗi lần code được sửa 1–2 dòng"

            n_req_th = sf.get("n_requests_in_thread", 0)
            req_clause = f"; có {n_req_th} yêu cầu AI trong khoảng này" if n_req_th > 0 else ""
            if n_req_th > 0:
                nums.append(n_req_th)

            sents.append(f"Phút {m_a}–{m_b}: `{sc}` được chạy {n_r} lần có kết quả, lần nào cũng có lỗi `{x_err}`{loc_str}{u_str}{edit_clause}{req_clause}.")

            ended_m = sf.get("ended_minute")
            if ended_m is not None:
                mins.append(ended_m)
                del_str = "; dòng được báo lỗi đã bị xóa trước lần chạy đó" if sf.get("deleted_error_line") else ""
                sents.append(f"Từ lần chạy ở phút {ended_m}, lỗi này không còn xuất hiện{del_str}.")
            else:
                sents.append("Tới lần chạy có kết quả cuối cùng, lỗi này vẫn còn.")

        elif seg.type == "write":
            t_lines = sf.get("typed_lines", sf.get("net_lines", 0))
            nums.append(t_lines)
            p_lines = sf.get("pasted_lines", 0)
            p_clause = f", dán {p_lines} dòng" if p_lines >= 5 else ""
            if p_lines >= 5:
                nums.append(p_lines)

            oc_group = self._format_grouped_run_outcomes(sf.get("run_outcomes", {}))
            run_clause = f", {oc_group}" if sf.get("n_runs", 0) > 0 else ""
            if sf.get("n_runs", 0) and sf.get("n_capture_runs") == sf.get("n_runs"):
                up = sf.get("capture_upper_minute")
                run_clause = f"; terminal chụp cho thấy {sf['n_runs']} lần chạy chậm nhất ở phút {up} ({oc_group})"
                nums.extend([sf["n_runs"], up])
            nums.extend(_extract_numbers_from_sentence(oc_group))

            del_chars = sf.get("del_chars", 0)
            typed_chars = sf.get("typed_chars", 0)
            if t_lines > 0:
                t_phrase = f"khoảng {t_lines} dòng tự gõ"
            else:
                if del_chars > 0 and typed_chars > 0 and not p_clause and not run_clause:
                    t_phrase = f"0 dòng tự gõ, gõ rồi xoá {del_chars} ký tự"
                    nums.append(del_chars)
                else:
                    t_phrase = "0 dòng tự gõ"

            sents.append(f"Phút {m_a}–{m_b}: viết code, {t_phrase}{p_clause}{run_clause}.")

            for b in sf.get("bursts", []):
                b_min = minute_label(b["t"])
                mins.append(b_min)
                b_lines = b["lines"]
                nums.append(b_lines)
                fn = _display_file(b.get("file"))
                b_src = b.get("src", "")
                c_action = {"unknown_source": "thêm không qua gõ phím", "ai_insert": "dán"}.get(b_src, "dán")
                src_note = {
                    "unknown_source": "; log không ghi nguồn",
                    "paste_chat": " từ khung chat AI",
                    "ai_insert": " từ khung chat AI",
                    "paste_internal": " từ chính các file của bài",
                    "paste_external": " từ ngoài IDE",
                }.get(b_src, "")
                sents.append(f"Phút {b_min}: {c_action} {b_lines} dòng vào `{fn}`{src_note}.")

        elif seg.type == "pause":
            dur_m = max(int(round(sf.get("duration_s", 0) / 60.0)), 1)
            nums.append(dur_m)
            op = self._event_type_name(sf.get("opener", "none"))
            fl = self._event_type_name(sf.get("follower", "none"))
            sents.append(f"Từ phút {m_a} đến phút {m_b}, không có thao tác nào được ghi (khoảng {dur_m} phút). Trước đó là {op}, sau đó là {fl}.")

        clean_nums = []
        for x in nums:
            try:
                clean_nums.append(float(x))
            except (ValueError, TypeError):
                pass

        return {
            "id": f"O{idx:02d}",
            "kind": "timeline",
            "segment_ids": [seg.id],
            "minute_start": m_a,
            "minute_end": m_b,
            "mandatory": "B1" in rules or "B2" in rules or "B3" in rules or "B4" in rules,
            "rules": rules,
            "sentences": sents,
            "text": " ".join(sents),
            "detail_md": detail_md,
            "facts": {
                "minutes": sorted(list(set(mins))),
                "numbers": sorted(list(set(clean_nums))),
            },
            "sources": getattr(seg, "event_ids", [])[:10],
            "event_types": self._infer_item_event_types(seg.type, " ".join(sents)),
        }

    def _build_compressed_item(self, unselected_segs: List[Any], idx: int) -> Optional[Dict[str, Any]]:
        """Spec 05 Section 2: Compresses contiguous unselected segments."""
        m_a = unselected_segs[0].minute_start
        m_b = unselected_segs[-1].minute_end
        if m_b <= m_a and all(s.facts.get("n_runs", 0) == 0 for s in unselected_segs):
            return None

        typed_lines = sum(s.facts.get("net_lines", 0) for s in unselected_segs if s.type == "write")
        tot_runs = sum(s.facts.get("n_runs", 0) for s in unselected_segs)
        runs_by_oc: Dict[str, int] = {}
        for s in unselected_segs:
            for oc, cnt in s.facts.get("run_outcomes", {}).items():
                runs_by_oc[oc] = runs_by_oc.get(oc, 0) + cnt

        n_req = sum(s.facts.get("n_requests", 0) for s in unselected_segs if s.type == "ai")
        pause_tot_m = sum(int(round(s.facts.get("duration_s", 0) / 60.0)) for s in unselected_segs if s.type == "pause" and s.facts.get("duration_s", 0) >= 180)

        # Đoạn bị nén vẫn có thể có code dán hay code thêm sau câu trả lời AI: không được viết "không thay đổi code"
        pasted_lines = sum(s.facts.get("pasted_lines", 0) for s in unselected_segs if s.type == "write")
        ai_ins = [ins for s in unselected_segs if s.type == "ai" for ins in s.facts.get("insertions", [])]
        ai_ins_lines = sum(ins.get("lines", 0) for ins in ai_ins)
        change_parts = []
        if typed_lines > 0:
            change_parts.append(f"khoảng {typed_lines} dòng tự gõ")
        if pasted_lines > 0:
            change_parts.append(f"dán {pasted_lines} dòng")
        if ai_ins:
            change_parts.append(f"{len(ai_ins)} lần thêm code sau khi hỏi AI, tổng {ai_ins_lines} dòng")
        if change_parts == [f"khoảng {typed_lines} dòng tự gõ"]:
            write_phrase = f"viết code (khoảng {typed_lines} dòng)"
        elif change_parts:
            write_phrase = "thay đổi code (" + ", ".join(change_parts) + ")"
        else:
            write_phrase = "không thay đổi code"
        runs_phrase = f", {self._format_grouped_run_outcomes(runs_by_oc)}" if tot_runs > 0 else ""
        req_phrase = f", gửi {n_req} yêu cầu AI" if n_req > 0 else ""
        pause_phrase = f", có các khoảng không thao tác cộng lại {pause_tot_m} phút" if pause_tot_m >= 3 else ""

        nums = []
        if typed_lines > 0:
            nums.append(typed_lines)
        nums.extend(x for x in (pasted_lines, len(ai_ins), ai_ins_lines) if x)
        if tot_runs > 0:
            nums.extend(_extract_numbers_from_sentence(runs_phrase))
        if n_req > 0:
            nums.append(n_req)
        if pause_tot_m >= 3:
            nums.append(pause_tot_m)

        t_range = f"Phút {m_a}" if m_a == m_b else f"Phút {m_a}–{m_b}"
        sentence = f"{t_range}: {write_phrase}{runs_phrase}{req_phrase}{pause_phrase}."

        clean_nums = []
        for x in nums:
            try:
                clean_nums.append(float(x))
            except (ValueError, TypeError):
                pass

        return {
            "id": f"O{idx:02d}",
            "kind": "compressed",
            "minute_start": m_a,
            "minute_end": m_b,
            "sentences": [sentence],
            "text": sentence,
            "facts": {
                "minutes": [m_a, m_b],
                "numbers": sorted(list(set(clean_nums))),
            },
            "segment_ids": [s.id for s in unselected_segs],
            "sources": [],
            "event_types": {"compressed"},
        }

    # =========================================================================
    # M4.6: BẢNG SỐ LIỆU THAM CHIẾU & ĐOẠN CODE AI TRONG BẢN CUỐI
    # =========================================================================
    def _build_reference_table_items(self) -> Tuple[List[Dict[str, Any]], str]:
        """Spec 05 Section 6: Build 12 reference table rows without LLM."""
        f = self.facts
        cmps = f.get("comparisons", {})
        table_rows = []
        idx = 40

        def _cmp_str(metric_key: str) -> str:
            res = cmps.get(metric_key)
            if res == "higher_than_most":
                return " (nhiều hơn phần lớn lớp)"
            if res == "lower_than_most":
                return " (ít hơn phần lớn lớp)"
            return ""

        # 1. Thời lượng buổi và thời gian làm bài ước lượng
        dur = f.get("duration_min", 1)
        t_task = f.get("T_task_min", 1)
        v1 = f"Buổi dài {dur} phút, thời gian làm bài ước lượng khoảng {t_task} phút{_cmp_str('T_task_min')}"
        table_rows.append(("Thời lượng", v1, [dur, t_task]))

        # 2. Số phiên làm việc, số khoảng dừng từ 3 phút và từ 10 phút
        n_ws = f.get("n_work_sessions", 1)
        p3 = f.get("n_pauses_ge_3min", 0)
        p10 = f.get("n_pauses_ge_10min", 0)
        v2 = f"{n_ws} phiên làm việc, {p3} khoảng dừng từ 3 phút, {p10} khoảng dừng từ 10 phút{_cmp_str('n_pauses_ge_3min')}"
        table_rows.append(("Phiên và khoảng dừng", v2, [n_ws, p3, p10, 3, 10]))

        # 3. Lần chạy theo kết quả
        runs = self.signals.get("runs", [])
        oc_str = self._format_grouped_run_outcomes(f.get("runs_by_outcome", {}))
        v3 = f"{len(runs)} ({oc_str}){_cmp_str('n_runs_total')}" if runs else "0 lần chạy"
        table_rows.append(("Lần chạy", v3, [len(runs)] + _extract_numbers_from_sentence(oc_str)))

        # 4. Lần chạy cuối mà log ghi, và lần chạy cuối có kết quả nếu khác
        last_r = f.get("last_run")
        last_o = f.get("last_observed_run")
        if last_r:
            m1 = last_r["minute"]
            p1 = self._format_run_outcome_phrase(last_r)
            at_str = f"chậm nhất ở phút {m1}, theo terminal chụp" if last_r.get("t_source") == "capture" else f"ở phút {m1}"
            v4 = f"`{last_r['script']}` {at_str} ({p1})"
            nums4 = [m1] + _extract_numbers_from_sentence(p1)
            if last_r["outcome"] == "unknown" and last_o:
                m2 = last_o["minute"]
                p2 = self._format_run_outcome_phrase(last_o)
                v4 += f"; lần cuối có kết quả ở phút {m2} ({p2})"
                nums4.extend([m2] + _extract_numbers_from_sentence(p2))
            table_rows.append(("Lần chạy cuối", v4, nums4))

        # 5. Số chuỗi lỗi từ 3 lần chạy, kèm loại lỗi
        chains = self.signals.get("chains", self.signals.get("threads", []))
        rep_chains = [ch for ch in chains if ch.get("repeated")]
        if rep_chains:
            ch_types = ", ".join(f"`{ch.get('error_type', 'Error')}`" for ch in rep_chains)
            v5 = f"{len(rep_chains)} chuỗi ({ch_types}){_cmp_str('n_chains_repeated')}"
            table_rows.append(("Chuỗi lỗi lặp", v5, [len(rep_chains), 3]))
        else:
            table_rows.append(("Chuỗi lỗi lặp", "0 chuỗi", [0]))

        # 6. Số dòng thêm theo nhóm
        lg = f.get("lines_by_group", {})
        t_l, p_l, a_l, u_l = lg.get("typed", 0), lg.get("paste_other", 0), lg.get("ai", 0), lg.get("unknown", 0)
        v6 = f"{t_l} dòng tự gõ, {p_l} dòng dán, {a_l} dòng từ AI, {u_l} dòng không rõ nguồn"
        table_rows.append(("Dòng thêm theo nhóm", v6, [t_l, p_l, a_l, u_l]))
        ul_l = lg.get("unlogged", 0)
        if ul_l > 0:
            n_rs = len(f.get("unlogged_minutes", []))
            table_rows.append(("Thay đổi log IDE không ghi",
                               f"{ul_l} dòng có trong ảnh chụp code ở log máy chủ mà log IDE không ghi, ở {n_rs} lần gửi yêu cầu AI",
                               [ul_l, n_rs]))

        # 7. Tỷ lệ ký tự trong bản cuối theo nhóm
        cg = f.get("chars_final_by_group", {})
        tot_c = sum(cg.values())
        if tot_c > 0:
            pt = int(round(cg.get("typed", 0) * 100.0 / tot_c))
            pp = int(round(cg.get("paste_other", 0) * 100.0 / tot_c))
            pa = int(round(cg.get("ai", 0) * 100.0 / tot_c))
            pu = max(0, 100 - pt - pp - pa)
            v7 = f"{pt}% tự gõ, {pp}% dán, {pa}% từ AI, {pu}% không rõ nguồn"
            table_rows.append(("Tỷ lệ bản cuối", v7, [pt, pp, pa, pu]))

        # 8. Yêu cầu AI
        n_req = f.get("n_requests", 0)
        if n_req > 0:
            rf = f.get("n_requests_by_flag", {})
            nc = f.get("n_responses_no_code", 0)
            x_rej = f.get("n_requests_rejected", 0)
            rej_str = f"; {x_rej} yêu cầu bị hệ thống từ chối" if x_rej > 0 else ""
            v8 = f"{n_req} ({rf.get('error', 0)} kèm lỗi, {rf.get('task', 0)} kèm đề bài, {rf.get('own_code', 0)} kèm code); {nc} câu trả lời không có code{rej_str}{_cmp_str('n_requests_total')}"
            v8_nums = [n_req, rf.get('error', 0), rf.get('task', 0), rf.get('own_code', 0), nc]
            if x_rej > 0:
                v8_nums.append(x_rej)
            table_rows.append(("Yêu cầu AI", v8, v8_nums))
        else:
            table_rows.append(("Yêu cầu AI", "0 yêu cầu", [0]))

        # 9. Cuộc hội thoại theo nhãn (luôn kèm nguồn)
        cv_map = f.get("conversations_by_label", {})
        tot_cv = sum(cv_map.values())
        if tot_cv > 0:
            v9 = f"Theo bộ phân loại của F-VSCode: {tot_cv} cuộc hội thoại ({cv_map.get('M', 0)} hỗn hợp, {cv_map.get('I', 0)} kiến tạo, {cv_map.get('E', 0)} ủy thác"
            nums9 = [tot_cv, cv_map.get('M', 0), cv_map.get('I', 0), cv_map.get('E', 0)]
            if cv_map.get("unknown", 0) > 0:
                v9 += f", {cv_map['unknown']} không ghép được nhãn"
                nums9.append(cv_map["unknown"])
            v9 += ")"
            table_rows.append(("Hội thoại theo nhãn", v9, nums9))

        # 10. Số chuỗi yêu cầu kèm lỗi, chuỗi chèn, lỗi, hỏi lại
        n_rc = f.get("n_request_error_chains", 0)
        n_ic = f.get("n_insert_error_ask_chains", 0)
        v10 = f"{n_rc} chuỗi yêu cầu kèm lỗi, {n_ic} chuỗi chèn, lỗi, hỏi lại"
        table_rows.append(("Chuỗi sự việc AI", v10, [n_rc, n_ic]))

        # 11. Đoạn code AI theo số phận
        fates = f.get("ai_fates", {})
        tot_f = sum(fates.values())
        if tot_f > 0:
            v11 = f"{tot_f} ({fates.get('intact', 0)} còn nguyên, {fates.get('partial', 0)} sửa một phần, {fates.get('discarded', 0)} bị xóa)"
            table_rows.append(("Số phận code AI", v11, [tot_f, fates.get('intact', 0), fates.get('partial', 0), fates.get('discarded', 0)]))

        # 12. Nguồn kết quả lần chạy
        dq2 = f.get("share_runs_observed", 1.0)
        if f.get("runs_from_capture"):
            v12 = (f"Log IDE không ghi lệnh terminal; {f['runs_from_capture']} lần chạy và kết quả lấy từ terminal chụp "
                   "ở log máy chủ lúc gửi yêu cầu AI, chỉ biết mốc chậm nhất")
            table_rows.append(("Nguồn kết quả chạy", v12, [f["runs_from_capture"]]))
        elif dq2 < 1.0:
            pct_obs = int(round(dq2 * 100))
            v12 = f"Kết quả lần chạy lấy từ log terminal của F-VSCode; {pct_obs}% số lần chạy có kết quả"
            table_rows.append(("Nguồn kết quả chạy", v12, [pct_obs]))

        # 13. Kiểm code dựng lại (DQ1): chỉ ghi khi chưa đạt
        recon = f.get("reconstruction") or {}
        pct_ul = int(round(recon.get("unlogged_share", 0) * 100))
        if recon.get("level") == "fail":
            table_rows.append(("Kiểm code dựng lại",
                               f"Không đạt: khoảng {pct_ul}% code của buổi có trong snapshot ở log máy chủ mà log IDE "
                               "không ghi, nên phần kể về thay đổi code không đầy đủ", [pct_ul]))
        elif recon.get("level") == "warn":
            table_rows.append(("Kiểm code dựng lại",
                               f"Cảnh báo: khoảng {pct_ul}% code của buổi có trong snapshot ở log máy chủ mà log IDE "
                               f"không ghi, {len(recon.get('end_files_diff') or [])} file khác snapshot cuối buổi", [pct_ul]))
        elif recon.get("level") == "unverified":
            table_rows.append(("Kiểm code dựng lại",
                               "Chưa kiểm được: buổi không có snapshot nào để so với code dựng lại", []))

        # Build items and markdown
        items = []
        md_lines = ["| Mục | Giá trị |", "|---|---|"]
        for lbl, val, nums in table_rows:
            items.append({
                "id": f"O{idx:02d}",
                "kind": "table_row",
                "label": lbl,
                "value": val,
                "sentences": [val],
                "facts": {
                    "numbers": [float(x) for x in nums if x is not None],
                    "minutes": [],
                },
                "sources": [],
                "event_types": {"table"},
            })
            idx += 1
            md_lines.append(f"| {lbl} | {val} |")

        return items, "\n".join(md_lines)

    def _build_ai_code_items(self) -> Tuple[List[Dict[str, Any]], str]:
        """Spec 05 Section 6: Build retained AI chunks profile D1–D5 & discarded notes."""
        # Kể các đoạn dài nhất trước, xếp theo lines_end giảm dần (đặc tả 05 mục 6)
        retained = sorted(self.facts.get("ai_chunks_retained", []),
                          key=lambda c: -c.get("lines_end", c.get("lines", 0)))
        discarded = self.facts.get("ai_chunks_discarded", [])
        items = []
        md_lines = []
        idx = 60

        if not retained:
            no_code_sent = "Bản cuối không có đoạn code nào từ AI."
            if discarded:
                d_cnt = len(discarded)
                m_disc = [minute_label(d.get("t_drop", 0)) for d in discarded]
                if d_cnt == 1:
                    d0 = discarded[0]
                    no_code_sent += f" Một đoạn code AI khác ({d0.get('lines', 0)} dòng, thêm ở phút {minute_label(d0.get('t_insert', 0))}) bị xóa ở phút {minute_label(d0.get('t_drop', 0))}."
                else:
                    m_str = ", ".join(str(m) for m in m_disc)
                    no_code_sent += f" {d_cnt} đoạn code AI khác bị xóa, ở các phút {m_str}."
            return [], no_code_sent

        max_show = self.params.get("aicode.max_items", 4)
        shown = retained[:max_show]
        extra = retained[max_show:]

        for c in shown:
            sentences = []
            nums = []
            mins = []

            lines_end = c.get("lines_end", c.get("lines", 0))
            nums.append(lines_end)
            fn = _display_file(c.get("file"))
            funcs = c.get("funcs", [])
            title_prefix = f"Hàm `{funcs[0]}`" if funcs else f"Đoạn trong `{fn}`"

            m_ins = minute_label(c.get("t_insert", 0))
            mins.append(m_ins)
            sentences.append(f"{title_prefix}, {lines_end} dòng, thêm ở phút {m_ins}.")

            # D2: Lần chạy kế tiếp
            d2 = c.get("D2")
            if d2:
                m_run = d2.get("minute", m_ins)
                mins.append(m_run)
                oc_str = self._format_single_run_outcome(d2.get("outcome"), None)
                nums.extend(_extract_numbers_from_sentence(oc_str))
                sentences.append(f"Lần chạy kế tiếp ở phút {m_run}, {oc_str}.")

            # D1: Có thay đổi trước lần chạy đó
            if c.get("D1"):
                sentences.append("Có thay đổi vào đoạn này trước lần chạy đó.")

            # D3: Xem code trên màn hình
            d3 = c.get("D3")
            if d3 and isinstance(d3, dict) and "before_first_run" in d3:
                v_cnt = d3.get("before_first_run", 0)
                if v_cnt > 0:
                    nums.append(v_cnt)
                    sentences.append(f"Vùng code này hiện trên màn hình {v_cnt} lần trước lần chạy đầu.")

            # D4: Yêu cầu AI chứa đoạn này
            d4 = c.get("D4", [])
            if len(d4) == 1:
                m4 = d4[0].get("minute", m_ins)
                mins.append(m4)
                sentences.append(f"Ở phút {m4}, có yêu cầu AI chứa đoạn này.")
            elif len(d4) > 1:
                m4 = d4[0].get("minute", m_ins)
                nums.append(len(d4))
                mins.append(m4)
                sentences.append(f"Có {len(d4)} yêu cầu AI chứa đoạn này, lần đầu ở phút {m4}.")

            # D5: Sửa đoạn này sau lần chạy đầu
            d5 = c.get("D5", [])
            if len(d5) == 1:
                d5_0 = d5[0]
                m5 = d5_0.get("minute", m_ins)
                l5 = d5_0.get("lines", 1)
                nums.append(l5)
                mins.append(m5)
                after_fail_clause = ", ngay sau lần chạy có lỗi" if d5_0.get("after_fail") else ""
                sentences.append(f"Ở phút {m5}, {l5} dòng của đoạn này được sửa{after_fail_clause}.")
            elif len(d5) > 1:
                m5 = d5[0].get("minute", m_ins)
                nums.append(len(d5))
                mins.append(m5)
                sentences.append(f"Đoạn này được sửa {len(d5)} lần sau lần chạy đầu, lần đầu ở phút {m5}.")

            # Fate
            s_end = c.get("s_end", 1.0)
            if s_end >= 1.0:
                sentences.append("Còn nguyên ở cuối buổi.")
            else:
                pct = int(round(s_end * 10) * 10)
                nums.append(pct)
                sentences.append(f"Còn khoảng {pct}% ký tự ở cuối buổi.")

            full_rendered = " ".join(sentences)
            items.append({
                "id": f"O{idx:02d}",
                "kind": "ai_chunk_row",
                "lineage": c.get("lineage"),
                "rendered": full_rendered,
                "sentences": sentences,
                "facts": {
                    "numbers": [float(x) for x in nums if x is not None],
                    "minutes": mins,
                },
                "segment_ids": c.get("segment_ids", ["D01"]),
                "sources": [c.get("lineage")],
                "event_types": {"ai_chunk"},
            })
            idx += 1
            md_lines.append(f"- {full_rendered}")

        if extra:
            tot_extra_lines = sum(c.get("lines_end", c.get("lines", 0)) for c in extra)
            md_lines.append(f"Còn {len(extra)} đoạn code AI ngắn hơn, tổng {tot_extra_lines} dòng.")

        if discarded:
            d_cnt = len(discarded)
            m_disc = [minute_label(d.get("t_drop", 0)) for d in discarded]
            if d_cnt == 1:
                d0 = discarded[0]
                md_lines.append(f"Một đoạn code AI khác ({d0.get('lines', 0)} dòng, thêm ở phút {minute_label(d0.get('t_insert', 0))}) bị xóa ở phút {minute_label(d0.get('t_drop', 0))}.")
            else:
                m_str = ", ".join(str(m) for m in m_disc)
                md_lines.append(f"{d_cnt} đoạn code AI khác bị xóa, ở các phút {m_str}.")

        return items, "\n".join(md_lines)

    # =========================================================================
    # Helpers for outcome realization & templates
    # =========================================================================
    def _format_single_run_outcome(self, outcome: str, error_type: Optional[str] = None) -> str:
        """Spec 05 Section 4.1: Cụm từ cho một lần chạy."""
        if outcome == "error":
            if error_type == "CommandNotFoundException":
                return "lệnh không chạy, PowerShell báo `CommandNotFoundException`"
            if error_type == "HTTP500":
                return "trang trả mã 500"
            return f"có lỗi `{error_type or 'Error'}`"
        elif outcome == "test_fail":
            return "có test trượt"
        elif outcome == "server_started":
            return "server đã lên"
        elif outcome == "no_error_seen":
            return "phần in ra không có thông báo lỗi"
        else:
            return "log không cho thấy kết quả"

    def _format_run_outcome_phrase(self, run: Dict[str, Any]) -> str:
        tests = run.get("tests")
        if tests and tests.get("passed") is not None:
            p = len(tests.get("passed", []))
            f = len(tests.get("failed", []))
            tot = p + f
            fl = tests.get("failed", [])
            lbl_str = f', trượt "{fl[0]}"' if fl else ""
            return f"{p}/{tot} test qua{lbl_str}"
        outcome, error_type = run.get("outcome", "unknown"), run.get("error_type")
        code, pages = run.get("last_page_code"), run.get("page_loads")
        if outcome == "error" and code and int(code) >= 500 and error_type != "HTTP500":
            return f"trang trả mã {code}" + (f" kèm lỗi `{error_type}`" if error_type else "")
        if outcome == "server_started" and pages and code:
            until = f" tới phút {run['last_page_minute']}" if run.get("last_page_minute") else ""
            return f"server đã lên, log thấy {pages} lần tải trang{until}, lần cuối có mã {code}"
        return self._format_single_run_outcome(outcome, error_type)

    def _format_grouped_run_outcomes(self, outcomes: Dict[str, int]) -> str:
        """Spec 05 Section 4.1: Cụm trong nhóm lần chạy."""
        parts = []
        for oc, name in [
            ("no_error_seen", "không thấy lỗi"),
            ("error", "có lỗi"),
            ("test_fail", "có test trượt"),
            ("server_started", "server đã lên"),
            ("unknown", "không rõ kết quả"),
        ]:
            cnt = outcomes.get(oc, 0)
            if cnt > 0:
                parts.append(f"{cnt} {name}")
        return ", ".join(parts) if parts else "không rõ kết quả"

    def _find_seg_id(self, t: int) -> str:
        for s in self.segments:
            if s.t_start <= t <= s.t_end:
                return s.id
        return self.segments[0].id if self.segments else "D01"

    def _infer_item_event_types(self, template_or_type: str, text: str) -> Set[str]:
        evs = set()
        s_low = text.lower()
        if "chạy" in s_low:
            evs.add("run")
        if "test" in s_low or "trượt" in s_low or "qua" in s_low:
            evs.add("tests")
        if "lỗi" in s_low:
            evs.add("error")
            for m in re.finditer(r'\b(\w+(?:Error|Exception))\b', text):
                evs.add(f"error_{m.group(1)}")
        if "server đã lên" in s_low:
            evs.add("server_started")
        if "không thấy lỗi" in s_low or "không có thông báo lỗi" in s_low:
            evs.add("no_error_seen")
        if "không rõ kết quả" in s_low or "không cho thấy kết quả" in s_low:
            evs.add("unknown")
        if "ai" in s_low or "yêu cầu" in s_low or "hỏi" in s_low:
            evs.add("ai_request")
        if "câu trả lời" in s_low or "áp" in s_low:
            evs.add("ai_insert")
        if "dán" in s_low:
            evs.add("paste")
        if "xóa" in s_low:
            evs.add("delete")
        if "không có thao tác" in s_low or "khoảng không thao tác" in s_low or "dừng" in s_low or "ngừng" in s_low:
            evs.add("pause")
        if "trùng nguyên văn" in s_low:
            evs.add("match_verbatim")
        if "gần như trùng" in s_low:
            evs.add("match_close")
        return evs

    # =========================================================================
    # M5 Realization and Rendering
    # =========================================================================
    def _build_template_draft(self, kp_items: List[Dict[str, Any]], tl_items: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Spec 06 Section 5: Deterministic fallback draft."""
        kp_draft = []
        for it in kp_items:
            kp_draft.append({
                "item_ids": [it["id"]],
                "text": " ".join(it.get("sentences", [it.get("text", "")])),
            })

        tl_draft = []
        for it in tl_items:
            tl_draft.append({
                "item_id": it["id"],
                "text": " ".join(it.get("sentences", [it.get("text", "")])),
            })

        return {"key_points": kp_draft, "timeline": tl_draft}

    def _render_key_points_from_draft(self, draft_kp: List[Dict[str, Any]], kp_items: List[Dict[str, Any]]) -> str:
        kp_map = {it["id"]: it for it in kp_items}
        parts = []
        for entry in draft_kp:
            txt = (entry.get("text") or "").strip()
            if not txt:
                continue
            i_ids = entry.get("item_ids") or []
            seg_refs = set()
            for iid in i_ids:
                if iid in kp_map:
                    seg_refs.update(kp_map[iid].get("segment_ids", []))
            ref_str = f" [{', '.join(sorted(seg_refs))}]" if seg_refs else " [cả buổi]"
            if not txt.endswith("."):
                txt += "."
            parts.append(f"{txt}{ref_str}")
        return " ".join(parts)

    def _render_timeline_from_draft(self, draft_tl: List[Dict[str, Any]], tl_all_items: List[Dict[str, Any]]) -> str:
        realized_map = {entry.get("item_id"): entry.get("text", "").strip() for entry in draft_tl if isinstance(entry, dict)}
        lines = []
        for it in tl_all_items:
            iid = it["id"]
            if it["kind"] == "compressed":
                txt = " ".join(it.get("sentences", [it.get("text", "")]))
            else:
                txt = realized_map.get(iid) or " ".join(it.get("sentences", [it.get("text", "")]))
            if not txt:
                continue
            seg_str = f" [{', '.join(it.get('segment_ids', []))}]" if it.get("segment_ids") else ""
            lines.append(f"- {txt}{seg_str}")
            if it.get("detail_md"):
                lines.append("\n" + it["detail_md"] + "\n")
        return "\n".join(lines)

    # =========================================================================
    # M6: Automated Validation K1 - K6 (Spec 07)
    # =========================================================================
    def _check_draft_k1_to_k5(
        self,
        draft: Dict[str, Any],
        kp_items: List[Dict[str, Any]],
        tl_llm_items: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Spec 07 Section 2: Executes K1, K2, K3, K4, K5 checks on `draft`."""
        errors: List[Dict[str, Any]] = []
        if not isinstance(draft, dict):
            return [{"check": "K1", "item_id": "ROOT", "sentence": "", "detail": "draft không phải JSON object"}]

        draft_kp = draft.get("key_points")
        draft_tl = draft.get("timeline")
        if not isinstance(draft_kp, list) or not isinstance(draft_tl, list):
            return [{"check": "K1", "item_id": "ROOT", "sentence": "", "detail": "Thiếu key_points hoặc timeline"}]

        kp_map = {it["id"]: it for it in kp_items}
        tl_map = {it["id"]: it for it in tl_llm_items}

        # K1: Source item_ids validity & timeline ordering
        referenced_kp_ids: Set[str] = set()
        for idx, entry in enumerate(draft_kp):
            i_ids = entry.get("item_ids") if isinstance(entry, dict) else None
            sent_txt = entry.get("text", "") if isinstance(entry, dict) else ""
            if not i_ids or not isinstance(i_ids, list):
                errors.append({"check": "K1", "item_id": f"kp[{idx}]", "sentence": sent_txt, "detail": "item_ids rỗng"})
                continue
            for iid in i_ids:
                if iid not in kp_map:
                    errors.append({"check": "K1", "item_id": str(iid), "sentence": sent_txt, "detail": f"Mã {iid} không thuộc key_point của dàn ý"})
                else:
                    referenced_kp_ids.add(iid)

        expected_tl_ids = [it["id"] for it in tl_llm_items]
        actual_tl_ids = [entry.get("item_id") for entry in draft_tl if isinstance(entry, dict)]
        if actual_tl_ids != expected_tl_ids:
            errors.append({
                "check": "K1",
                "item_id": "timeline",
                "sentence": "",
                "detail": f"Danh sách timeline item_id {actual_tl_ids} không khớp thứ tự dàn ý {expected_tl_ids}",
            })

        # Collect units for K2 - K5: (label, sentence, source_items)
        units: List[Tuple[str, str, List[Dict[str, Any]]]] = []
        for entry in draft_kp:
            if isinstance(entry, dict):
                s_txt = (entry.get("text") or "").strip()
                i_ids = entry.get("item_ids") or []
                src_its = [kp_map[iid] for iid in i_ids if iid in kp_map]
                if s_txt and src_its:
                    units.append(("+".join(i_ids), s_txt, src_its))

        for entry in draft_tl:
            if isinstance(entry, dict):
                iid = entry.get("item_id", "")
                src_it = tl_map.get(iid)
                if src_it:
                    for s_txt in _split_sentences(entry.get("text") or ""):
                        units.append((iid, s_txt, [src_it]))

        word_num_re = re.compile(
            r'(?<!\w)(một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)\s+(lần|dòng|phút|giây|test|yêu cầu|ký tự)(?!\w)',
            re.IGNORECASE,
        )

        for item_label, sent, src_its in units:
            allowed: Set[float] = set()
            allowed_evs: Set[str] = set()
            for sit in src_its:
                f_obj = sit.get("facts", {})
                for x in f_obj.get("numbers", []) + f_obj.get("minutes", []):
                    try:
                        allowed.add(float(x))
                    except (TypeError, ValueError):
                        pass
                allowed_evs.update(sit.get("event_types", set()))

            # K2: Numbers & word-number
            found_nums = _extract_numbers_from_sentence(sent)
            for num in found_nums:
                if num not in allowed:
                    n_disp = int(num) if num.is_integer() else num
                    errors.append({
                        "check": "K2",
                        "item_id": item_label,
                        "sentence": sent,
                        "detail": f"số {n_disp} không có trong facts ({sorted(int(a) if a.is_integer() else a for a in allowed)})",
                    })

            for wm in word_num_re.finditer(sent):
                w_word = wm.group(1).lower()
                w_unit = wm.group(2).lower()
                if w_word == "một" and w_unit in ("lần", "yêu cầu") and 1.0 in allowed:
                    continue
                errors.append({
                    "check": "K2",
                    "item_id": item_label,
                    "sentence": sent,
                    "detail": f"số viết bằng chữ trước đơn vị đếm: \"{wm.group(0)}\"",
                })

            # K3: Event keywords
            s_low = sent.lower()
            if re.search(r'(?<!\w)dán(?!\w)', s_low) and "paste" not in allowed_evs:
                errors.append({"check": "K3", "item_id": item_label, "sentence": sent, "detail": "cụm từ dán nhưng nguồn không có sự kiện dán"})
            if "trùng nguyên văn" in s_low and "match_verbatim" not in allowed_evs and not any(it.get("template") == "KC6" for it in src_its):
                errors.append({"check": "K3", "item_id": item_label, "sentence": sent, "detail": "cụm từ 'trùng nguyên văn' nhưng nguồn không có match.level=verbatim"})
            for err_m in re.finditer(r'\b(\w+(?:Error|Exception))\b', sent):
                et_name = err_m.group(1)
                if f"error_{et_name}" not in allowed_evs and "error" not in allowed_evs:
                    errors.append({"check": "K3", "item_id": item_label, "sentence": sent, "detail": f"tên lỗi {et_name} không có trong nguồn"})

            # K4: Forbidden words
            for fw in FORBIDDEN_WORDS:
                pattern = r'(?<!\w)' + re.escape(fw.lower()) + r'(?!\w)'
                if re.search(pattern, s_low):
                    errors.append({
                        "check": "K4",
                        "item_id": item_label,
                        "sentence": sent,
                        "detail": f'từ cấm: "{fw}"',
                    })

        # K5: Outline coverage
        for it in tl_llm_items:
            if it.get("mandatory"):
                t_ent = next((entry for entry in draft_tl if entry.get("item_id") == it["id"]), None)
                if not t_ent or not t_ent.get("text"):
                    errors.append({
                        "check": "K5",
                        "item_id": it["id"],
                        "sentence": "",
                        "detail": f"Mục timeline bắt buộc {it['id']} bị thiếu trong bản nháp",
                    })

        # K3 (giữ nguồn và mức khớp): cụm nói nguồn của lần thêm hay mức khớp với câu trả lời AI có trong câu nguồn
        # của một mục dòng thời gian thì câu viết lại của mục đó phải còn cụm ấy (mô hình hay bỏ "từ ngoài IDE",
        # hay viết "gần như trùng" thành "trùng")
        keep_phrases = ("từ ngoài IDE", "từ khung chat AI", "từ chính các file của bài", "không qua gõ phím",
                        "gần như trùng", "trùng nguyên văn", "khớp một phần")
        for entry in draft_tl:
            src_it = tl_map.get(entry.get("item_id"))
            if not src_it:
                continue
            src_txt = " ".join(src_it.get("sentences") or [src_it.get("text", "")])
            out_txt = entry.get("text") or ""
            for ph in keep_phrases:
                if ph in src_txt and ph not in out_txt:
                    errors.append({"check": "K3", "item_id": entry.get("item_id"), "sentence": "",
                                   "detail": f"câu nguồn có cụm \"{ph}\" nhưng câu viết lại bỏ mất, phải giữ nguyên cụm này"})

        return errors

    def _check_k6_sections(self, md_content: str, table_md: str, ai_code_md: str) -> List[Dict[str, Any]]:
        """Spec 07 Section 2 K6: Exact section matching for Reference Table & AI Code."""
        errs = []
        if "**Số liệu tham chiếu.**" not in md_content:
            errs.append({"check": "K6", "item_id": "table", "sentence": "", "detail": "Thiếu mục Số liệu tham chiếu"})
        if "**Đoạn code AI trong bản cuối.**" not in md_content:
            errs.append({"check": "K6", "item_id": "ai_code", "sentence": "", "detail": "Thiếu mục Đoạn code AI trong bản cuối"})
        return errs
