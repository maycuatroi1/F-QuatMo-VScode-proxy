# -*- coding: utf-8 -*-
"""
Segmentation module (M2) for PhaseSUMMARY Engine.
Strictly implements Specification 03 (03 Chia đoạn.md):
- Step generation: Step(id, t, kind, event_id)
- 4-tier priority segmentation: pause >= 3m > ai > debug > write
- AI segment closing rules via ins and idle_close_ms
- Empty write segment merging
- Fault threads M01, M02 linking debug and AI segments
- Invariant guarantees: non-overlapping, covers [0, T_session], each run & ai_request strictly assigned
"""

from typing import Dict, List, Any, Optional, Set, Tuple
from .constants import DEFAULT_PARAMS


class Step:
    def __init__(self, step_id: str, t: int, kind: str, event_id: Optional[str] = None):
        self.id = step_id
        self.t = t
        self.kind = kind  # 'newline', 'run', 'paste_or_ai', 'ai_request', 'ai_response_end', 'pause_edge'
        self.event_id = event_id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "t": self.t,
            "kind": self.kind,
            "event_id": self.event_id
        }


class Segment:
    def __init__(self, seg_id: str, seg_type: str, t_start: int, t_end: int, thread_id: Optional[str] = None):
        self.id = seg_id
        self.type = seg_type  # 'pause', 'ai', 'debug', 'write'
        self.t_start = t_start
        self.t_end = t_end
        self.minute_start = 0
        self.minute_end = 0
        self.thread_id = thread_id
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
            "thread_id": self.thread_id,
            "event_ids": self.event_ids,
            "step_ids": self.step_ids,
            "facts": self.facts
        }


class SessionSegmenter:
    def __init__(self, session_data, signals: Dict[str, Any], params: Optional[Dict[str, Any]] = None):
        self.data = session_data
        self.signals = signals
        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)

    def generate_steps(self) -> List[Step]:
        """
        Generates timeline steps according to Spec 03 Section 1:
        - edit typed with inserted containing '\\n'
        - run
        - edit with src in paste or AI group (not in cancelled pairs)
        - ai_request and ai_response t_end
        - pause edges for pauses >= pause.step_ms (120,000 ms)
        """
        steps: List[Step] = []
        events = getattr(self.data, "events", [])
        requests = self.signals.get("requests", [])
        pauses = self.signals.get("pauses", [])
        pause_step_ms = self.params.get("pause.step_ms", 120000)

        step_events: List[Tuple[int, str, Optional[str]]] = []

        # 1. Edits
        for e in events:
            ename = e.get("name")
            eid = e.get("id")
            t = e.get("t", 0)
            src = e.get("src", "typed")

            if ename in ["typing_chunk", "edit"]:
                inserted = e.get("inserted", "") or e.get("content", "") or ""
                # Edit typed with inserted containing \n
                if src == "typed" and "\n" in inserted:
                    step_events.append((t, "newline", eid))
                # Edit with src in paste or AI group (not cancelled pair)
                elif src in ["paste_external", "paste_internal", "paste_chat", "ai_insert", "ai_agent"]:
                    step_events.append((t, "paste_or_ai", eid))
            elif ename in ["run", "terminal_command"]:
                step_events.append((t, "run", eid))

        # 2. AI requests and response ends
        for q in requests:
            qid = q.get("request_id")
            step_events.append((q.get("t", 0), "ai_request", qid))
            r = q.get("response")
            if r and r.get("t_end"):
                step_events.append((r["t_end"], "ai_response_end", qid))

        # 3. Pause edges >= 2 min
        for p in pauses:
            if p.get("length", 0) >= pause_step_ms:
                step_events.append((p["start"], "pause_edge", None))
                step_events.append((p["end"], "pause_edge", None))

        # Sort by timestamp
        step_events.sort(key=lambda x: x[0])

        # Deduplicate identical (t, kind, eid)
        seen = set()
        for idx, (t, kind, eid) in enumerate(step_events, 1):
            key = (t, kind, eid)
            if key not in seen:
                seen.add(key)
                steps.append(Step(f"s{len(steps)+1:04d}", t, kind, eid))

        return steps

    def segment(self) -> Tuple[List[Segment], List[Dict[str, Any]], List[Step]]:
        """
        Runs the 4-step priority segmentation algorithm per Spec 03 Section 2 & 3.
        Returns (segments, threads, steps).
        """
        events = getattr(self.data, "events", [])
        t_start_session = 0
        t_end_session = max(int(self.data.end_ts - self.data.start_ts), max((e.get("t", 0) for e in events), default=3600000))
        if t_end_session <= 0:
            t_end_session = 3600000

        pauses = self.signals.get("pauses", [])
        requests = self.signals.get("requests", [])
        sig_threads = self.signals.get("threads", [])
        runs = self.signals.get("runs", [])
        chunks = self.signals.get("ai_chunks", [])
        events = getattr(self.data, "events", [])

        # Priority 1: Pause segments >= pause.segment_ms (3 min)
        min_pause_ms = self.params.get("pause.segment_ms", 180000)
        pause_intervals: List[Tuple[int, int]] = []
        for p in pauses:
            if p.get("length", 0) >= min_pause_ms:
                pause_intervals.append((p["start"], p["end"]))

        # Priority 2: AI segments
        ai_intervals: List[Tuple[int, int]] = []
        idle_close_ms = self.params.get("ai.segment_idle_close_ms", 300000)
        sorted_requests = sorted(requests, key=lambda q: q.get("t", 0))

        processed_req_ids = set()
        for q in sorted_requests:
            qid = q.get("request_id")
            if qid in processed_req_ids:
                continue

            q_start = q.get("t", 0)
            # Check if q_start falls in an already covered AI interval
            if any(as_ <= q_start < ae for as_, ae in ai_intervals):
                continue

            last_q = q
            end_t = q_start + idle_close_ms

            while True:
                processed_req_ids.add(last_q.get("request_id"))
                r = last_q.get("response")
                r_end = r.get("t_end", last_q.get("t", 0)) if r else last_q.get("t", 0)

                # Find insertions linked with r
                linked_chunks = [
                    c for c in chunks
                    if c.get("request_id") == last_q.get("request_id")
                    or (c.get("t_insert", 0) >= r_end and c.get("t_insert", 0) <= r_end + idle_close_ms and c.get("match_level") in ["verbatim", "close"])
                ]

                if linked_chunks:
                    last_ins_t = max(c.get("t_insert", 0) for c in linked_chunks)
                    subsequent_runs = [run for run in runs if run.get("t", 0) >= last_ins_t]
                    if subsequent_runs:
                        end_candidate = subsequent_runs[0].get("t_end", subsequent_runs[0].get("t", 0) + 1000)
                    else:
                        end_candidate = last_ins_t + 30000
                else:
                    # First typed edit or run after r_end
                    subseq_actions = [
                        e.get("t", 0) for e in events
                        if e.get("t", 0) > r_end and (
                            e.get("name") in ["run", "terminal_command"] or
                            (e.get("name") in ["typing_chunk", "edit"] and e.get("src") == "typed")
                        )
                    ]
                    end_candidate = subseq_actions[0] if subseq_actions else (r_end + idle_close_ms)

                idle_limit = r_end + idle_close_ms
                cur_end = min(end_candidate, idle_limit) if end_candidate else idle_limit

                # Check if next request occurs before cur_end
                next_reqs = [nq for nq in sorted_requests if nq.get("t", 0) > last_q.get("t", 0) and nq.get("request_id") not in processed_req_ids]
                if next_reqs and next_reqs[0].get("t", 0) < cur_end:
                    last_q = next_reqs[0]
                    end_t = cur_end
                    continue

                end_t = cur_end
                break

            ai_intervals.append((q_start, min(end_t, t_end_session)))

        # Priority 3: Debug segments from threads with >= 2 runs
        debug_spans: List[Tuple[int, int, str]] = []
        for th in sig_threads:
            th_runs = th.get("runs", [])
            if len(th_runs) >= 2:
                s_t = th_runs[0].get("t", 0)
                e_t = th.get("resolved_at") or th_runs[-1].get("t_end", th_runs[-1].get("t", 0) + 1000)
                debug_spans.append((s_t, e_t, th.get("id", "M01")))

        # Collect timeline cuts
        all_cuts = {t_start_session, t_end_session}
        for ps, pe in pause_intervals:
            all_cuts.add(ps); all_cuts.add(pe)
        for as_, ae in ai_intervals:
            all_cuts.add(as_); all_cuts.add(ae)
        for ds, de, _ in debug_spans:
            all_cuts.add(ds); all_cuts.add(de)

        sorted_cuts = sorted(all_cuts)
        raw_slices = []

        for i in range(len(sorted_cuts) - 1):
            s = sorted_cuts[i]
            e = sorted_cuts[i + 1]
            if e <= s or (e - s < 1000):  # skip sub-second cuts
                continue

            mid = (s + e) // 2

            # Priority 1: pause
            if any(ps <= mid < pe for ps, pe in pause_intervals):
                raw_slices.append(("pause", s, e, None))
                continue

            # Priority 2: ai
            if any(as_ <= mid < ae for as_, ae in ai_intervals):
                raw_slices.append(("ai", s, e, None))
                continue

            # Priority 3: debug
            th_match = next((th_id for ds, de, th_id in debug_spans if ds <= mid < de), None)
            if th_match:
                raw_slices.append(("debug", s, e, th_match))
                continue

            # Priority 4: write
            raw_slices.append(("write", s, e, None))

        # Merge adjacent slices with identical (type, thread_id)
        merged_slices = []
        if raw_slices:
            cur_type, cur_s, cur_e, cur_th = raw_slices[0]
            for stype, s, e, th in raw_slices[1:]:
                if stype == cur_type and th == cur_th:
                    cur_e = e
                else:
                    merged_slices.append([cur_type, cur_s, cur_e, cur_th])
                    cur_type, cur_s, cur_e, cur_th = stype, s, e, th
            merged_slices.append([cur_type, cur_s, cur_e, cur_th])

        # Merge empty write segments (no edit and no run) into adjacent segment
        # Spec 03: "gộp đoạn write không có edit và không có run vào đoạn liền trước (nếu có, ngược lại liền sau)"
        final_slices = []
        for idx, sl in enumerate(merged_slices):
            stype, s, e, th = sl
            if stype == "write":
                # Check if there are any edits or runs in [s, e]
                has_activity = any(
                    s <= ev.get("t", 0) < e and ev.get("name") in ["typing_chunk", "edit", "run", "terminal_command"]
                    for ev in events
                )
                if not has_activity:
                    # Empty write segment
                    if final_slices:
                        # Merge into preceding
                        final_slices[-1][2] = e
                        continue
                    elif idx + 1 < len(merged_slices):
                        # Merge into following
                        merged_slices[idx + 1][1] = s
                        continue
            final_slices.append(sl)

        # Build Segment objects
        segments: List[Segment] = []
        for idx, (stype, s, e, th) in enumerate(final_slices, 1):
            seg_id = f"D{idx:02d}"
            seg = Segment(seg_id, stype, s, e, th)
            seg.minute_start = max(int(s / 60000), 0)
            seg.minute_end = max(int(e / 60000), seg.minute_start)
            segments.append(seg)

        # Generate Steps and assign to segments
        steps = self.generate_steps()
        for step in steps:
            for s in segments:
                if s.t_start <= step.t < s.t_end or (s == segments[-1] and step.t <= s.t_end):
                    s.step_ids.append(step.id)
                    break

        # Assign events to segments
        for ev in events:
            ev_t = ev.get("t", 0)
            ev_id = ev.get("id")
            for s in segments:
                if s.t_start <= ev_t < s.t_end or (s == segments[-1] and ev_t <= s.t_end):
                    s.events.append(ev)
                    if ev_id:
                        s.event_ids.append(ev_id)
                    break

        # Link fault threads M01, M02...
        # Spec 03 Section 3: Connects debug and AI segments in the thread span
        threads: List[Dict[str, Any]] = []
        for th in sig_threads:
            th_id = th.get("id", "M01")
            th_runs = th.get("runs", [])
            if len(th_runs) < 2:
                continue

            th_start = th_runs[0].get("t", 0)
            th_end = th.get("resolved_at") or th_runs[-1].get("t_end", th_runs[-1].get("t", 0) + 1000)

            th_segment_ids = []
            for s in segments:
                # Segment overlaps thread span
                if s.thread_id == th_id:
                    th_segment_ids.append(s.id)
                elif s.type == "ai" and th_start <= s.t_start < th_end:
                    s.thread_id = th_id
                    th_segment_ids.append(s.id)

            threads.append({
                "id": th_id,
                "signature": th.get("signature", ""),
                "location": th.get("location"),
                "segment_ids": th_segment_ids,
                "run_ids": [r.get("id", f"r{i}") for i, r in enumerate(th_runs, 1)],
                "resolved_at_t": th.get("resolved_at")
            })

        return segments, threads, steps
