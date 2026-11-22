# -*- coding: utf-8 -*-
"""
Pipeline module orchestrating the end-to-end execution of PhaseSUMMARY Engine
from zip archive to stage JSON files and markdown output files.
Implements Spec 00 Section 3 (Two-pass class execution for baseline.json)
and Section 8 (run_manifest.json & intermediate stage persistence).
"""

import os
import re
import json
import difflib
import html
import hashlib
from typing import Dict, List, Any, Optional, Tuple
from .ingestion import ZipSessionIngester, StudentSessionData, is_non_code_uri, normalize_rel_path, split_user_prompt
from .signals import SignalsAnalyzer
from .segmentation import SessionSegmenter
from .interpretation import InterpretationEngine
from .generator import SummaryGenerator
from .constants import DEFAULT_PARAMS, minute_label


def _json_default(value):
    """Tập được ghi theo thứ tự cố định để hai lần chạy cho cùng file."""
    return sorted(value, key=str) if isinstance(value, (set, frozenset)) else str(value)


class SummaryPipeline:
    def __init__(self, zip_path: str, output_dir: Optional[str] = None, params: Optional[Dict[str, Any]] = None):
        self.zip_path = zip_path
        default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "output_survey")
        base_dir = output_dir or default_out
        # If on macOS/Linux and base_dir is a Windows drive path like d:\..., use default_out
        if os.name != "nt" and len(base_dir) >= 2 and base_dir[1] == ":":
            base_dir = default_out

        zip_stem = os.path.splitext(os.path.basename(zip_path))[0]
        zip_folder_name = "".join(c for c in zip_stem if c not in '<>:"/\\|?*').strip() or "session_output"
        if os.path.basename(os.path.normpath(base_dir)) == zip_folder_name:
            self.output_dir = base_dir
        else:
            self.output_dir = os.path.join(base_dir, zip_folder_name)
        os.makedirs(self.output_dir, exist_ok=True)

        self.params = dict(DEFAULT_PARAMS)
        if params:
            self.params.update(params)

        self.ingester = ZipSessionIngester(zip_path, params=self.params)
        self.session_code = self.ingester.session_code
        self.processed_summaries: Dict[str, Dict[str, Any]] = {}
        self._pass1_cache: Dict[str, Tuple[StudentSessionData, Dict[str, Any]]] = {}
        self._replay_events_cache: Dict[str, Dict[str, Any]] = {}
        self._event_diff_cache: Dict[str, Dict[int, Dict[str, Any]]] = {}
        self.baseline: Optional[Dict[str, Any]] = None

    def get_students(self) -> List[str]:
        return self.ingester.get_students()

    def _run_pass1_student(self, student_id: str) -> Tuple[StudentSessionData, Dict[str, Any]]:
        if student_id not in self._pass1_cache:
            session_data = self.ingester.load_student(student_id)
            analyzer = SignalsAnalyzer(session_data, params=self.params)
            signals = analyzer.analyze()
            self._pass1_cache[student_id] = (session_data, signals)
        return self._pass1_cache[student_id]

    def _ensure_baseline(self) -> Dict[str, Any]:
        """
        Spec 00 Section 3 & Spec 04 Section 2:
        Pass 1 across all students in the class to compute baseline distributions
        for [n_runs_total, n_requests_total, T_task_min, n_pauses_ge_3min, n_threads_repeated].
        """
        if self.baseline is not None:
            return self.baseline

        metrics = {
            "n_runs_total": [],
            "n_requests_total": [],
            "T_task_min": [],
            "n_pauses_ge_3min": [],
            "n_threads_repeated": [],
        }
        min_pause_ms = self.params.get("pause.segment_ms", 180000)

        for s_id in self.get_students():
            try:
                s_data, sigs = self._run_pass1_student(s_id)
                dq = getattr(s_data, "dq_report", {})
                if not dq.get("DQ1", True):
                    continue
                t_task_min = max(int(round(sigs.get("T_task_ms", 0) / 60000.0)), 1)
                pauses_3m = [p for p in sigs.get("pauses", []) if p.get("length", 0) >= min_pause_ms]
                rep_threads = [th for th in sigs.get("threads", []) if th.get("repeated")]

                metrics["n_runs_total"].append(len(sigs.get("runs", [])))
                metrics["n_requests_total"].append(len(sigs.get("requests", [])))
                metrics["T_task_min"].append(t_task_min)
                metrics["n_pauses_ge_3min"].append(len(pauses_3m))
                metrics["n_threads_repeated"].append(len(rep_threads))
            except Exception:
                continue

        self.baseline = metrics
        try:
            baseline_path = os.path.join(self.output_dir, "baseline.json")
            with open(baseline_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "task_id": self.session_code,
                        "n_valid_sessions": len(metrics["n_runs_total"]),
                        "metrics": metrics,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except Exception:
            pass

        return self.baseline

    def run_m0(self, student_id: str, save: bool = True) -> StudentSessionData:
        """Runs M0 (Ingestion, Normalization, Code States, Provenance, DQ Report)."""
        session_data = self.ingester.load_student(student_id)
        if save:
            stage_dir = os.path.join(self.output_dir, "stages", student_id)
            os.makedirs(stage_dir, exist_ok=True)
            self._save_m0_files(stage_dir, session_data)
        return session_data

    def run_m1(self, student_id: str, save: bool = True) -> Tuple[StudentSessionData, Dict[str, Any]]:
        """Runs M0 + M1 (Signals TH1-TH11)."""
        session_data, signals = self._run_pass1_student(student_id)
        if save:
            stage_dir = os.path.join(self.output_dir, "stages", student_id)
            os.makedirs(stage_dir, exist_ok=True)
            self._save_m0_files(stage_dir, session_data)
            self._write_json_file(os.path.join(stage_dir, "signals.json"), signals)
        return session_data, signals

    def run_m2(self, student_id: str, save: bool = True) -> Tuple[StudentSessionData, Dict[str, Any], SessionSegmenter, List[Any]]:
        """Runs M0 + M1 + M2 (Steps, Segmentation D01..Dn, Threads M01..Mn)."""
        session_data, signals = self.run_m1(student_id, save=save)
        segmenter = SessionSegmenter(session_data, signals, params=self.params)
        segments = segmenter.segment()
        if save:
            stage_dir = os.path.join(self.output_dir, "stages", student_id)
            os.makedirs(stage_dir, exist_ok=True)
            self._write_json_file(
                os.path.join(stage_dir, "segments.json"),
                {
                    "steps": getattr(segmenter, "steps", []),
                    "segments": [s.to_dict() for s in segments],
                    "threads": getattr(segmenter, "m_threads", []),
                },
            )
        return session_data, signals, segmenter, segments

    def run_m3(self, student_id: str, save: bool = True) -> Tuple[StudentSessionData, Dict[str, Any], SessionSegmenter, List[Any], InterpretationEngine, Dict[str, Any], List[Any], List[Dict[str, Any]]]:
        """Runs M0 + M1 + M2 + M3 (Facts, Baseline Percentiles, Five Largest Events LN1-LN5)."""
        baseline = self._ensure_baseline()
        session_data, signals, segmenter, segments = self.run_m2(student_id, save=save)
        interpreter = InterpretationEngine(
            session_data,
            signals,
            segments,
            params=self.params,
            baseline=baseline,
        )
        facts, largest_events, not_chosen = interpreter.interpret()
        if save:
            stage_dir = os.path.join(self.output_dir, "stages", student_id)
            os.makedirs(stage_dir, exist_ok=True)
            self._write_json_file(
                os.path.join(stage_dir, "facts.json"),
                {
                    "session": {k: v for k, v in facts.items() if k not in ("retained_chunks", "no_trace_chunks", "discarded_chunks", "repeated_threads")},
                    "segments": {s.id: s.facts for s in segments},
                },
            )
            self._write_json_file(
                os.path.join(stage_dir, "largest.json"),
                {
                    "session_id": f"{session_data.session_code}_{student_id}",
                    "chosen": [ln.to_dict() for ln in largest_events],
                    "not_chosen": not_chosen,
                },
            )
        return session_data, signals, segmenter, segments, interpreter, facts, largest_events, not_chosen

    def run_student(self, student_id: str, stage: str = "all") -> Dict[str, Any]:
        """
        Runs pipeline up to specified stage:
        'm0', 'm1', 'm2', 'm3', 'm4', or 'all' (default).
        """
        stage_lower = (stage or "all").lower()
        if stage_lower == "m0":
            s_data = self.run_m0(student_id, save=True)
            return {
                "ok": True,
                "stage": "m0",
                "student_id": student_id,
                "session_code": s_data.session_code,
                "edits_count": len(s_data.edits),
                "snapshots_count": len(s_data.state_snapshots),
                "dq_report": getattr(s_data, "dq_report", {}),
                "final_files": list(s_data.final_files.keys()),
            }
        elif stage_lower == "m1":
            s_data, signals = self.run_m1(student_id, save=True)
            return {
                "ok": True,
                "stage": "m1",
                "student_id": student_id,
                "session_code": s_data.session_code,
                "runs_count": len(signals.get("runs", [])),
                "requests_count": len(signals.get("requests", [])),
                "pauses_count": len(signals.get("pauses", [])),
                "T_task_ms": signals.get("T_task_ms", 0),
                "retained_chunks": len(signals.get("ai_fate", {}).get("retained_chunks", [])),
            }
        elif stage_lower == "m2":
            s_data, signals, segmenter, segments = self.run_m2(student_id, save=True)
            return {
                "ok": True,
                "stage": "m2",
                "student_id": student_id,
                "session_code": s_data.session_code,
                "steps_count": len(getattr(segmenter, "steps", [])),
                "segments_count": len(segments),
                "segments": [s.to_dict() for s in segments],
                "threads": getattr(segmenter, "m_threads", []),
            }
        elif stage_lower == "m3":
            s_data, signals, segmenter, segments, interpreter, facts, largest_events, not_chosen = self.run_m3(student_id, save=True)
            return {
                "ok": True,
                "stage": "m3",
                "student_id": student_id,
                "session_code": s_data.session_code,
                "facts": facts,
                "largest": [ln.to_dict() for ln in largest_events],
                "not_chosen": not_chosen,
            }

        # Default: Full Pass 1 + Pass 2 (M2 - M6)
        baseline = self._ensure_baseline()
        session_data, signals = self._run_pass1_student(student_id)

        # M2: Segmentation
        segmenter = SessionSegmenter(session_data, signals, params=self.params)
        segments = segmenter.segment()

        # M3: Interpretation & Five Largest Events (LN1-LN5)
        interpreter = InterpretationEngine(
            session_data,
            signals,
            segments,
            params=self.params,
            baseline=baseline,
        )
        facts, largest_events, not_chosen = interpreter.interpret()

        # M4 - M6: Outline, Realization, K1-K6 Validation & Markdown Generation
        generator = SummaryGenerator(
            session_data,
            signals,
            segments,
            facts,
            largest_events,
            not_chosen=not_chosen,
            params=self.params,
        )
        markdown_text, check_report = generator.generate()

        # Save <student_id>_summary.md
        out_filename = f"{student_id}_summary.md"
        out_path = os.path.join(self.output_dir, out_filename)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(markdown_text)

        # Save stage JSON files (Spec 00 Sections 3 & 8)
        self._save_stage_files(student_id, session_data, signals, segmenter, segments, interpreter, facts, largest_events, not_chosen, generator, check_report)

        # Compute metrics accurately from signals, facts and generator
        runs_cnt = len(signals.get("runs", []))
        if not runs_cnt and isinstance(facts.get("runs_by_outcome"), dict):
            runs_cnt = sum(facts["runs_by_outcome"].values())
        if not runs_cnt:
            runs_cnt = facts.get("total_runs") or 0

        req_cnt = facts.get("n_requests")
        if req_cnt is None:
            req_cnt = len(signals.get("requests", [])) or facts.get("requests_count", 0)

        retained_chunks = facts.get("ai_chunks_retained", [])
        retained_cnt = len(retained_chunks) if isinstance(retained_chunks, list) else int(retained_chunks or 0)
        if not retained_cnt and isinstance(facts.get("ai_fates"), dict):
            retained_cnt = facts["ai_fates"].get("intact", 0) + facts["ai_fates"].get("partial", 0)

        traj = facts.get("trajectory") or signals.get("trajectory") or "none"

        top_ask = "DH0"
        asks_path = os.path.join(self.output_dir, "stages", student_id, "asks.json")
        if os.path.exists(asks_path):
            try:
                with open(asks_path, "r", encoding="utf-8") as af:
                    ask_data = json.load(af)
                    if isinstance(ask_data, list) and ask_data:
                        top_ask = ask_data[0].get("rule", "DH1")
                    elif isinstance(ask_data, dict) and "chosen" in ask_data and ask_data["chosen"]:
                        top_ask = ask_data["chosen"][0].get("rule", "DH1")
            except Exception:
                pass
        elif "DH" in markdown_text:
            m_dh = re.search(r'\b(DH[1-6])\b', markdown_text)
            if m_dh:
                top_ask = m_dh.group(1)
        elif "Điều đáng hỏi." in markdown_text:
            m_dh_title = re.search(r'\*\*Điều đáng hỏi\.\*\*\s*\n+(\d+)\.\s+\*\*([^\*]+)\.\*\*', markdown_text)
            if m_dh_title:
                t_str = m_dh_title.group(2)
                if "sửa lỗi" in t_str: top_ask = "DH3"
                elif "không chạy thử" in t_str: top_ask = "DH2"
                elif "phần lớn" in t_str: top_ask = "DH4"
                elif "không đổi" in t_str: top_ask = "DH5"
                else: top_ask = "DH1"

        result = {
            "ok": True,
            "stage": "all",
            "student_id": student_id,
            "session_code": session_data.session_code,
            "markdown": markdown_text,
            "out_path": out_path,
            "check_report": check_report,
            "metrics": {
                "duration_min": facts.get("duration_min", 0),
                "T_task_min": facts.get("T_task_min", 0),
                "runs_count": runs_cnt,
                "requests_count": req_cnt,
                "ai_chunks_retained": retained_cnt,
                "trajectory": traj,
                "top_ask": top_ask,
                "largest_events": [ln.id for ln in largest_events],
                "llm_used": check_report.get("llm_used", False),
                "llm_model": check_report.get("llm_model", "none"),
            },
        }
        self.processed_summaries[student_id] = result
        return result

    def get_latest_summary(self, student_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieves the latest generated summary from disk without re-running the pipeline.
        Returns None if <student_id>_summary.md does not exist.
        """
        out_filename = f"{student_id}_summary.md"
        out_path = os.path.join(self.output_dir, out_filename)
        if not os.path.exists(out_path):
            return None

        try:
            with open(out_path, "r", encoding="utf-8") as f:
                markdown_text = f.read()
        except Exception:
            return None

        stage_dir = os.path.join(self.output_dir, "stages", student_id)
        facts_path = os.path.join(stage_dir, "facts.json")
        check_path = os.path.join(stage_dir, "check_report.json")
        largest_path = os.path.join(stage_dir, "largest.json")
        signals_path = os.path.join(stage_dir, "signals.json")

        facts_data = {}
        if os.path.exists(facts_path):
            try:
                with open(facts_path, "r", encoding="utf-8") as f:
                    facts_data = json.load(f)
            except Exception:
                pass

        check_data = {}
        if os.path.exists(check_path):
            try:
                with open(check_path, "r", encoding="utf-8") as f:
                    check_data = json.load(f)
            except Exception:
                pass

        largest_data = {}
        if os.path.exists(largest_path):
            try:
                with open(largest_path, "r", encoding="utf-8") as f:
                    largest_data = json.load(f)
            except Exception:
                pass

        signals_data = {}
        if os.path.exists(signals_path):
            try:
                with open(signals_path, "r", encoding="utf-8") as f:
                    signals_data = json.load(f)
            except Exception:
                pass

        facts_session = facts_data.get("session", {}) if isinstance(facts_data, dict) else {}
        retained = facts_session.get("ai_chunks_retained", [])
        retained_count = len(retained) if isinstance(retained, list) else int(retained or 0)
        if not retained_count and isinstance(facts_session.get("ai_fates"), dict):
            retained_count = facts_session["ai_fates"].get("intact", 0) + facts_session["ai_fates"].get("partial", 0)

        runs_cnt = facts_session.get("total_runs")
        if runs_cnt is None:
            runs_by_outcome = facts_session.get("runs_by_outcome", {})
            runs_cnt = sum(runs_by_outcome.values()) if isinstance(runs_by_outcome, dict) else len(signals_data.get("runs", []))

        req_cnt = facts_session.get("n_requests")
        if req_cnt is None:
            req_cnt = facts_session.get("requests_count", 0) or len(signals_data.get("requests", []))

        dur_min = facts_session.get("duration_min", 0) or int(round(signals_data.get("T_task_ms", 0) / 60000.0))
        t_task_min = facts_session.get("T_task_min", 0) or dur_min

        # Fallback to extracting from markdown text if facts were missing or 0
        if not runs_cnt:
            m_r = re.search(r'\|\s*Lần chạy(?:\s+terminal)?\s*\|\s*(\d+)', markdown_text)
            if m_r:
                runs_cnt = int(m_r.group(1))
        if not req_cnt:
            m_q = re.search(r'\|\s*(?:Số\s+)?yêu cầu AI(?:\s+theo nhóm)?\s*\|\s*(\d+)', markdown_text)
            if m_q:
                req_cnt = int(m_q.group(1))
        if not retained_count:
            m_a = re.search(r'\|\s*(?:Số phận code AI|Đoạn code AI trong bản cuối)\s*\|\s*(\d+)', markdown_text)
            if m_a:
                retained_count = int(m_a.group(1))
        if not dur_min:
            m_d = re.search(r'\|\s*(?:Thời lượng|Thời lượng toàn bộ buổi)\s*\|\s*(?:Buổi dài\s+)?(\d+)', markdown_text)
            if m_d:
                dur_min = int(m_d.group(1))
        if not t_task_min:
            m_t = re.search(r'\|\s*(?:Thời gian làm bài ước lượng \(T_task\)|Thời lượng)\s*\|\s*.*?(\d+)\s*phút', markdown_text)
            if m_t:
                t_task_min = int(m_t.group(1))

        traj = facts_session.get("trajectory")
        if not traj or traj == "none":
            m_tr = re.search(r'\|\s*Kiểu hỏi AI \(trajectory\)\s*\|\s*([^|\n]+)', markdown_text)
            if m_tr:
                traj = m_tr.group(1).strip()
            else:
                traj = "none"

        top_ask = "DH0"
        asks_path = os.path.join(stage_dir, "asks.json")
        if os.path.exists(asks_path):
            try:
                with open(asks_path, "r", encoding="utf-8") as af:
                    ask_data = json.load(af)
                    if isinstance(ask_data, list) and ask_data:
                        top_ask = ask_data[0].get("rule", "DH1")
                    elif isinstance(ask_data, dict) and "chosen" in ask_data and ask_data["chosen"]:
                        top_ask = ask_data["chosen"][0].get("rule", "DH1")
            except Exception:
                pass
        elif "DH" in markdown_text:
            m_dh = re.search(r'\b(DH[1-6])\b', markdown_text)
            if m_dh:
                top_ask = m_dh.group(1)
        elif "Điều đáng hỏi." in markdown_text:
            m_dh_title = re.search(r'\*\*Điều đáng hỏi\.\*\*\s*\n+(\d+)\.\s+\*\*([^\*]+)\.\*\*', markdown_text)
            if m_dh_title:
                t_str = m_dh_title.group(2)
                if "sửa lỗi" in t_str:
                    top_ask = "DH3"
                elif "không chạy thử" in t_str:
                    top_ask = "DH2"
                elif "phần lớn" in t_str:
                    top_ask = "DH4"
                elif "không đổi" in t_str:
                    top_ask = "DH5"
                else:
                    top_ask = "DH1"

        chosen_largest = []
        if isinstance(largest_data, dict) and "chosen" in largest_data:
            chosen_largest = [c.get("id") for c in largest_data["chosen"] if isinstance(c, dict) and "id" in c]

        metrics = {
            "duration_min": dur_min,
            "T_task_min": t_task_min,
            "runs_count": runs_cnt,
            "requests_count": req_cnt,
            "ai_chunks_retained": retained_count,
            "trajectory": traj,
            "top_ask": top_ask,
            "largest_events": chosen_largest,
            "llm_used": check_data.get("llm_used", False),
            "llm_model": check_data.get("llm_model", "none"),
        }

        result = {
            "ok": True,
            "stage": "all",
            "student_id": student_id,
            "session_code": self.session_code,
            "markdown": markdown_text,
            "out_path": out_path,
            "check_report": check_data,
            "metrics": metrics,
            "from_disk": True
        }
        self.processed_summaries[student_id] = result
        return result

    def get_assignment(self, student_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Retrieves assignment documents for the student or current session.
        """
        docs = self.ingester.get_assignment_docs(student_id)
        if not docs:
            return {
                "ok": False,
                "error": "Không tìm thấy tài liệu đề bài (README.md / ASSIGNMENT.md) trong gói dữ liệu.",
                "student_id": student_id or "",
                "session_code": self.session_code,
                "docs": {},
                "default_doc": "",
                "markdown": ""
            }

        # Choose default doc: README.md preferred if available, else ASSIGNMENT.md, else first
        default_name = ""
        for preferred in ("README.md", "readme.md", "ASSIGNMENT.md", "assignment.md", "de_bai.md"):
            for k in docs:
                if k.lower() == preferred.lower():
                    default_name = k
                    break
            if default_name:
                break
        if not default_name:
            default_name = next(iter(docs.keys()))

        return {
            "ok": True,
            "student_id": student_id or "",
            "session_code": self.session_code,
            "docs": docs,
            "default_doc": default_name,
            "markdown": docs.get(default_name, "")
        }

    def export_assignment(
        self,
        student_id: Optional[str] = None,
        doc_name: Optional[str] = None,
        out_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Exports the assignment document to a markdown (.md) file.
        """
        info = self.get_assignment(student_id)
        if not info.get("ok"):
            return info

        docs = info.get("docs", {})
        chosen_doc = doc_name or info.get("default_doc")
        if chosen_doc not in docs:
            # Fallback case-insensitive match
            found = False
            for k in docs:
                if k.lower() == str(chosen_doc).lower():
                    chosen_doc = k
                    found = True
                    break
            if not found:
                chosen_doc = info.get("default_doc")

        markdown_content = docs.get(chosen_doc, "")
        if not markdown_content:
            return {
                "ok": False,
                "error": f"Nội dung của tài liệu '{chosen_doc}' trống hoặc không tồn tại.",
                "session_code": self.session_code,
                "docs": list(docs.keys())
            }

        if not out_path:
            clean_name = os.path.splitext(os.path.basename(chosen_doc))[0]
            prefix = f"{self.session_code}_" if self.session_code else ""
            out_filename = f"{prefix}{clean_name}.md"
            out_path = os.path.join(self.output_dir, out_filename)

        out_dir = os.path.dirname(os.path.abspath(out_path))
        os.makedirs(out_dir, exist_ok=True)

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(markdown_content)

        return {
            "ok": True,
            "session_code": self.session_code,
            "student_id": student_id or "",
            "doc_name": chosen_doc,
            "out_path": os.path.abspath(out_path),
            "file_size": len(markdown_content.encode("utf-8")),
            "available_docs": list(docs.keys())
        }

    @staticmethod
    def _line_col_to_offset(content: str, sl: int, sc: int) -> int:
        if not content or (sl <= 1 and sc <= 1):
            return 0
        lines = content.splitlines(keepends=True)
        if not lines:
            return 0
        if sl > len(lines):
            return len(content)
        line_idx = max(sl - 1, 0)
        offset = sum(len(lines[i]) for i in range(line_idx))
        col_offset = min(max(sc - 1, 0), len(lines[line_idx]))
        return min(offset + col_offset, len(content))

    @staticmethod
    def _build_line_diff(file_before: str, file_after: str) -> List[Dict[str, Any]]:
        """Diff theo dòng cho thay đổi cả file (dòng ảo đồng bộ code theo ảnh chụp máy chủ)."""
        lines_b = file_before.splitlines() if file_before else []
        lines_a = file_after.splitlines() if file_after else []
        out: List[Dict[str, Any]] = []
        sm = difflib.SequenceMatcher(None, lines_b, lines_a, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1):
                    out.append({"type": "ctx", "old_num": i1 + k + 1, "new_num": j1 + k + 1, "sign": " ",
                                "html": html.escape(lines_b[i1 + k]), "is_changed": False})
                continue
            for k in range(i1, i2):
                out.append({"type": "del", "old_num": k + 1, "new_num": None, "sign": "-",
                            "html": f'<del class="diff-del-text">{html.escape(lines_b[k])}</del>', "is_changed": True})
            for k in range(j1, j2):
                out.append({"type": "add", "old_num": None, "new_num": k + 1, "sign": "+",
                            "html": f'<ins class="diff-ins-text">{html.escape(lines_a[k])}</ins>', "is_changed": True})
        return out

    @staticmethod
    def _build_diff_lines(file_before: str, file_after: str, sl: int, sc: int, el: int, ec: int, del_text: str, ins_text: str, action: str) -> List[Dict[str, Any]]:
        lines_b = file_before.splitlines() if file_before else []
        lines_a = file_after.splitlines() if file_after else []

        full_lines = []
        if not lines_b and not lines_a:
            return []

        # 1. Unchanged lines before change
        for i in range(1, sl):
            txt = lines_b[i - 1] if i - 1 < len(lines_b) else ""
            full_lines.append({
                "type": "ctx",
                "old_num": i,
                "new_num": i,
                "sign": " ",
                "html": html.escape(txt),
                "is_changed": False
            })

        # 2. Changed lines
        if action == "del":
            for i in range(sl, el + 1):
                raw = lines_b[i - 1] if i - 1 < len(lines_b) else ""
                s_c = sc - 1 if i == sl else 0
                e_c = ec - 1 if i == el else len(raw)
                prefix = html.escape(raw[:s_c])
                del_chunk = html.escape(raw[s_c:e_c])
                suffix = html.escape(raw[e_c:])
                line_html = f'{prefix}<del class="diff-del-text">{del_chunk}</del>{suffix}'
                full_lines.append({
                    "type": "del",
                    "old_num": i,
                    "new_num": None,
                    "sign": "-",
                    "html": line_html,
                    "is_changed": True,
                })
            # Inline deletion where rest of line is kept
            if sl == el and sl - 1 < len(lines_b) and (sc > 1 or ec < len(lines_b[sl - 1])) and sl - 1 < len(lines_a):
                full_lines.append({
                    "type": "add",
                    "old_num": None,
                    "new_num": sl,
                    "sign": "+",
                    "html": html.escape(lines_a[sl - 1]),
                    "is_changed": True,
                })
                start_a_idx = sl
            else:
                start_a_idx = sl - 1

            for idx_a in range(start_a_idx, len(lines_a)):
                old_idx = (el + 1) + (idx_a - start_a_idx)
                full_lines.append({
                    "type": "ctx",
                    "old_num": old_idx if old_idx <= len(lines_b) else None,
                    "new_num": idx_a + 1,
                    "sign": " ",
                    "html": html.escape(lines_a[idx_a]),
                    "is_changed": False
                })

        elif action in ("add", "paste"):
            ins_lines = ins_text.splitlines() or [""]
            for offset, ins_l in enumerate(ins_lines):
                line_idx = sl + offset
                raw = lines_a[line_idx - 1] if line_idx - 1 < len(lines_a) else ""
                if len(ins_lines) == 1:
                    s_c = sc - 1
                    e_c = s_c + len(ins_text)
                    prefix = html.escape(raw[:s_c])
                    ins_chunk = html.escape(raw[s_c:e_c])
                    suffix = html.escape(raw[e_c:])
                    line_html = f'{prefix}<ins class="diff-ins-text">{ins_chunk}</ins>{suffix}'
                else:
                    line_html = f'<ins class="diff-ins-text">{html.escape(raw)}</ins>'
                full_lines.append({
                    "type": "add",
                    "old_num": None,
                    "new_num": line_idx,
                    "sign": "+",
                    "html": line_html,
                    "is_changed": True,
                })
            for idx_a in range(sl + len(ins_lines) - 1, len(lines_a)):
                old_idx = sl + (idx_a - (sl + len(ins_lines) - 1))
                full_lines.append({
                    "type": "ctx",
                    "old_num": old_idx if old_idx <= len(lines_b) else None,
                    "new_num": idx_a + 1,
                    "sign": " ",
                    "html": html.escape(lines_a[idx_a]),
                    "is_changed": False
                })

        elif action == "rep":
            for i in range(sl, el + 1):
                raw = lines_b[i - 1] if i - 1 < len(lines_b) else ""
                s_c = sc - 1 if i == sl else 0
                e_c = ec - 1 if i == el else len(raw)
                prefix = html.escape(raw[:s_c])
                del_chunk = html.escape(raw[s_c:e_c])
                suffix = html.escape(raw[e_c:])
                full_lines.append({
                    "type": "del",
                    "old_num": i,
                    "new_num": None,
                    "sign": "-",
                    "html": f'{prefix}<del class="diff-del-text">{del_chunk}</del>{suffix}',
                    "is_changed": True,
                })
            ins_lines = ins_text.splitlines() or [""]
            for offset, ins_l in enumerate(ins_lines):
                line_idx = sl + offset
                raw = lines_a[line_idx - 1] if line_idx - 1 < len(lines_a) else ""
                full_lines.append({
                    "type": "add",
                    "old_num": None,
                    "new_num": line_idx,
                    "sign": "+",
                    "html": f'<ins class="diff-ins-text">{html.escape(raw)}</ins>',
                    "is_changed": True,
                })
            for idx_a in range(sl + len(ins_lines) - 1, len(lines_a)):
                old_idx = (el + 1) + (idx_a - (sl + len(ins_lines) - 1))
                full_lines.append({
                    "type": "ctx",
                    "old_num": old_idx if old_idx <= len(lines_b) else None,
                    "new_num": idx_a + 1,
                    "sign": " ",
                    "html": html.escape(lines_a[idx_a]),
                    "is_changed": False
                })
        else:
            for i in range(1, len(lines_a) + 1):
                txt = lines_a[i - 1] if i - 1 < len(lines_a) else ""
                full_lines.append({
                    "type": "ctx",
                    "old_num": i,
                    "new_num": i,
                    "sign": " ",
                    "html": html.escape(txt),
                    "is_changed": False
                })

        return full_lines

    def get_event_diff(self, student_id: str, event_idx: int) -> Dict[str, Any]:
        """
        Retrieves reconstructed code file state and git-commit-style diff
        for the given event index.
        """
        if not hasattr(self, "_event_diff_cache"):
            self._event_diff_cache = {}

        if student_id not in self._event_diff_cache:
            self.get_replay_events(student_id)

        student_diffs = self._event_diff_cache.get(student_id, {})
        entry = student_diffs.get(event_idx)
        if not entry and isinstance(event_idx, (int, str)):
            entry = student_diffs.get(str(event_idx))
        if not entry:
            return {
                "ok": False,
                "error": f"Không tìm thấy sự kiện #{event_idx} cho sinh viên {student_id}",
                "student_id": student_id,
                "index": event_idx
            }

        file_before = entry.get("file_before", "")
        file_after = entry.get("file_after", "")
        sl = entry.get("sl", 1)
        sc = entry.get("sc", 1)
        el = entry.get("el", 1)
        ec = entry.get("ec", 1)
        action = entry.get("action", "none")
        del_text = entry.get("deleted_text", "")
        ins_text = entry.get("inserted_text", "")

        if entry.get("diff_mode") == "lines":
            full_lines = self._build_line_diff(file_before, file_after)
        else:
            full_lines = self._build_diff_lines(file_before, file_after, sl, sc, el, ec, del_text, ins_text, action)

        ch_indices = [i for i, l in enumerate(full_lines) if l.get("is_changed")]
        if ch_indices:
            h_start = max(0, min(ch_indices) - 5)
            h_end = min(len(full_lines), max(ch_indices) + 6)
            hunk_lines = full_lines[h_start:h_end]
        else:
            hunk_lines = full_lines[:60]

        return {
            "ok": True,
            "student_id": student_id,
            "index": event_idx,
            "id": entry.get("id", f"#{event_idx}"),
            "file": entry.get("file", ""),
            "action": action,
            "deleted_text": del_text,
            "inserted_text": ins_text,
            "chars_deleted": len(del_text),
            "chars_added": len(ins_text),
            "range": entry.get("range", {}),
            "sl": sl,
            "sc": sc,
            "el": el,
            "ec": ec,
            "file_before_lines": len(file_before.splitlines()) if file_before else 0,
            "file_after_lines": len(file_after.splitlines()) if file_after else 0,
            "lines_added": entry.get("lines_added", max(0, len(file_after.splitlines()) - len(file_before.splitlines())) if action != "none" else 0),
            "lines_deleted": entry.get("lines_deleted", max(0, len(file_before.splitlines()) - len(file_after.splitlines())) if action != "none" else 0),
            "hunk_lines": hunk_lines,
            "full_file_lines": full_lines,
            "changed_line": sl,
            "t": entry.get("t", 0),
            "time_str": entry.get("time_str", "0:00"),
            "minute": entry.get("minute", "00"),
        }

    def get_replay_events(self, student_id: str) -> Dict[str, Any]:
        """
        Retrieves the complete, numbered replay event sequence for a student.
        Each event retains its true raw index #1..#N from the raw log stream,
        and accurately reconstructs file states and code diffs (added & deleted).
        """
        if not hasattr(self, "_replay_events_cache"):
            self._replay_events_cache = {}
        if not hasattr(self, "_event_diff_cache"):
            self._event_diff_cache = {}

        if student_id in self._replay_events_cache:
            return self._replay_events_cache[student_id]

        import zipfile

        data = self.ingester.load_student(student_id)
        start_ts = data.start_ts
        files = self.ingester._student_file_map.get(student_id, {"events": [], "ai": []})

        # Load segments if available; if not yet computed, run lightweight M2 (no LLM, <1s)
        stage_dir = os.path.join(self.output_dir, "stages", student_id)
        seg_path = os.path.join(stage_dir, "segments.json")
        segments = []
        if not os.path.exists(seg_path):
            try:
                self.run_m2(student_id, save=True)
            except Exception:
                pass

        if os.path.exists(seg_path):
            try:
                with open(seg_path, "r", encoding="utf-8") as f:
                    seg_data = json.load(f)
                    segments = seg_data.get("segments", [])
            except Exception:
                pass

        # Collect raw items with exact ordering
        raw_items = []
        with zipfile.ZipFile(self.zip_path, "r") as z:
            for src, key in (("IDE", "events"), ("AI", "ai")):
                for path in files.get(key, []):
                    try:
                        raw_lines = z.read(path).decode("utf-8", errors="ignore").splitlines()
                    except Exception:
                        continue
                    for idx, line in enumerate(raw_lines):
                        if not line.strip():
                            continue
                        try:
                            ev = json.loads(line)
                        except Exception:
                            continue
                        if src == "IDE" and ev.get("type") == "chat":
                            continue
                        raw_items.append((ev.get("timestamp", 0) or 0, 0 if src == "IDE" else 1, idx, src, ev))

        raw_items.sort(key=lambda x: (x[0], x[1], x[2]))

        from .ingestion import parse_iso_ms

        EVENT_TYPE_LABELS = {
            "typing_chunk": "Gõ code",
            "paste": "Dán code",
            "edit_detected": "Bộ ghi xác nhận đoạn vừa dán trùng code AI",
            "terminal_command": "Lệnh terminal",
            "terminal_run": "Chạy mã nguồn (phát hiện từ terminal chụp)",
            "terminal_capture": "Terminal chụp ở máy chủ lúc gửi yêu cầu AI",
            "chat": "Bộ ghi IDE ghi lượt chat (nội dung thường là prompt trước)",
            "chat_send": "Gửi yêu cầu AI",
            "chat_request": "Yêu cầu AI",
            "chat_response_complete": "Câu trả lời AI",
            "undo": "Hoàn tác (Undo)",
            "redo": "Làm lại (Redo)",
            "file_switch": "Chuyển file",
            "copy": "Copy",
            "ui_click": "Click chuột",
            "text_selection": "Bôi chọn text",
            "unfocus": "Rời tiêu điểm",
            "panel_resize": "Đổi cỡ panel",
            "window_metrics": "Kích thước cửa sổ",
            "snapshot": "Chụp IDE",
        }

        EVENT_CATEGORIES = {
            "typing_chunk": "edit",
            "undo": "edit",
            "redo": "edit",
            "paste": "paste",
            "edit_detected": "paste",
            "terminal_command": "terminal",
            "terminal_run": "terminal",
            "terminal_capture": "terminal",
            "chat": "ai",
            "chat_send": "ai",
            "chat_request": "ai",
            "chat_response_complete": "ai",
            "file_switch": "file",
            "copy": "file",
            "ui_click": "ui",
            "text_selection": "ui",
            "unfocus": "ui",
            "panel_resize": "ui",
            "window_metrics": "ui",
            "snapshot": "ui",
        }

        def _clean_file(uri: str) -> str:
            if not uri:
                return ""
            if "vscode-chat-code-block" in uri:
                m = re.search(r'/(\d+)#(?:%7B|\{)?', uri)
                block_num = int(m.group(1)) + 1 if m else 1
                return f"Khối code phản hồi AI (#{block_num})"
            # File của bài dùng đúng khoá file của M0 (giữ thư mục Q1/Q2, B3), để sự kiện replay ghép được với edit M0
            if not is_non_code_uri(uri):
                return normalize_rel_path(uri)
            parts = uri.replace("\\", "/").split("/")
            for i, p_part in enumerate(parts):
                if p_part in ("app.py", "templates", "static", "views", "models", "main.py", "data"):
                    return "/".join(parts[i:])
            return parts[-1] or uri

        def _format_mmss(ms: int) -> str:
            s = int(round(ms / 1000.0))
            return f"{s // 60}:{s % 60:02d}"

        # 0. Pre-index all AI conversation turns by requestId
        ai_turns: Dict[str, Dict[str, Any]] = {}
        for ts_item, _, _, src_item, ev_item in raw_items:
            etype_item = ev_item.get("type")
            p_item = ev_item.get("payload", {}) or {}
            req_id_item = p_item.get("requestId")
            if not req_id_item:
                continue
            if req_id_item not in ai_turns:
                m_send = re.search(r'chat-(\d+)-', req_id_item)
                send_ms_val = int(m_send.group(1)) if m_send else 0
                send_t_rel = max(send_ms_val - start_ts, 0) if (send_ms_val and start_ts) else 0

                ai_turns[req_id_item] = {
                    "requestId": req_id_item,
                    "model": p_item.get("model", ""),
                    "prompt": "",
                    "user_query": "",
                    "response": "",
                    "tokenUsage": {},
                    "request_t": 0,
                    "response_t": 0,
                    "request_time": "--",
                    "response_time": "--",
                    "send_ms": send_ms_val,
                    "send_t": send_t_rel,
                    "send_time": _format_mmss(send_t_rel) if send_t_rel else "--:--",
                    "activeDocument": "",
                }
            t_rel_item = max(ts_item - start_ts, 0) if start_ts else 0
            turn_obj = ai_turns[req_id_item]

            if etype_item == "chat_request":
                msgs = p_item.get("messages", []) or []
                user_msgs = [m.get("content", "") for m in msgs if m.get("role") == "user"]
                full_p = user_msgs[-1] if user_msgs else str(p_item.get("prompt", ""))
                core_p = split_user_prompt(full_p)[0]
                turn_obj["prompt"] = full_p
                turn_obj["user_query"] = core_p or full_p
                turn_obj["model"] = p_item.get("model") or turn_obj.get("model", "")
                turn_obj["activeDocument"] = _clean_file(p_item.get("activeDocumentUri", ""))
                turn_obj["request_t"] = t_rel_item
                turn_obj["request_time"] = _format_mmss(t_rel_item)

            elif etype_item == "chat_response_complete":
                turn_obj["response"] = str(p_item.get("text", ""))
                turn_obj["tokenUsage"] = p_item.get("tokenUsage", {})
                turn_obj["response_t"] = t_rel_item
                turn_obj["response_time"] = _format_mmss(t_rel_item)

        ai_turns_sorted = sorted(ai_turns.values(), key=lambda x: x.get("request_t", 0))

        def _find_nearest_turn(t_val: int) -> Optional[Dict[str, Any]]:
            if not ai_turns_sorted:
                return None
            return min(ai_turns_sorted, key=lambda turn: abs(turn.get("request_t", 0) - t_val))

        # Pre-scan raw_items to pair edit_detected with paste events (Rule C)
        paired_pastes_n = set()
        ed_companion_of_paste = {}
        insert_into_file_n = set()

        for idx_ed, (ts_ed, _, _, _, ev_ed) in enumerate(raw_items, start=1):
            if ev_ed.get("type") != "edit_detected":
                continue
            p_ed = ev_ed.get("payload", {}) or {}
            kind_ed = p_ed.get("editKind", "")
            if kind_ed == "ai-chat":
                txt_ed = str(p_ed.get("text", "")).strip()
                uri_ed = p_ed.get("documentUri", "")
                f_ed = _clean_file(uri_ed)
                found_paste = None
                for idx_p, (ts_p, _, _, _, ev_p) in enumerate(raw_items, start=1):
                    if ev_p.get("type") != "paste":
                        continue
                    p_p = ev_p.get("payload", {}) or {}
                    if abs(ts_p - ts_ed) <= 3000 and _clean_file(p_p.get("targetFile", "")) == f_ed:
                        txt_p = str(p_p.get("pastedText", "")).strip()
                        if txt_p == txt_ed or txt_ed in txt_p or txt_p in txt_ed or (len(txt_ed) > 10 and txt_ed[:20] in txt_p) or (len(txt_p) > 10 and txt_p[:20] in txt_ed):
                            found_paste = idx_p
                            break
                if found_paste is not None:
                    paired_pastes_n.add(found_paste)
                    ed_companion_of_paste[idx_ed] = found_paste
                else:
                    insert_into_file_n.add(idx_ed)

        paste_companion_tc = {}
        tc_companion_of_paste = {}

        for idx_p, (ts_p, _, _, _, ev_p) in enumerate(raw_items, start=1):
            if ev_p.get("type") != "paste":
                continue
            p_p = ev_p.get("payload", {}) or {}
            f_p = _clean_file(p_p.get("targetFile", ""))
            raw_uri_p = p_p.get("targetFile", "")
            if not f_p or f_p.startswith("chatSessionInput") or f_p.startswith("Khối") or is_non_code_uri(raw_uri_p):
                continue
            txt_p = str(p_p.get("pastedText", "")).replace("\r\n", "\n")
            best_tc = None
            for idx_tc in range(idx_p - 1, max(0, idx_p - 7), -1):
                ts_tc, _, _, _, ev_tc = raw_items[idx_tc - 1]
                if ev_tc.get("type") != "typing_chunk":
                    continue
                p_tc = ev_tc.get("payload", {}) or {}
                f_tc = _clean_file(p_tc.get("fileUri", ""))
                if f_tc != f_p:
                    continue
                if abs(ts_p - ts_tc) > 3000:
                    continue
                txt_tc = str(p_tc.get("text", "")).replace("\r\n", "\n")
                if (txt_p.strip() == txt_tc.strip() or txt_p in txt_tc or txt_tc in txt_p
                        or (len(txt_p) > 10 and txt_p[:20] in txt_tc)
                        or (len(txt_tc) > 10 and txt_tc[:20] in txt_p)):
                    best_tc = idx_tc
                    break
            if best_tc:
                paste_companion_tc[idx_p] = best_tc
                tc_companion_of_paste[best_tc] = idx_p

        insert_companion_tc = {}
        tc_companion_of_insert = {}

        for idx_ins in sorted(insert_into_file_n):
            ts_ins, _, _, _, ev_ins = raw_items[idx_ins - 1]
            p_ins = ev_ins.get("payload", {}) or {}
            f_ins = _clean_file(p_ins.get("documentUri", ""))
            txt_ins = str(p_ins.get("text", "")).replace("\r\n", "\n")
            candidates = []
            for idx_tc in range(max(1, idx_ins - 5), min(len(raw_items) + 1, idx_ins + 6)):
                if idx_tc == idx_ins:
                    continue
                if idx_tc in tc_companion_of_paste:
                    continue
                ts_tc, _, _, _, ev_tc = raw_items[idx_tc - 1]
                if ev_tc.get("type") != "typing_chunk":
                    continue
                p_tc = ev_tc.get("payload", {}) or {}
                f_tc = _clean_file(p_tc.get("fileUri", ""))
                if f_tc != f_ins:
                    continue
                if abs(ts_ins - ts_tc) > 3000:
                    continue
                txt_tc = str(p_tc.get("text", "")).replace("\r\n", "\n")
                if (txt_ins.strip() == txt_tc.strip() or txt_ins in txt_tc or txt_tc in txt_ins
                        or (len(txt_ins) > 10 and txt_ins[:20] in txt_tc)
                        or (len(txt_tc) > 10 and txt_tc[:20] in txt_ins)):
                    candidates.append((abs(ts_ins - ts_tc), abs(idx_ins - idx_tc), idx_tc))
            if candidates:
                candidates.sort()
                chosen_tc = candidates[0][2]
                insert_companion_tc[idx_ins] = chosen_tc
                tc_companion_of_insert[chosen_tc] = idx_ins

        # Task 4: Map M0 edits (data.edits) to real replay events so replay file states strictly match M0 reconstruction
        m0_edits = getattr(data, "edits", []) or []
        m0_snapshots = getattr(data, "state_snapshots", []) or []

        event_m0_edits: Dict[int, List[int]] = {}
        event_candidates = []
        for n_cand, (ts_c, _, _, _, ev_c) in enumerate(raw_items, start=1):
            etype_c = ev_c.get("type", "unknown")
            p_c = ev_c.get("payload", {}) or {}
            raw_uri_c = ""
            if etype_c == "typing_chunk":
                raw_uri_c = p_c.get("fileUri", "")
            elif etype_c == "paste":
                raw_uri_c = p_c.get("targetFile", "")
            elif etype_c in ("undo", "redo"):
                raw_uri_c = p_c.get("fileUri", "")
            elif etype_c == "edit_detected":
                raw_uri_c = p_c.get("documentUri", "")

            tf_c = _clean_file(raw_uri_c)
            is_ai_c = "vscode-chat-code-block" in raw_uri_c
            is_chat_c = "chatSessionInput" in raw_uri_c
            is_comp = (
                n_cand in tc_companion_of_paste
                or n_cand in ed_companion_of_paste
                or n_cand in tc_companion_of_insert
            )

            if (not is_chat_c and not is_ai_c and not is_non_code_uri(raw_uri_c)
                    and not is_comp and tf_c):
                if etype_c in ("typing_chunk", "paste", "undo", "redo") or n_cand in insert_into_file_n:
                    chunk_txt = str(p_c.get("text", "") if etype_c == "typing_chunk" else "").replace("\r\n", "\n")
                    event_candidates.append((n_cand, ts_c, tf_c, etype_c, chunk_txt))

        for ed_idx, ed in enumerate(m0_edits):
            ed_ts = ed.get("ts_abs", 0)
            ed_file = ed.get("file", "")
            ed_kind = ed.get("kind", "")
            ed_txt = ed.get("inserted") or ""

            best_n = None
            best_score = 999999999
            for n_cand, ev_ts, ev_file, ev_type, ev_txt in event_candidates:
                if ev_file != ed_file:
                    continue
                dt = abs(ev_ts - ed_ts)
                if dt <= 3000:
                    type_bonus = 0
                    if ed_kind == "paste" and ev_type == "paste":
                        type_bonus = -50
                    elif ed_kind in ("undo", "redo") and ev_type in ("undo", "redo"):
                        type_bonus = -50
                    # Đợt nhiều chunk cùng mili giây: chỉ phá hoà, ưu tiên sự kiện cùng chữ rồi sự kiện chưa ghép,
                    # để mỗi chunk về đúng sự kiện của nó thay vì dồn cả đợt vào sự kiện đầu
                    tie = (0 if ev_type != "typing_chunk" or ev_txt == ed_txt else 0.5) + (0.25 if n_cand in event_m0_edits else 0)
                    score = dt + type_bonus + tie
                    if score < best_score:
                        best_score = score
                        best_n = n_cand

            if best_n is not None:
                event_m0_edits.setdefault(best_n, []).append(ed_idx)

        # Initialize file contents from task config starter files
        file_states: Dict[str, str] = {}
        for k, v in data.task_config.get("starter_files", {}).items():
            file_states[k] = v.replace("\r\n", "\n")

        event_diff_map: Dict[Any, Dict[str, Any]] = {}
        parsed_real_events = []
        last_ai_turn: Optional[Dict[str, Any]] = None
        last_active_code_file: str = "app.py"

        for n, (ts, _, idx, src, ev) in enumerate(raw_items, start=1):
            etype = ev.get("type", "unknown")
            p_ev = ev.get("payload", {}) or {}
            t_rel = max(ts - start_ts, 0) if start_ts else 0
            category = EVENT_CATEGORIES.get(etype, "ui")

            # Match segment
            seg_id = ""
            for s in segments:
                if s.get("t_start", 0) <= t_rel <= s.get("t_end", 0):
                    seg_id = s.get("id", "")
                    break

            lines_str = ""
            content_str = ""
            info_str = ""
            type_label = EVENT_TYPE_LABELS.get(etype, etype)

            rng = p_ev.get("range") or {}
            sl_val = 1
            sc_val = 1
            el_val = 1
            ec_val = 1
            if rng and rng.get("sl") is not None:
                sl_val = int(rng.get("sl", 1) or 1)
                sc_val = int(rng.get("sc", 1) or 1)
                el_val = int(rng.get("el", sl_val) or sl_val)
                ec_val = int(rng.get("ec", sc_val) or sc_val)
                lines_str = f"L{sl_val}–L{el_val}" if sl_val != el_val else f"L{sl_val}"

            # Extract target file URI
            raw_uri = ""
            if etype == "typing_chunk":
                raw_uri = p_ev.get("fileUri", "")
            elif etype == "paste":
                raw_uri = p_ev.get("targetFile", "")
            elif etype in ("undo", "redo"):
                raw_uri = p_ev.get("fileUri", "")
            elif etype == "edit_detected":
                raw_uri = p_ev.get("documentUri", "")
            elif etype == "chat_request":
                raw_uri = p_ev.get("activeDocumentUri", "")
            elif etype == "file_switch":
                raw_uri = p_ev.get("toFile", "")
            elif etype == "copy":
                raw_uri = p_ev.get("sourceFile", "")

            target_file = _clean_file(raw_uri)
            is_ai_code_block = "vscode-chat-code-block" in raw_uri
            is_chat_input = "chatSessionInput" in raw_uri

            # Rule A & C: Relabel vscode-chat-code-block streaming rows
            if is_ai_code_block:
                m_blk = re.search(r'/(\d+)#(?:%7B|\{)?', raw_uri)
                blk_k = int(m_blk.group(1)) + 1 if m_blk else 1
                category = "ai"
                type_label = f"Câu trả lời AI đang hiện trong khung chat (khối code {blk_k})"
                info_str = "VS Code Chat render khối mã từ câu trả lời AI trong khung chat (không phải sinh viên thao tác và không phải thay đổi trong tệp mã nguồn)"

            chat_input_text = ""
            # Rule C: Chat input special labels
            if is_chat_input:
                category = "ai"
                kind_in = p_ev.get("kind", "add")
                txt_in = str(p_ev.get("text", "")).replace("\r\n", "\n")
                if etype == "paste":
                    chat_input_text = str(p_ev.get("pastedText", "")).replace("\r\n", "\n")
                    type_label = "Dán vào ô chat AI"
                    content_str = chat_input_text[:300]
                    info_str = f"Dán vào ô nhập chat AI ({len(chat_input_text)} ký tự)"
                elif etype == "typing_chunk":
                    chat_input_text = txt_in
                    if kind_in == "del" and sl_val == 1 and sc_val == 1 and not txt_in:
                        type_label = "Ô chat được xoá khi gửi"
                        content_str = "Ô nhập chat AI được xoá để chuẩn bị gửi"
                        info_str = f"Ô chat xoá L{sl_val}:C{sc_val}–L{el_val}:C{ec_val} ngay trước mốc gửi yêu cầu AI"
                    else:
                        type_label = "Gõ vào ô chat AI"
                        content_str = f"+ {txt_in}" if kind_in == "add" else "- xoá"
                        info_str = f"Thao tác trong ô nhập chat AI ({kind_in})"

            # Tab nháp chưa lưu (untitled:) không phải file của bài: hiện nhưng không áp vào code
            if raw_uri.lower().startswith("untitled:") and etype in ("typing_chunk", "paste", "undo", "redo"):
                category = "file"
                tab_name = raw_uri.split(":", 1)[1] or "Untitled"
                if etype == "paste":
                    type_label = "Dán vào tab nháp chưa lưu"
                else:
                    type_label = "Gõ vào tab nháp chưa lưu"
                info_str = f"{tab_name} là tab chưa lưu, không phải file của bài; không tính vào code và số liệu"

            diff_action = "none"
            del_chunk = ""
            ins_chunk = ""
            file_before = ""
            file_after = ""

            is_chat_or_noncode = (
                not target_file
                or is_chat_input
                or is_ai_code_block
                or target_file.startswith("Khối code phản hồi AI")
                or is_non_code_uri(raw_uri)
            )

            if n in event_m0_edits:
                ed_indices = event_m0_edits[n]
                first_i = ed_indices[0]
                last_i = ed_indices[-1]
                ed_first = m0_edits[first_i]
                ed_last = m0_edits[last_i]

                target_file = ed_first.get("file") or target_file
                last_active_code_file = target_file

                if m0_snapshots and first_i < len(m0_snapshots) and last_i + 1 < len(m0_snapshots):
                    file_before = m0_snapshots[first_i][1].get(target_file, "")
                    file_after = m0_snapshots[last_i + 1][1].get(target_file, "")
                else:
                    file_before = file_states.get(target_file, "")
                    file_after = file_before

                file_states[target_file] = file_after

                # Range coordinates
                rng_first = ed_first.get("range", {}) or rng
                sl_val = int(rng_first.get("sl", 1) or ed_first.get("start_line_1based", 1) or sl_val)
                sc_val = int(rng_first.get("sc", 1) or sc_val)
                rng_last = ed_last.get("range", {}) or rng
                el_val = int(rng_last.get("el", sl_val) or el_val)
                ec_val = int(rng_last.get("ec", sc_val) or ec_val)
                lines_str = f"L{sl_val}–L{el_val}" if sl_val != el_val else f"L{sl_val}"

                # Text changes
                ins_chunk = "".join(m0_edits[k].get("inserted", "") for k in ed_indices)
                del_len = sum(m0_edits[k].get("deleted_len", 0) for k in ed_indices)
                if del_len > 0 and file_before:
                    pos = ed_first.get("offset", 0)
                    del_chunk = file_before[pos:pos + del_len]
                else:
                    del_chunk = ""

                if etype == "paste":
                    diff_action = "paste"
                    p_txt = str(p_ev.get("pastedText", "")).replace("\r\n", "\n")
                    if p_txt:
                        ins_chunk = p_txt
                    content_str = f"+ {ins_chunk[:300]}"
                    if n in paired_pastes_n:
                        type_label = "Dán code từ khung chat AI"
                        info_str = f"Dán code từ khung chat AI ({len(ins_chunk)} ký tự)"
                    else:
                        is_internal = bool((p_ev.get("source") or {}).get("isInternal", False))
                        type_label = "Dán code"
                        info_str = f"Dán {'nội bộ' if is_internal else 'từ ngoài'} ({len(ins_chunk)} ký tự)"

                elif n in insert_into_file_n:
                    diff_action = "paste"
                    content_str = f"+ {ins_chunk[:300]}" if ins_chunk else "Chèn mã từ câu trả lời AI"
                    type_label = "Dán code từ khung chat AI (nút Insert into File)"
                    info_str = "Chèn mã từ câu trả lời AI vào tệp qua nút Insert into File (tương đương thao tác dán code AI)"
                    category = "paste"

                elif etype in ("undo", "redo"):
                    diff_action = "undo"
                    content_str = f"{etype.capitalize()}"
                    type_label = "Hoàn tác (Undo)" if etype == "undo" else "Làm lại (Redo)"
                    info_str = f"{etype.capitalize()} tại {lines_str}"

                else:
                    # typing_chunk
                    kind_ed = ed_first.get("kind") or p_ev.get("kind", "add")
                    if kind_ed == "del" or (del_chunk and not ins_chunk):
                        diff_action = "del"
                        type_label = "Xoá code"
                        content_str = f"- {del_chunk}" if del_chunk else "Xoá code"
                        info_str = f"Xoá {len(del_chunk)} ký tự tại {lines_str}"
                    elif del_chunk and ins_chunk:
                        diff_action = "rep"
                        type_label = "Thay thế code"
                        content_str = f"- {del_chunk} → + {ins_chunk}"
                        info_str = f"Thay thế {len(del_chunk)} ký tự bằng {len(ins_chunk)} ký tự"
                    else:
                        diff_action = "add"
                        type_label = "Gõ thêm"
                        content_str = f"+ {ins_chunk}"
                        info_str = f"Gõ thêm {len(ins_chunk)} ký tự tại {lines_str}"

            elif not is_chat_or_noncode:
                cur_text = file_states.get(target_file, "")
                file_before = cur_text
                file_after = cur_text
                diff_action = "none"
                del_chunk = ""
                ins_chunk = ""
                last_active_code_file = target_file

                if n in tc_companion_of_paste:
                    p_idx = tc_companion_of_paste[n]
                    is_ai = p_idx in paired_pastes_n
                    type_label = "Thao tác gõ kèm lệnh dán (dán code AI)" if is_ai else "Thao tác gõ kèm lệnh dán"
                    info_str = f"Sự kiện gõ kỹ thuật đi kèm với lệnh dán #{p_idx}"
                    content_str = f"Đi kèm với lệnh dán #{p_idx}"

                elif n in tc_companion_of_insert:
                    ins_idx = tc_companion_of_insert[n]
                    type_label = "Thao tác gõ kèm nút chèn code AI"
                    info_str = f"Sự kiện gõ kỹ thuật đi kèm với thao tác chèn code AI vào tệp (#{ins_idx})"
                    content_str = f"Đi kèm với thao tác chèn code AI vào tệp #{ins_idx}"

                elif etype == "edit_detected":
                    if n in ed_companion_of_paste:
                        p_idx = ed_companion_of_paste[n]
                        type_label = "Bộ ghi xác nhận đoạn vừa dán trùng code AI"
                        match_t = p_ev.get("meta", {}).get("matchType", "match")
                        info_str = f"Bộ ghi đối chiếu khớp nội dung với lệnh dán #{p_idx} ({match_t})"
                        content_str = f"Khớp code với lệnh dán #{p_idx}"
                    else:
                        kind_ed = p_ev.get("editKind", "")
                        if kind_ed == "ai-mcp":
                            type_label = "Bộ ghi đánh dấu thay đổi lúc AI đang trả lời (không phải AI sửa)"
                            category = "edit"
                            info_str = "Bộ ghi F-VSCode đánh dấu thay đổi trong lúc AI đang trả lời (sinh viên tự gõ/autocomplete, không phải AI sửa)"
                        else:
                            type_label = "Bộ ghi xác nhận đoạn vừa dán trùng code AI"
                            info_str = f"Bộ ghi đối chiếu khớp nội dung vừa dán với code AI ({p_ev.get('meta', {}).get('matchType', 'match')})"

                elif etype == "paste":
                    txt = str(p_ev.get("pastedText", "")).replace("\r\n", "\n")
                    ins_chunk = txt
                    content_str = f"+ {ins_chunk[:300]}"
                    if n in paired_pastes_n:
                        type_label = "Dán code từ khung chat AI"
                        info_str = f"Dán code từ khung chat AI ({len(ins_chunk)} ký tự)"
                    else:
                        is_internal = bool((p_ev.get("source") or {}).get("isInternal", False))
                        type_label = "Dán code"
                        info_str = f"Dán {'nội bộ' if is_internal else 'từ ngoài'} ({len(ins_chunk)} ký tự)"

                elif etype == "typing_chunk":
                    kind = p_ev.get("kind", "add")
                    txt = str(p_ev.get("text", "")).replace("\r\n", "\n")
                    ins_chunk = txt
                    content_str = f"+ {ins_chunk[:300]}" if kind == "add" else "- xoá code"
                    type_label = "Gõ thêm" if kind == "add" else "Xoá code"
                    info_str = f"Thao tác gõ tại {lines_str}"

                elif etype in ("undo", "redo"):
                    diff_action = "undo"
                    content_str = f"{etype.capitalize()}"
                    type_label = "Hoàn tác (Undo)" if etype == "undo" else "Làm lại (Redo)"
                    info_str = f"{etype.capitalize()} tại {lines_str}"

            else:
                fallback_file = last_active_code_file or "app.py"
                fallback_code = file_states.get(fallback_file, "")
                file_before = fallback_code
                file_after = fallback_code
                diff_action = "snapshot"

            # Fallbacks for non-file events or specific handlers
            req_id = p_ev.get("requestId")
            if etype == "terminal_command":
                content_str = str(p_ev.get("command", ""))
                exit_c = p_ev.get("exitCode")
                info_str = f"exitCode={exit_c}, duration={p_ev.get('durationMs', 0)}ms"
            elif etype == "chat_request":
                msgs = p_ev.get("messages", []) or []
                user_msgs = [m.get("content", "") for m in msgs if m.get("role") == "user"]
                full_p = user_msgs[-1] if user_msgs else str(p_ev.get("prompt", ""))
                core_p = split_user_prompt(full_p)[0]
                content_str = core_p or full_p
                # Rule A: label chat_request with real send time
                turn_matching = ai_turns.get(req_id)
                send_time_display = turn_matching.get("send_time", "--:--") if turn_matching else "--:--"
                type_label = f"Yêu cầu AI (bộ ghi ghi lúc câu trả lời xong, gửi lúc {send_time_display})"
                info_str = f"Lượt AI {req_id}: Ghi nhận hoàn tất lúc {type_label}, thời điểm bấm gửi là {send_time_display}"
                if req_id and req_id in ai_turns:
                    last_ai_turn = ai_turns[req_id]
            elif etype == "chat_response_complete":
                content_str = str(p_ev.get("text", ""))
                info_str = f"requestId={req_id}"
                if req_id and req_id in ai_turns:
                    last_ai_turn = ai_turns[req_id]
            elif etype == "file_switch":
                from_f = _clean_file(p_ev.get("fromFile", ""))
                to_f = _clean_file(p_ev.get("toFile", ""))
                content_str = f"{from_f or '(khởi đầu)'} → {to_f}"
            elif etype == "copy":
                content_str = str(p_ev.get("copiedText", ""))
            elif etype == "ui_click":
                content_str = f"target={p_ev.get('target', '')}"
            elif etype == "text_selection":
                content_str = str(p_ev.get("text", ""))
            elif not content_str:
                content_str = json.dumps(p_ev, ensure_ascii=False)[:300]

            active_turn = ai_turns.get(req_id) if (req_id and req_id in ai_turns) else last_ai_turn
            if not active_turn and (is_ai_code_block or category == "ai"):
                active_turn = _find_nearest_turn(t_rel)

            lines_add_val = max(len(file_after.splitlines()) - len(file_before.splitlines()), len(ins_chunk.splitlines()) if ins_chunk else 0) if diff_action != "none" else 0
            lines_del_val = max(0, len(file_before.splitlines()) - len(file_after.splitlines())) if diff_action != "none" else 0

            event_diff_map[n] = {
                "idx": n,
                "file": target_file if not is_chat_or_noncode else (last_active_code_file or "app.py"),
                "display_file": target_file,
                "is_code_file": not is_chat_or_noncode,
                "action": diff_action,
                "deleted_text": del_chunk,
                "inserted_text": ins_chunk,
                "range": rng,
                "sl": sl_val,
                "sc": sc_val,
                "el": el_val,
                "ec": ec_val,
                "file_before": file_before,
                "file_after": file_after,
                "lines_added": lines_add_val,
                "lines_deleted": lines_del_val,
                "t": t_rel,
                "time_str": _format_mmss(t_rel),
                "minute": minute_label(t_rel),
            }

            parsed_real_events.append({
                "id": f"#{n}",
                "index": n,
                "raw_order": n,
                "virtual": False,
                "timestamp": ts,
                "t": t_rel,
                "minute": minute_label(t_rel),
                "time_str": _format_mmss(t_rel),
                "src": src,
                "type": etype,
                "type_label": type_label,
                "category": category,
                "file": target_file,
                "raw_file_uri": raw_uri,
                "lines": lines_str,
                "content": content_str,
                "full_content": content_str,
                "info": info_str,
                "segment_id": seg_id,
                "is_ai_code_block": is_ai_code_block,
                "ai_turn": active_turn,
                "is_active_ai": etype in ("chat_request", "chat_response_complete"),
                "chat_input_text": chat_input_text,
                "diff": {
                    "action": diff_action,
                    "file": target_file,
                    "deleted_text": del_chunk[:100],
                    "inserted_text": ins_chunk[:100],
                    "chars_deleted": len(del_chunk),
                    "chars_added": len(ins_chunk),
                    "range": rng,
                }
            })

        # Rule A: Virtual rows "Gửi yêu cầu AI"
        virtual_send_rows = []
        for req_id, turn_obj in ai_turns.items():
            send_ms = turn_obj.get("send_ms", 0)
            send_t = turn_obj.get("send_t", 0)
            p_lines = (turn_obj.get("user_query") or turn_obj.get("prompt") or "").strip().splitlines()
            first_line = p_lines[0].strip() if p_lines else "Gửi yêu cầu AI"

            seg_id_send = ""
            for s in segments:
                if s.get("t_start", 0) <= send_t <= s.get("t_end", 0):
                    seg_id_send = s.get("id", "")
                    break

            v_idx = f"v_send_{req_id}"
            virtual_send_rows.append({
                "id": "–",
                "index": v_idx,
                "raw_order": 999999,
                "virtual": True,
                "timestamp": send_ms or (start_ts + turn_obj.get("request_t", 0)),
                "t": send_t,
                "minute": minute_label(send_t),
                "time_str": turn_obj.get("send_time", _format_mmss(send_t)),
                "src": "AI",
                "type": "chat_send",
                "type_label": "Gửi yêu cầu AI",
                "category": "ai",
                "file": turn_obj.get("activeDocument", "") or "",
                "raw_file_uri": "",
                "lines": "",
                "content": first_line,
                "full_content": turn_obj.get("user_query") or turn_obj.get("prompt") or "",
                "info": f"Mốc gửi thực tế trích xuất từ requestId: {req_id}",
                "segment_id": seg_id_send,
                "is_ai_code_block": False,
                "ai_turn": turn_obj,
                "is_active_ai": True,
                "diff": {"action": "none"}
            })

            cur_code_fallback = file_states.get(last_active_code_file or "app.py", "")
            event_diff_map[v_idx] = {
                "idx": v_idx,
                "file": turn_obj.get("activeDocument", "") or "app.py",
                "display_file": turn_obj.get("activeDocument", "") or "app.py",
                "is_code_file": False,
                "action": "snapshot",
                "deleted_text": "",
                "inserted_text": "",
                "range": {},
                "sl": 1,
                "sc": 1,
                "el": 1,
                "ec": 1,
                "file_before": cur_code_fallback,
                "file_after": cur_code_fallback,
                "t": send_t,
                "time_str": turn_obj.get("send_time", _format_mmss(send_t)),
                "minute": minute_label(send_t),
            }

        # Rule B: Virtual rows "Terminal chụp ở máy chủ lúc gửi yêu cầu AI"
        virtual_cap_rows = []
        offset_cap = self.ingester._capture_offset_ms(data, data.proxy_by_request)
        seen_runs_all = []
        seen_accesses_all = set()
        prev_cap_out = ""

        def _get_new_offset(prev_txt: str, cur_txt: str) -> int:
            if not prev_txt:
                return 0
            if cur_txt == prev_txt:
                return len(cur_txt)
            if cur_txt.startswith(prev_txt):
                return len(prev_txt)
            import difflib
            s = difflib.SequenceMatcher(None, prev_txt, cur_txt)
            match = s.find_longest_match(0, len(prev_txt), 0, len(cur_txt))
            if match.size >= 50:
                return match.b + match.size
            return 0

        for c_idx, entry in enumerate(data.prompts):
            if entry.get("_misattached"):
                continue
            raw_out = entry.get("terminalOutput")
            if not raw_out or not str(raw_out).strip():
                continue
            out = str(raw_out).replace("\r\n", "\n").replace("\r", "\n")
            t_cap = self.ingester._prompt_capture_ts(entry, offset_cap)
            if not t_cap:
                t_cap = (start_ts + entry.get("t", 0))
            t_rel = max(t_cap - start_ts, 0) if (t_cap and start_ts) else 0

            hits = list(self.ingester.RUN_CMD_RE.finditer(out))
            cur_runs = []
            for i, m in enumerate(hits):
                end = hits[i + 1].start() if i + 1 < len(hits) else len(out)
                body = out[m.end():end]
                nxt_prompt = self.ingester.PS_PROMPT_RE.search(body)
                if nxt_prompt:
                    body = body[:nxt_prompt.start()]
                nxt_script = self.ingester._match_script(hits[i + 1]) if i + 1 < len(hits) else ""
                cur_script = self.ingester._match_script(m)
                if not body.strip() and i + 1 < len(hits) and nxt_script and cur_script and nxt_script == cur_script:
                    continue
                script = cur_script
                if "activate" in script:
                    continue
                script_base = os.path.basename(script.replace("\\", "/")) or "script"
                errs = list(self.ingester.ERR_LINE_RE.finditer(body))
                err = errs[-1] if errs else None
                loc = re.findall(r'File "([^"]+)", line (\d+)', body)
                accesses = [(self.ingester._access_ms(a), int(a.group(9))) for a in self.ingester.ACCESS_RE.finditer(body)]
                pages = self.ingester._page_loads(body)
                server = "running on http" in body.lower() or bool(accesses)

                run_sig = (script_base, server, err.group(0).split(":")[0].strip() if err else None, loc[-1][1] if loc else None)

                desc = ""
                if server:
                    if pages:
                        first_ms, code, path = pages[0]
                        t_acc = max(first_ms - start_ts, 0) if (first_ms and start_ts) else t_rel
                        t_acc_str = _format_mmss(t_acc)
                        desc = f"server lên, trang {path} trả {code} lúc {t_acc_str}"
                    else:
                        desc = "server lên thành công"
                elif err:
                    err_type = err.group(0).split(":")[0].strip()
                    line_num = loc[-1][1] if loc else ""
                    if line_num:
                        desc = f"chạy {script_base} → {err_type} dòng {line_num}"
                    else:
                        desc = f"chạy {script_base} → {err_type}"
                else:
                    desc = f"chạy {script_base}"
                cur_runs.append((run_sig, desc))

            noise = self.ingester.params.get("fvscode.term.page_noise", ["/favicon.ico", "/.well-known/", "__debugger__="])
            cur_accesses = [a.group(0).strip() for a in self.ingester.ACCESS_RE.finditer(out)
                            if not any(n in a.group(8) for n in noise)]

            # Check what is new since previous capture
            new_runs = [desc for sig, desc in cur_runs if sig not in seen_runs_all]
            for sig, _ in cur_runs:
                if sig not in seen_runs_all:
                    seen_runs_all.append(sig)

            new_accesses = [a for a in cur_accesses if a not in seen_accesses_all]
            for a in new_accesses:
                seen_accesses_all.add(a)

            parts = []
            if new_runs:
                parts.extend(new_runs)
            if new_accesses and not (new_runs and any("server lên" in r for r in new_runs) and len(new_accesses) <= 2):
                if len(new_accesses) == 1:
                    parts.append("ghi nhận thêm 1 lượt tải trang")
                else:
                    parts.append(f"ghi nhận thêm {len(new_accesses)} lượt tải trang")

            if parts:
                outcome_summary = "; ".join(parts)
                is_repeat = False
            else:
                outcome_summary = "không có gì mới so với lần chụp trước"
                is_repeat = True

            new_offset = _get_new_offset(prev_cap_out, out)
            if is_repeat:
                new_offset = len(out)
            prev_cap_out = out

            seg_id_cap = ""
            for s in segments:
                if s.get("t_start", 0) <= t_rel <= s.get("t_end", 0):
                    seg_id_cap = s.get("id", "")
                    break

            v_idx = f"v_cap_{c_idx}"
            virtual_cap_rows.append({
                "id": "–",
                "index": v_idx,
                "raw_order": 999999,
                "virtual": True,
                "timestamp": t_cap,
                "t": t_rel,
                "minute": minute_label(t_rel),
                "time_str": _format_mmss(t_rel),
                "src": "SERVER",
                "type": "terminal_capture",
                "type_label": "Terminal chụp ở máy chủ lúc gửi yêu cầu AI",
                "category": "terminal",
                "file": "Terminal",
                "raw_file_uri": "",
                "lines": "",
                "content": outcome_summary,
                "full_content": out,
                "terminal_output": out,
                "info": out,
                "runs": [d for _, d in cur_runs],
                "new_runs": new_runs,
                "is_repeat": is_repeat,
                "new_offset": new_offset,
                "segment_id": seg_id_cap,
                "is_ai_code_block": False,
                "ai_turn": None,
                "is_active_ai": False,
                "diff": {"action": "none"}
            })

            cur_code_fallback = file_states.get(last_active_code_file or "app.py", "")
            event_diff_map[v_idx] = {
                "idx": v_idx,
                "file": "Terminal",
                "display_file": "Terminal",
                "is_code_file": False,
                "action": "snapshot",
                "deleted_text": "",
                "inserted_text": "",
                "range": {},
                "sl": 1,
                "sc": 1,
                "el": 1,
                "ec": 1,
                "file_before": cur_code_fallback,
                "file_after": cur_code_fallback,
                "t": t_rel,
                "time_str": _format_mmss(t_rel),
                "minute": minute_label(t_rel),
            }

        # Rule A17: Virtual rows per capture-derived run
        virtual_run_rows = []
        capture_runs = [
            e for e in data.events
            if e.get("_synthetic") or (e.get("payload") or {}).get("t_source") == "capture"
        ]
        for r_idx, syn_ev in enumerate(capture_runs):
            pld = syn_ev.get("payload", {}) or {}
            ts_syn = syn_ev.get("timestamp", 0)
            t_syn = max(ts_syn - start_ts, 0) if start_ts else 0
            t_lo_syn = pld.get("t_lo_ts", 0)
            t_lo_rel = max(t_lo_syn - start_ts, 0) if (t_lo_syn and start_ts) else 0

            upper_str = _format_mmss(t_syn)
            lo_str = _format_mmss(t_lo_rel) if (t_lo_syn and t_lo_rel > 0) else "không rõ giờ sớm nhất"

            script = pld.get("script") or "app.py"
            body = pld.get("stdout_tail", "") or pld.get("stderr_tail", "")

            errs = list(self.ingester.ERR_LINE_RE.finditer(body))
            err = errs[-1] if errs else None
            loc = re.findall(r'File "([^"]+)", line (\d+)', body)
            accesses = [(self.ingester._access_ms(a), int(a.group(9))) for a in self.ingester.ACCESS_RE.finditer(body)]
            pages = self.ingester._page_loads(body)
            server = pld.get("long_lived") or "running on http" in body.lower() or bool(accesses)

            if server:
                if pages:
                    first_ms, code, path = pages[0]
                    t_acc = max(first_ms - start_ts, 0) if (first_ms and start_ts) else t_syn
                    acc_str = _format_mmss(t_acc)
                    run_label = f"Chạy {script} → server lên; trang {path} trả {code} lúc {acc_str}"
                else:
                    run_label = f"Chạy {script} → server lên"
            elif err:
                err_type = err.group(0).split(":")[0].strip()
                line_str = f" dòng {loc[-1][1]}" if loc else ""
                run_label = f"Chạy {script} → {err_type}{line_str} (log IDE không ghi lệnh; giờ chạy chậm nhất {upper_str}, sớm nhất {lo_str})"
            else:
                run_label = f"Chạy {script} (log IDE không ghi lệnh; giờ chạy chậm nhất {upper_str}, sớm nhất {lo_str})"

            seg_id_run = ""
            for s in segments:
                if s.get("t_start", 0) <= t_syn <= s.get("t_end", 0):
                    seg_id_run = s.get("id", "")
                    break

            v_run_idx = f"v_run_{r_idx}"
            virtual_run_rows.append({
                "id": "–",
                "index": v_run_idx,
                "raw_order": 999999,
                "virtual": True,
                "timestamp": ts_syn,
                "t": t_syn,
                "minute": minute_label(t_syn),
                "time_str": upper_str,
                "src": "IDE*",
                "type": "terminal_run",
                "type_label": "Chạy (từ terminal chụp)",
                "category": "terminal",
                "file": script,
                "raw_file_uri": "",
                "lines": "",
                "content": run_label,
                "full_content": body or run_label,
                "terminal_output": body,
                "info": run_label,
                "segment_id": seg_id_run,
                "is_ai_code_block": False,
                "ai_turn": None,
                "is_active_ai": False,
                "diff": {"action": "none"}
            })

            cur_code_fallback = file_states.get(script, file_states.get(last_active_code_file or "app.py", ""))
            event_diff_map[v_run_idx] = {
                "idx": v_run_idx,
                "file": script,
                "display_file": script,
                "is_code_file": True,
                "action": "snapshot",
                "deleted_text": "",
                "inserted_text": "",
                "range": {},
                "sl": 1,
                "sc": 1,
                "el": 1,
                "ec": 1,
                "file_before": cur_code_fallback,
                "file_after": cur_code_fallback,
                "t": t_syn,
                "time_str": upper_str,
                "minute": minute_label(t_syn),
            }

        # Dòng ảo cho các lần engine đồng bộ code theo ảnh chụp ở log máy chủ (A5, origin resync)
        virtual_resync_rows = []
        for ed_idx, ed in enumerate(m0_edits):
            if ed.get("origin") != "resync":
                continue
            f_rs = ed.get("file", "")
            if not (m0_snapshots and ed_idx + 1 < len(m0_snapshots)):
                continue
            before_rs = m0_snapshots[ed_idx][1].get(f_rs, "")
            after_rs = m0_snapshots[ed_idx + 1][1].get(f_rs, "")
            t_rs = ed.get("t", 0)
            ts_rs = ed.get("ts_abs") or (start_ts + t_rs)
            sm_rs = difflib.SequenceMatcher(None, before_rs.splitlines(), after_rs.splitlines(), autojunk=False)
            l_add = sum(j2 - j1 for tag, i1, i2, j1, j2 in sm_rs.get_opcodes() if tag in ("insert", "replace"))
            l_del = sum(i2 - i1 for tag, i1, i2, j1, j2 in sm_rs.get_opcodes() if tag in ("delete", "replace"))
            label_rs = (f"Code {f_rs} đồng bộ theo ảnh chụp ở máy chủ lúc gửi yêu cầu AI: "
                        f"+{l_add} / −{l_del} dòng mà log IDE không ghi")
            seg_id_rs = ""
            for s in segments:
                if s.get("t_start", 0) <= t_rs <= s.get("t_end", 0):
                    seg_id_rs = s.get("id", "")
                    break
            v_rs_idx = f"v_resync_{ed_idx}"
            virtual_resync_rows.append({
                "id": "–",
                "index": v_rs_idx,
                "raw_order": 999999,
                "virtual": True,
                "timestamp": ts_rs,
                "t": t_rs,
                "minute": minute_label(t_rs),
                "time_str": _format_mmss(t_rs),
                "src": "Máy chủ",
                "type": "code_resync",
                "type_label": "Đồng bộ code (log IDE thiếu)",
                "category": "file",
                "file": f_rs,
                "raw_file_uri": "",
                "lines": "",
                "content": label_rs,
                "full_content": label_rs,
                "info": "Engine so code dựng lại với ảnh chụp code ở log máy chủ (codeSnapshot) và kéo về theo ảnh chụp (quy tắc A5). Phần này không tính là tự gõ, dán hay AI.",
                "segment_id": seg_id_rs,
                "is_ai_code_block": False,
                "ai_turn": None,
                "is_active_ai": False,
                "diff": {"action": "rep"},
            })
            event_diff_map[v_rs_idx] = {
                "idx": v_rs_idx,
                "id": "–",
                "file": f_rs,
                "display_file": f_rs,
                "is_code_file": True,
                "action": "rep",
                "diff_mode": "lines",
                "deleted_text": "",
                "inserted_text": "",
                "range": {},
                "sl": 1, "sc": 1, "el": 1, "ec": 1,
                "file_before": before_rs,
                "file_after": after_rs,
                "lines_added": l_add,
                "lines_deleted": l_del,
                "t": t_rs,
                "time_str": _format_mmss(t_rs),
                "minute": minute_label(t_rs),
            }

        # Merge all events and sort by timestamp
        # Real events retain their relative order among themselves via raw_order
        all_events = parsed_real_events + virtual_send_rows + virtual_cap_rows + virtual_run_rows + virtual_resync_rows
        all_events.sort(key=lambda x: (
            x.get("timestamp", 0),
            0 if x.get("type") == "chat_send" else (1 if not x.get("virtual") else (2 if x.get("type") == "terminal_run" else 3)),
            x.get("raw_order", 999999)
        ))

        # Rule D: Chat-input reconstruction (data for task 2)
        current_chat_draft = ""
        last_paste_txt = None
        last_paste_ts = 0
        chat_draft_history = []

        for ev in all_events:
            etype = ev.get("type")
            raw_uri = ev.get("raw_file_uri", "") or ""
            ts = ev.get("timestamp", 0)

            if "chatSessionInput" in raw_uri:
                diff_obj = ev.get("diff", {})
                rng = diff_obj.get("range") or {}
                sl_c = int(rng.get("sl", 1) or 1)
                sc_c = int(rng.get("sc", 1) or 1)
                el_c = int(rng.get("el", sl_c) or sl_c)
                ec_c = int(rng.get("ec", sc_c) or sc_c)

                if ev.get("type_label") == "Ô chat được xoá khi gửi":
                    current_chat_draft = ""
                elif etype == "typing_chunk":
                    txt = ev.get("chat_input_text") or diff_obj.get("inserted_text", "")
                    kind = "del" if (diff_obj.get("action") == "del") else ("rep" if diff_obj.get("action") == "rep" else "add")
                    pos = self._line_col_to_offset(current_chat_draft, sl_c, sc_c)
                    if (el_c > sl_c or ec_c > sc_c) and kind in ("del", "rep"):
                        end_off = self._line_col_to_offset(current_chat_draft, el_c, ec_c)
                        d = max(end_off - pos, 0)
                    elif kind == "del":
                        d = min(1, len(current_chat_draft) - pos)
                    else:
                        d = 0
                    current_chat_draft = current_chat_draft[:pos] + txt + current_chat_draft[pos + d:]
                    last_paste_txt = txt
                    last_paste_ts = ts
                elif etype == "paste":
                    txt = ev.get("chat_input_text") or diff_obj.get("inserted_text", "")
                    if not (last_paste_txt == txt and abs(ts - last_paste_ts) <= 1500):
                        pos = self._line_col_to_offset(current_chat_draft, sl_c, sc_c)
                        d = max(self._line_col_to_offset(current_chat_draft, el_c, ec_c) - pos, 0) if (el_c > sl_c or ec_c > sc_c) else 0
                        current_chat_draft = current_chat_draft[:pos] + txt + current_chat_draft[pos + d:]
                        last_paste_txt = txt
                        last_paste_ts = ts

                chat_draft_history.append({
                    "id": ev["id"],
                    "index": ev["index"],
                    "t": ev["t"],
                    "time_str": ev["time_str"],
                    "text": current_chat_draft
                })
            elif etype == "chat_send":
                chat_draft_history.append({
                    "id": ev["id"],
                    "index": ev["index"],
                    "t": ev["t"],
                    "time_str": ev["time_str"],
                    "text": current_chat_draft
                })
                current_chat_draft = ""

            ev["chat_draft"] = current_chat_draft

        # Compute category and type counts
        category_counts = {"edit": 0, "paste": 0, "ai": 0, "terminal": 0, "file": 0, "ui": 0}
        type_counts = {}
        for ev in all_events:
            cat = ev.get("category", "ui")
            category_counts[cat] = category_counts.get(cat, 0) + 1
            t_label = ev.get("type_label", ev.get("type", "unknown"))
            type_counts[t_label] = type_counts.get(t_label, 0) + 1

        seg_summary = []
        for s in segments:
            seg_summary.append({
                "id": s.get("id"),
                "type": s.get("type"),
                "minute_start": s.get("minute_start"),
                "minute_end": s.get("minute_end"),
                "label": f"[{s.get('id')}] Phút {s.get('minute_start')}–{s.get('minute_end')} ({s.get('type')})",
            })

        self._event_diff_cache[student_id] = event_diff_map

        result = {
            "ok": True,
            "student_id": student_id,
            "session_code": self.session_code,
            "total_events": len(all_events),
            "total_real_events": len(parsed_real_events),
            "events": all_events,
            "ai_turns": ai_turns_sorted,
            "chat_draft_history": chat_draft_history,
            "segments": seg_summary,
            "category_counts": category_counts,
            "type_counts": type_counts,
        }
        self._replay_events_cache[student_id] = result
        return result

    def _write_json_file(self, filepath: str, obj: Any):
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2, default=_json_default)
        except Exception:
            pass

    def _save_m0_files(self, stage_dir: str, session_data: StudentSessionData):
        """Saves M0 stage files: dq_report.json, provenance.json, and states.index.json."""
        self._write_json_file(os.path.join(stage_dir, "dq_report.json"), getattr(session_data, "dq_report", {}))
        self._write_json_file(os.path.join(stage_dir, "provenance.json"), getattr(session_data, "provenance", {}))

        # Build states index (list of snapshot timestamps and files overview)
        states_index = []
        for snap_t, f_map, alive_map in session_data.state_snapshots:
            states_index.append({
                "t": snap_t,
                "minute": minute_label(snap_t),
                "file_count": len(f_map),
                "files": {
                    fn: {
                        "chars": len(content),
                        "lines": len(content.splitlines()),
                    }
                    for fn, content in f_map.items()
                },
                "alive_chars": alive_map,
            })
        self._write_json_file(os.path.join(stage_dir, "states.index.json"), states_index)

    def _save_stage_files(
        self,
        student_id: str,
        session_data: StudentSessionData,
        signals: Dict[str, Any],
        segmenter: SessionSegmenter,
        segments: List[Any],
        interpreter: InterpretationEngine,
        facts: Dict[str, Any],
        largest_events: List[Any],
        not_chosen: List[Any],
        generator: SummaryGenerator,
        check_report: Dict[str, Any],
    ):
        stage_dir = os.path.join(self.output_dir, "stages", student_id)
        os.makedirs(stage_dir, exist_ok=True)

        def _write_json(filename: str, obj: Any):
            try:
                with open(os.path.join(stage_dir, filename), "w", encoding="utf-8") as f:
                    json.dump(obj, f, ensure_ascii=False, indent=2, default=_json_default)
            except Exception:
                pass

        self._save_m0_files(stage_dir, session_data)
        _write_json("signals.json", signals)
        _write_json(
            "segments.json",
            {
                "steps": getattr(segmenter, "steps", []),
                "segments": [s.to_dict() for s in segments],
                "threads": getattr(segmenter, "m_threads", []),
            },
        )
        _write_json(
            "facts.json",
            {
                "session": {k: v for k, v in facts.items() if k not in ("retained_chunks", "no_trace_chunks", "discarded_chunks", "repeated_threads")},
                "segments": {s.id: s.facts for s in segments},
            },
        )
        _write_json(
            "largest.json",
            {
                "session_id": f"{session_data.session_code}_{student_id}",
                "chosen": [ln.to_dict() for ln in largest_events],
                "not_chosen": not_chosen,
            },
        )
        _write_json("outline.json", generator.outline)
        _write_json("dropped.json", generator.dropped)
        _write_json("draft.json", generator.draft)
        _write_json("check_report.json", check_report)

        calls = check_report.get("llm_calls") or []
        try:
            with open(os.path.join(stage_dir, "llm_calls.jsonl"), "w", encoding="utf-8") as f:
                for c in calls:
                    f.write(json.dumps(c, ensure_ascii=False, default=str) + "\n")
        except Exception:
            pass
        _write_json("run_manifest.json", {
            "session_id": f"{session_data.session_code}_{student_id}",
            "task_id": session_data.session_code,
            "student_id": student_id,
            **self.run_identity(),
            "llm_used": check_report.get("llm_used", False),
            "fallback_used": check_report.get("fallback_used"),
            "llm_attempts": len(calls),
            "model_returned": sorted({c["model_returned"] for c in calls if c.get("model_returned")}),
            "checks_ok": check_report.get("ok"),
        })

    def run_identity(self) -> Dict[str, Any]:
        """Phiên bản code, tham số và prompt của lần chạy, ghi vào run_manifest.json (G2)."""
        from .constants import FORBIDDEN_PATH
        from .llm_client import build_system_prompt
        tool_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        code_files = sorted(
            [os.path.join("engine", f) for f in os.listdir(os.path.join(tool_dir, "engine")) if f.endswith(".py")]
            + ["generate_cli.py"]
        )
        h = hashlib.sha256()
        for rel in code_files:
            with open(os.path.join(tool_dir, rel), "rb") as f:
                h.update(rel.encode("utf-8") + b"\0" + f.read())
        with open(FORBIDDEN_PATH, "rb") as f:
            forbidden_sha = hashlib.sha256(f.read()).hexdigest()
        params_clean = {k: v for k, v in self.params.items() if "api_key" not in k.lower()}
        return {
            "code_sha256": h.hexdigest(),
            "code_files": code_files,
            "params": params_clean,
            "params_sha256": hashlib.sha256(json.dumps(params_clean, sort_keys=True, default=str).encode("utf-8")).hexdigest(),
            "model": self.params.get("llm.model"),
            "prompt_version": self.params.get("llm.prompt_version"),
            "max_tokens": self.params.get("llm.max_tokens"),
            "system_prompt_sha256": hashlib.sha256(build_system_prompt().encode("utf-8")).hexdigest(),
            "forbidden_sha256": forbidden_sha,
            "input_variant": self.params.get("llm.input_variant", "sentences"),
            "llm_enabled": self.params.get("llm.enabled", True),
        }

    def run_all(self) -> Dict[str, Dict[str, Any]]:
        """Runs two-pass pipeline for all students in the zip and generates manifest."""
        self._ensure_baseline()
        students = self.get_students()
        import time as _time
        results = {}
        manifest_rows = []
        run_rows = []
        for s_id in students:
            t0 = _time.time()
            try:
                res = self.run_student(s_id)
                results[s_id] = res
                try:
                    with open(os.path.join(self.output_dir, "stages", s_id, "run_manifest.json"), encoding="utf-8") as f:
                        sm = json.load(f)
                    run_rows.append({k: sm.get(k) for k in ("student_id", "llm_used", "fallback_used", "llm_attempts", "model_returned", "checks_ok")}
                                    | {"seconds": round(_time.time() - t0, 1)})
                except Exception:
                    run_rows.append({"student_id": s_id, "seconds": round(_time.time() - t0, 1)})
                m = res.get("metrics", {})
                largest_str = ", ".join(m.get("largest_events", [])) or "None"
                manifest_rows.append(
                    f"| {s_id} | {m.get('duration_min', 0)} phút | {m.get('runs_count', 0)} | {m.get('requests_count', 0)} | {m.get('ai_chunks_retained', 0)} | {largest_str} | [{s_id}_summary.md]({s_id}_summary.md) |"
                )
            except Exception as e:
                results[s_id] = {
                    "student_id": s_id,
                    "error": str(e),
                }
                run_rows.append({"student_id": s_id, "error": str(e), "seconds": round(_time.time() - t0, 1)})

        try:
            with open(os.path.join(self.output_dir, "run_manifest.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "session_code": self.session_code,
                    "zip_path": os.path.abspath(self.zip_path),
                    "finished_at": _time.strftime("%Y-%m-%d %H:%M:%S"),
                    **self.run_identity(),
                    "model_returned": sorted({m for r in run_rows for m in (r.get("model_returned") or [])}),
                    "students": run_rows,
                }, f, ensure_ascii=False, indent=2, default=str)
        except Exception:
            pass

        manifest_md = f"""# Bảng tổng hợp phiên thi: {self.session_code or os.path.basename(self.zip_path)}

Thư mục lưu trữ: `{self.output_dir}`
Tổng số sinh viên: {len(students)}

| Mã SV | Thời lượng | Lần chạy | Yêu cầu AI | Code AI giữ lại | Năm sự việc lớn nhất | Báo cáo chi tiết |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
""" + "\n".join(manifest_rows) + "\n"

        manifest_path = os.path.join(self.output_dir, "session_manifest_summary.md")
        try:
            with open(manifest_path, "w", encoding="utf-8") as f:
                f.write(manifest_md)
        except Exception:
            pass

        return results
