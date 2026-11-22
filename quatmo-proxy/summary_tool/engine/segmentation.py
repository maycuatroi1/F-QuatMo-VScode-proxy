# -*- coding: utf-8 -*-
"""
Segmentation module (M2) for PhaseSUMMARY Engine.
Implements Spec 03 (Chia đoạn):
1. Steps (Bước): replay anchors along the timeline
2. Segments (Đoạn): 4-step priority partitioning (pause > ai > debug > write)
3. Threads (Mạch): connecting debug and ai segments within the same error thread
"""

import math
from typing import Dict, List, Any, Optional, Tuple
from .constants import DEFAULT_PARAMS, minute_label


class Segment:
    def __init__(
        self,
        seg_id: str,
        seg_type: str,
        t_start: int,
        t_end: int,
        thread_id: Optional[str] = None,
        raw_thread_id: Optional[str] = None,
        closing_run_id: Optional[str] = None,
    ):
        self.id = seg_id
        self.type = seg_type  # 'pause', 'ai', 'error_chain', 'write' (Spec 03 Version 3.0)
        self.t_start = int(t_start)
        self.t_end = int(t_end)
        self.thread_id = thread_id
        self.raw_thread_id = raw_thread_id
        self.closing_run_id = closing_run_id
        self.minute_start = 0
        self.minute_end = 0
        self.event_ids: List[str] = []
        self.step_ids: List[str] = []
        self.events: List[Any] = []
        self.facts: Dict[str, Any] = {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "t_start": self.t_start,
            "t_end": self.t_end,
            "minute_start": self.minute_start,
            "minute_end": self.minute_end,
            "event_ids": self.event_ids,
            "step_ids": self.step_ids,
            "thread_id": self.thread_id,
            "facts": self.facts,
        }


def _subtract_intervals(
    base_intervals: List[Tuple[int, int]],
    cut_intervals: List[Tuple[int, int]],
) -> List[Tuple[int, int]]:
    """Subtracts cut_intervals from base_intervals."""
    result = list(base_intervals)
    for cs, ce in cut_intervals:
        if ce <= cs:
            continue
        next_result = []
        for bs, be in result:
            if ce <= bs or cs >= be:
                next_result.append((bs, be))
            else:
                if bs < cs:
                    next_result.append((bs, cs))
                if ce < be:
                    next_result.append((ce, be))
        result = next_result
    return [(s, e) for s, e in result if e > s]


class SessionSegmenter:
    def __init__(self, session_data, signals: Dict[str, Any], params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.signals = signals
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)
        self.steps: List[Dict[str, Any]] = []
        self.m_threads: List[Dict[str, Any]] = []

    def _build_steps(self) -> List[Dict[str, Any]]:
        """Spec 03 Section 1: Build replay steps."""
        raw_steps = []
        edits = getattr(self.data, "edits", [])
        runs = self.signals.get("runs", [])
        requests = self.signals.get("requests", [])
        pauses = self.signals.get("pauses", [])
        pause_step_ms = self.params.get("pause.step_ms", 120000)

        for e in edits:
            if e.get("cancelled") or e.get("origin") == "resync":
                continue
            src = e.get("src", "typed")
            if src == "typed":
                if "\n" in (e.get("inserted") or ""):
                    raw_steps.append((int(e["t"]), "line_typed", e["id"]))
            elif src in ("paste_external", "paste_unknown", "paste_chat", "ai_insert", "ai_agent"):
                raw_steps.append((int(e["t"]), "paste_or_ai", e["id"]))

        for r in runs:
            raw_steps.append((int(r["t"]), "run", r["id"]))

        for q in requests:
            raw_steps.append((int(q["t"]), "ai_request", q.get("event_id") or q["request_id"]))
            if q.get("t_end") is not None and q["t_end"] > q["t"]:
                raw_steps.append((int(q["t_end"]), "ai_response", q.get("response_event_id") or q["request_id"]))

        for p in pauses:
            if p.get("length", 0) >= pause_step_ms:
                raw_steps.append((int(p["start"]), "pause_start", p["id"]))
                raw_steps.append((int(p["end"]), "pause_end", p["id"]))

        raw_steps.sort(key=lambda x: (x[0], x[1], x[2]))
        steps = []
        for idx, (t_val, kind, ev_id) in enumerate(raw_steps, start=1):
            steps.append({
                "id": f"s{idx:04d}",
                "t": t_val,
                "kind": kind,
                "event_id": ev_id,
            })
        return steps

    def segment(self) -> List[Segment]:
        """Runs the 4-step priority segmentation algorithm (Spec 03 Section 2)."""
        duration_ms = max(int(self.data.end_ts - self.data.start_ts), 0)
        if duration_ms <= 0:
            duration_ms = 60000

        self.steps = self._build_steps()
        self.signals["steps"] = self.steps

        pauses = self.signals.get("pauses", [])
        requests = sorted(self.signals.get("requests", []), key=lambda x: x["t"])
        threads = self.signals.get("threads", [])
        runs = sorted(self.signals.get("runs", []), key=lambda x: x["t"])
        # Lần chạy dựng từ terminal chụp (A17) chỉ có cận trên của mốc, nên không dùng để đóng đoạn hỏi AI
        runs_known = [r for r in runs if r.get("t_source") != "capture"]
        edits = sorted(
            [e for e in getattr(self.data, "edits", []) if not e.get("cancelled") and e.get("origin") != "resync"],
            key=lambda x: x["t"],
        )

        # 1. Pause segments (length >= pause.segment_ms, default 3 min)
        min_pause_ms = self.params.get("pause.segment_ms", 180000)
        pause_Ranges: List[Tuple[int, int]] = []
        for p in pauses:
            if p.get("length", 0) >= min_pause_ms:
                ps = max(0, int(p["start"]))
                pe = min(duration_ms, int(p["end"]))
                if pe > ps:
                    pause_Ranges.append((ps, pe))

        # 2. AI segments
        idle_close_ms = self.params.get("ai.segment_idle_close_ms", 300000)
        ai_segments_raw: List[Tuple[int, int, Optional[str]]] = []  # (s, e, closing_run_id)
        used_req_ids = set()

        for idx, q in enumerate(requests):
            if q["request_id"] in used_req_ids:
                continue
            seg_start = int(q["t"])
            last = q
            closing_run_id = None
            cur_idx = idx
            seg_req_ids = set()

            while True:
                used_req_ids.add(last["request_id"])
                seg_req_ids.add(last["request_id"])
                r_end = int(last.get("t_end") or last["t"])

                # Linked insertions for any request in `seg_req_ids`
                linked_ins = [
                    e for e in edits
                    if e["t"] >= seg_start
                    and not e.get("repaste_of")
                    and (
                        (e.get("match") and e["match"].get("request_id") in seg_req_ids and e["match"].get("level") in ("verbatim", "close"))
                        or e.get("ai_ref") in seg_req_ids
                    )
                    and e["t"] <= r_end + idle_close_ms * 2
                ]

                idle_end = r_end + idle_close_ms
                closing_run_id = None

                if linked_ins:
                    last_ins_t = int(max(e["t"] for e in linked_ins))
                    idle_end = max(idle_end, last_ins_t + idle_close_ms)
                    after_ins_runs = [r for r in runs_known if r["t"] >= last_ins_t]
                    if after_ins_runs and after_ins_runs[0]["t"] <= idle_end:
                        end = int(after_ins_runs[0].get("t_end") or after_ins_runs[0]["t"])
                        closing_run_id = after_ins_runs[0]["id"]
                    else:
                        end = min(duration_ms, idle_end)
                else:
                    # First typed edit or run after r_end
                    next_typed = next((e["t"] for e in edits if e["t"] > r_end and e.get("src") == "typed"), None)
                    next_run = next((r["t"] for r in runs_known if r["t"] > r_end), None)
                    cands = [x for x in (next_typed, next_run, idle_end) if x is not None]
                    end = int(min(cands)) if cands else min(duration_ms, idle_end)

                end = max(end, r_end)
                if linked_ins:
                    end = max(end, int(max(e["t"] for e in linked_ins)))
                end = min(end, duration_ms)

                # Check if next request happens before `end`
                if cur_idx + 1 < len(requests):
                    nq = requests[cur_idx + 1]
                    if nq["t"] <= end:
                        last = nq
                        cur_idx += 1
                        continue
                break

            # Cut seg at any pause segment inside (pause has higher priority)
            pieces = _subtract_intervals([(seg_start, end)], pause_Ranges)
            for ps, pe in pieces:
                # Keep piece if it contains an AI request, response, linked insertion, or closing run
                has_ai_activity = any(ps <= rq["t"] <= pe or ps <= rq.get("t_end", rq["t"]) <= pe for rq in requests)
                if not has_ai_activity:
                    has_ai_activity = any(
                        ps <= e["t"] <= pe and e.get("src") in ("ai_insert", "ai_agent", "paste_chat")
                        for e in edits
                    )
                if has_ai_activity or ( not pieces or (ps == pieces[0][0] and pe == pieces[0][1]) ):
                    c_run = closing_run_id if pe == end else None
                    ai_segments_raw.append((ps, pe, c_run))

        # Merge overlapping or contiguous AI intervals
        ai_segments_raw.sort(key=lambda x: (x[0], x[1]))
        ai_merged: List[Tuple[int, int, Optional[str]]] = []
        for s, e, c_run in ai_segments_raw:
            if not ai_merged:
                ai_merged.append((s, e, c_run))
            else:
                ps, pe, pc_run = ai_merged[-1]
                if s <= pe:
                    new_e = max(pe, e)
                    new_c = c_run if new_e == e and c_run else pc_run
                    ai_merged[-1] = (ps, new_e, new_c)
                else:
                    ai_merged.append((s, e, c_run))

        occupied: List[Tuple[int, int]] = list(pause_Ranges) + [(s, e) for s, e, _ in ai_merged]

        # 3. Error chain segments from chains (TH3) with len(runs) >= 2 (Spec 03 Section 2)
        error_chain_segments_raw: List[Tuple[int, int, str]] = []
        for th in threads:
            th_runs = th.get("runs", [])
            if len(th_runs) >= 2:
                th_s = int(th_runs[0]["t"])
                th_e = int(th["ended_at_t"]) if th.get("ended_at_t") is not None else int(th_runs[-1].get("t_end") or th_runs[-1]["t"])
                th_e = min(max(th_e, th_s), duration_ms)
                parts = _subtract_intervals([(th_s, th_e)], occupied)
                for ps, pe in parts:
                    error_chain_segments_raw.append((ps, pe, th["id"]))
                    occupied.append((ps, pe))

        # 4. Write segments for remaining intervals
        write_Ranges = _subtract_intervals([(0, duration_ms)], occupied)

        # Assemble all candidate segments
        all_segs: List[Segment] = []
        for ps, pe in pause_Ranges:
            all_segs.append(Segment("", "pause", ps, pe))
        for as_, ae, c_run in ai_merged:
            all_segs.append(Segment("", "ai", as_, ae, closing_run_id=c_run))
        for ds, de, raw_th_id in error_chain_segments_raw:
            all_segs.append(Segment("", "error_chain", ds, de, raw_thread_id=raw_th_id))
        for ws, we in write_Ranges:
            all_segs.append(Segment("", "write", ws, we))

        all_segs.sort(key=lambda seg: (seg.t_start, seg.t_end))

        # Rule (Spec 03 line 64): Merge write segments that have NO edit and NO run
        # into the preceding segment (or following segment if first).
        def _has_edit_or_run(s_start: int, s_end: int) -> bool:
            for e in edits:
                if s_start <= e["t"] <= s_end:
                    return True
            for r in runs:
                if s_start <= r["t"] <= s_end:
                    return True
            for q in requests:
                if s_start <= q["t"] <= s_end:
                    return True
            return False

        if len(all_segs) > 1:
            cleaned: List[Segment] = []
            i = 0
            while i < len(all_segs):
                seg = all_segs[i]
                if seg.type == "write" and not _has_edit_or_run(seg.t_start, seg.t_end):
                    if cleaned:
                        # Merge into preceding segment
                        cleaned[-1].t_end = seg.t_end
                    elif i + 1 < len(all_segs):
                        # Merge into following segment
                        all_segs[i + 1].t_start = seg.t_start
                    else:
                        cleaned.append(seg)
                else:
                    if cleaned and cleaned[-1].type == seg.type and cleaned[-1].raw_thread_id == seg.raw_thread_id:
                        cleaned[-1].t_end = seg.t_end
                        if seg.closing_run_id:
                            cleaned[-1].closing_run_id = seg.closing_run_id
                    else:
                        cleaned.append(seg)
                i += 1
            all_segs = cleaned

        if not all_segs:
            all_segs = [Segment("D01", "write", 0, duration_ms)]

        # Ensure exact contiguous coverage [0, duration_ms]
        all_segs[0].t_start = 0
        for idx in range(len(all_segs) - 1):
            if all_segs[idx].t_end != all_segs[idx + 1].t_start:
                all_segs[idx].t_end = all_segs[idx + 1].t_start
        all_segs[-1].t_end = max(all_segs[-1].t_end, duration_ms)

        # Assign IDs D01, D02, ... and relative minutes
        for idx, seg in enumerate(all_segs, start=1):
            seg.id = f"D{idx:02d}"
            seg.minute_start = minute_label(max(seg.t_start, 0))
            seg.minute_end = max(seg.minute_start, minute_label(seg.t_end))

        # Assign events, runs, requests, and steps to segments
        self._assign_members(all_segs, edits, runs, requests)

        # Spec 03 Section 3: Build Mạch (M01, M02...) linking debug and ai segments in error threads
        self._build_m_threads(all_segs, threads, duration_ms)

        # Populate segment_ids on ai_chunks
        self._link_chunks_to_segments(all_segs)

        return all_segs

    def _find_segment_for_time(
        self,
        segments: List[Segment],
        t: int,
        ev_id: Optional[str] = None,
        is_run: bool = False,
        is_ai_req: bool = False,
    ) -> Segment:
        """
        Spec 03 line 67:
        Events at an exact boundary belong to the segment starting at that boundary,
        EXCEPT the run closing an `ai` segment belongs to that `ai` segment.
        Every `ai_request` must belong to an `ai` segment.
        """
        if is_run and ev_id:
            for seg in segments:
                if seg.type == "ai" and seg.closing_run_id == ev_id:
                    return seg

        if is_ai_req:
            for seg in segments:
                if seg.type == "ai" and seg.t_start <= t <= seg.t_end:
                    return seg
            # Fallback to nearest ai segment
            ai_segs = [seg for seg in segments if seg.type == "ai"]
            if ai_segs:
                return min(ai_segs, key=lambda s: min(abs(s.t_start - t), abs(s.t_end - t)))

        # Boundary rule: if t == seg.t_start, prefer the segment starting at t
        for i, seg in enumerate(segments):
            if i < len(segments) - 1:
                if seg.t_start <= t < seg.t_end:
                    return seg
            else:
                if seg.t_start <= t <= seg.t_end:
                    return seg

        return segments[-1]

    def _assign_members(
        self,
        segments: List[Segment],
        edits: List[Dict[str, Any]],
        runs: List[Dict[str, Any]],
        requests: List[Dict[str, Any]],
    ):
        for e in edits:
            if e.get("origin") == "resync":
                continue
            seg = self._find_segment_for_time(segments, int(e["t"]), e["id"])
            seg.event_ids.append(e["id"])
            e["segment_id"] = seg.id

        for r in runs:
            seg = self._find_segment_for_time(segments, int(r["t"]), r["id"], is_run=True)
            seg.event_ids.append(r["id"])
            r["segment_id"] = seg.id

        for q in requests:
            seg = self._find_segment_for_time(segments, int(q["t"]), q["request_id"], is_ai_req=True)
            ev_id = q.get("event_id") or q["request_id"]
            if ev_id not in seg.event_ids:
                seg.event_ids.append(ev_id)
            q["segment_id"] = seg.id

        for st in self.steps:
            is_run = st["kind"] == "run"
            is_ai_req = st["kind"] == "ai_request"
            seg = self._find_segment_for_time(segments, int(st["t"]), st["event_id"], is_run=is_run, is_ai_req=is_ai_req)
            seg.step_ids.append(st["id"])
            st["segment_id"] = seg.id

    def _build_m_threads(self, segments: List[Segment], threads: List[Dict[str, Any]], duration_ms: int):
        """Spec 03 Section 3: Build Mạch (M01, M02...) and tag error_chain + ai segments."""
        self.m_threads = []
        m_idx = 1
        for th in threads:
            th_runs = th.get("runs", [])
            if len(th_runs) < 2:
                continue
            m_id = f"M{m_idx:02d}"
            m_idx += 1
            th["m_id"] = m_id

            th_start = int(th_runs[0]["t"])
            th_end = int(th["ended_at_t"]) if th.get("ended_at_t") is not None else duration_ms

            seg_ids = []
            for seg in segments:
                if seg.type == "error_chain" and seg.raw_thread_id == th["id"]:
                    seg.thread_id = m_id
                    seg_ids.append(seg.id)
                elif seg.type == "ai" and th_start <= seg.t_start < th_end:
                    if seg.thread_id is None:
                        seg.thread_id = m_id
                    if seg.id not in seg_ids:
                        seg_ids.append(seg.id)

            th["segment_ids"] = seg_ids
            self.m_threads.append({
                "id": m_id,
                "script": th.get("script", "main.py"),
                "signature": th.get("signature", ""),
                "location": th.get("location"),
                "segment_ids": seg_ids,
                "run_ids": [r["id"] for r in th_runs],
                "unknown_between": th.get("unknown_between", 0),
                "ended_at_t": th.get("ended_at_t"),
            })
        self.signals["m_threads"] = self.m_threads

    def _link_chunks_to_segments(self, segments: List[Segment]):
        """Link each ai_chunk in signals['ai_chunks'] to its insertion segment and D4/D5 segments."""
        chunks = self.signals.get("ai_chunks", [])
        for c in chunks:
            t_ins = int(c.get("t_insert", 0))
            ins_seg = self._find_segment_for_time(segments, t_ins, c.get("id"))
            c["insert_segment_id"] = ins_seg.id
            seg_ids = [ins_seg.id]

            for d4 in c.get("D4", []):
                s4 = self._find_segment_for_time(segments, int(d4["t"]), d4.get("request_id"), is_ai_req=True)
                if s4.id not in seg_ids:
                    seg_ids.append(s4.id)

            for d5 in c.get("D5", []):
                s5 = self._find_segment_for_time(segments, int(d5["t"]), d5.get("edit_id"))
                if s5.id not in seg_ids:
                    seg_ids.append(s5.id)

            c["segment_ids"] = seg_ids
