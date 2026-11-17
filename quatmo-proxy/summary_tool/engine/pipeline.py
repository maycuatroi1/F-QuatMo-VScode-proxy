# -*- coding: utf-8 -*-
"""
Pipeline module orchestrating the end-to-end execution of PhaseSUMMARY Engine
from zip archive to markdown output files and intermediate stage JSONs.
Strictly implements 2-pass execution:
- Pass 1: Ingestion & M1 Signals across all students to generate baseline.json
- Pass 2: M2 Segmentation, M3 Interpretation (with class percentiles), M4-M6 Generation & Validation,
  and export of all 10 intermediate JSONs in stages/<student_id>/.
"""

import os
import json
import time
from typing import Dict, List, Any, Optional
from .ingestion import ZipSessionIngester, StudentSessionData
from .signals import SignalsAnalyzer
from .segmentation import SessionSegmenter
from .interpretation import InterpretationEngine
from .generator import SummaryGenerator
from .constants import DEFAULT_PARAMS


class SummaryPipeline:
    def __init__(self, zip_path: str, output_dir: Optional[str] = None, params: Optional[Dict[str, Any]] = None):
        self.zip_path = zip_path
        base_dir = output_dir or r"d:\Fedu\PhaseSUMMARY\output_survey"
        # Create folder named after the zip archive (without .zip extension)
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

        self.ingester = ZipSessionIngester(zip_path)
        self.session_code = self.ingester.session_code
        self.processed_summaries: Dict[str, Dict[str, Any]] = {}
        self.baseline: Optional[Dict[str, List[float]]] = None

    def get_students(self) -> List[str]:
        return self.ingester.get_students()

    def run_pass1_baseline(self) -> Dict[str, List[float]]:
        """
        Pass 1: Runs Ingestion & M1 Signals across all students to build class baseline.json
        per Spec 00 Section 3 & Spec 04 Section 2.
        """
        students = self.get_students()
        baseline_data: Dict[str, List[float]] = {
            "n_runs_total": [],
            "n_requests_total": [],
            "T_task_min": [],
            "n_pauses_ge_3min": [],
            "n_threads_repeated": []
        }

        for s_id in students:
            try:
                s_data = self.ingester.load_student(s_id)
                # Check DQ1
                dq = getattr(s_data, "dq_report", {})
                dq1_pass = dq.get("DQ1", {}).get("pass", True)
                if not dq1_pass:
                    continue

                analyzer = SignalsAnalyzer(s_data, params=self.params)
                sig = analyzer.analyze()

                runs = sig.get("runs", [])
                reqs = sig.get("requests", [])
                pauses = sig.get("pauses", [])
                threads = sig.get("threads", [])

                baseline_data["n_runs_total"].append(len(runs))
                baseline_data["n_requests_total"].append(len(reqs))
                baseline_data["T_task_min"].append(max(int(sig.get("T_task_ms", 0) / 60000), 1))
                baseline_data["n_pauses_ge_3min"].append(len([p for p in pauses if p.get("length", 0) >= 180000]))
                baseline_data["n_threads_repeated"].append(len([th for th in threads if th.get("repeated")]))
            except Exception:
                pass

        self.baseline = baseline_data

        # Save baseline.json
        baseline_file = os.path.join(self.output_dir, "baseline.json")
        try:
            with open(baseline_file, "w", encoding="utf-8") as f:
                json.dump(baseline_data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

        return baseline_data

    def run_student(self, student_id: str, baseline: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Runs the complete M0 - M6 pipeline for a single student.
        Saves summary.md and all 10 intermediate stage JSONs in stages/<student_id>/.
        """
        # If baseline not provided, try loading from output_dir or instance
        effective_baseline = baseline or self.baseline
        if effective_baseline is None:
            baseline_file = os.path.join(self.output_dir, "baseline.json")
            if os.path.exists(baseline_file):
                try:
                    with open(baseline_file, "r", encoding="utf-8") as f:
                        effective_baseline = json.load(f)
                except Exception:
                    pass

        # 1. Ingestion (M0)
        session_data = self.ingester.load_student(student_id)

        # 2. M1: Signals Analysis
        analyzer = SignalsAnalyzer(session_data, params=self.params)
        signals = analyzer.analyze()

        # 3. M2: Segmentation
        segmenter = SessionSegmenter(session_data, signals, params=self.params)
        segments, threads, steps = segmenter.segment()

        # 4. M3: Interpretation & Asks (with class baseline percentiles)
        interpreter = InterpretationEngine(
            session_data, signals, segments,
            threads=threads,
            baseline=effective_baseline,
            params=self.params
        )
        facts, asks, dh0, asks_report = interpreter.interpret()

        # 5. M4 - M6: Markdown Generation & Validation
        generator = SummaryGenerator(
            session_data, signals, segments, facts, asks, dh0,
            params=self.params
        )
        markdown_text, check_report, outline, dropped = generator.generate()

        # 6. Save intermediate stage JSONs in stages/<student_id>/
        stages_dir = os.path.join(self.output_dir, "stages", student_id)
        os.makedirs(stages_dir, exist_ok=True)

        def save_stage_json(filename: str, data: Any):
            try:
                with open(os.path.join(stages_dir, filename), "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2, default=str)
            except Exception:
                pass

        save_stage_json("dq_report.json", getattr(session_data, "dq_report", {}))
        save_stage_json("signals.json", signals)
        save_stage_json("segments.json", {
            "segments": [s.to_dict() for s in segments],
            "threads": threads,
            "steps": [st.to_dict() for st in steps]
        })
        save_stage_json("facts.json", facts)
        save_stage_json("asks.json", asks_report)
        save_stage_json("outline.json", outline)
        save_stage_json("dropped.json", dropped)
        save_stage_json("check_report.json", check_report)
        save_stage_json("run_manifest.json", {
            "student_id": student_id,
            "session_code": session_data.session_code,
            "timestamp": time.time(),
            "model": check_report.get("llm_model", "gemma-4-26b"),
            "llm_used": check_report.get("llm_used", False),
            "input_variant": self.params.get("llm.input_variant", "sentences"),
            "prompt_version": self.params.get("llm.prompt_version", "1.0")
        })

        # 7. Save summary markdown to disk (both in root and students/ directory)
        students_dir = os.path.join(self.output_dir, "students")
        os.makedirs(students_dir, exist_ok=True)
        out_filename = f"{student_id}_summary.md"
        out_path = os.path.join(students_dir, out_filename)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(markdown_text)
        with open(os.path.join(self.output_dir, out_filename), "w", encoding="utf-8") as f:
            f.write(markdown_text)

        result = {
            "student_id": student_id,
            "session_code": session_data.session_code,
            "markdown": markdown_text,
            "out_path": out_path,
            "stages_dir": stages_dir,
            "check_report": check_report,
            "metrics": {
                "duration_min": facts.get("duration_min", 0),
                "T_task_min": facts.get("T_task_min", 0),
                "runs_count": facts.get("total_runs", 0),
                "requests_count": facts.get("requests_count", 0),
                "ai_chunks_retained": len(facts.get("retained_chunks", [])),
                "trajectory": facts.get("trajectory", "none"),
                "top_ask": asks[0].rule if asks else "None",
                "llm_used": check_report.get("llm_used", False),
                "llm_model": check_report.get("llm_model", "gemma-4-26b")
            }
        }
        self.processed_summaries[student_id] = result
        return result

    def run_all(self, workers: int = 3) -> Dict[str, Dict[str, Any]]:
        """
        Runs full 2-pass pipeline across all students in the session archive with parallel workers.
        """
        students = self.get_students()
        print(f"[{self.session_code}] Starting Pass 1: computing baseline across {len(students)} students...", flush=True)

        # Pass 1: Compute baseline across all students
        baseline = self.run_pass1_baseline()
        print(f"[{self.session_code}] Pass 1 baseline computed successfully.", flush=True)

        # Pass 2: Generate summaries and intermediate stages
        results = {}
        manifest_rows = []

        print(f"[{self.session_code}] Starting Pass 2: generating summaries with {workers} workers (model: gemma-4-26b)...", flush=True)

        if workers > 1:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            with ThreadPoolExecutor(max_workers=workers) as pool:
                future_to_sid = {pool.submit(self.run_student, s_id, baseline): s_id for s_id in students}
                for future in as_completed(future_to_sid):
                    s_id = future_to_sid[future]
                    try:
                        res = future.result()
                        results[s_id] = res
                        m = res.get("metrics", {})
                        used_model = m.get('llm_model', 'gemma-4-26b')
                        print(f"  [OK] Student {s_id}: Done using {used_model} ({len(results)}/{len(students)})", flush=True)
                    except Exception as e:
                        results[s_id] = {"student_id": s_id, "error": str(e)}
                        print(f"  [ERR] Student {s_id}: {e}", flush=True)
        else:
            for idx, s_id in enumerate(students, 1):
                try:
                    res = self.run_student(s_id, baseline=baseline)
                    results[s_id] = res
                    m = res.get("metrics", {})
                    used_model = m.get('llm_model', 'gemma-4-26b')
                    print(f"  [OK] Student {s_id}: Done using {used_model} ({idx}/{len(students)})", flush=True)
                except Exception as e:
                    results[s_id] = {"student_id": s_id, "error": str(e)}
                    print(f"  [ERR] Student {s_id}: {e}", flush=True)

        for s_id in sorted(students):
            res = results.get(s_id, {})
            m = res.get("metrics", {})
            manifest_rows.append(
                f"| {s_id} | {m.get('duration_min', 0)} phút | {m.get('runs_count', 0)} | {m.get('requests_count', 0)} | {m.get('ai_chunks_retained', 0)} | {m.get('trajectory', '-')} | [{s_id}_summary.md](students/{s_id}_summary.md) |"
            )

        # Write manifest file
        manifest_md = f"""# Bảng tổng hợp phiên thi: {self.session_code or os.path.basename(self.zip_path)}

Thư mục lưu trữ: `{self.output_dir}`
Tổng số sinh viên: {len(students)}

| Mã SV | Thời lượng | Lần chạy | Yêu cầu AI | Code AI giữ lại | Kiểu hỏi AI | Báo cáo chi tiết |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
""" + "\n".join(manifest_rows) + "\n"

        manifest_path = os.path.join(self.output_dir, "session_manifest_summary.md")
        try:
            with open(manifest_path, "w", encoding="utf-8") as f:
                f.write(manifest_md)
        except Exception:
            pass

        return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="PhaseSUMMARY Pipeline")
    parser.add_argument("--zip", type=str, required=True, help="Path to zip file")
    parser.add_argument("--student", type=str, help="Student ID")
    parser.add_argument("--output-dir", type=str, help="Output directory")
    parser.add_argument("--workers", type=int, default=3, help="Number of concurrent workers for Pass 2")
    args = parser.parse_args()

    pipeline = SummaryPipeline(args.zip, output_dir=args.output_dir)
    if args.student:
        res = pipeline.run_student(args.student)
        print(f"Done student {args.student}: {res.get('out_path')}")
    else:
        results = pipeline.run_all(workers=args.workers)
        print(f"Processed {len(results)} students.")
