# -*- coding: utf-8 -*-
"""
CLI entry point for PhaseSUMMARY Engine.
Allows quatmo-proxy or external scripts to run single-student or batch summary generation.
Outputs JSON to stdout or saves markdown to destination folder.
"""

import os
import sys
import json
import argparse
import threading

# Ensure engine is in python path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

from engine.pipeline import SummaryPipeline
from engine.config import config
from engine.archive_security import apply_memory_limit, validate_archive, validate_student_ids


def error_payload(error, phase):
    return {"ok": False, "error": str(error), "phase": phase, "error_type": type(error).__name__}


class ProgressSummaryPipeline(SummaryPipeline):
    """Observe completed reports without changing the research pipeline."""
    def __init__(self, *args, report_progress=False, single=False, **kwargs):
        super().__init__(*args, **kwargs)
        self._report_progress = report_progress
        self._report_total = 1 if single else len(self.get_students())
        self._report_completed = 0
        self._report_lock = threading.Lock()

    def emit_progress(self):
        if self._report_progress:
            print("SUMMARY_PROGRESS " + json.dumps({"completed": self._report_completed, "total": self._report_total}), file=sys.stderr, flush=True)

    def run_student(self, *args, **kwargs):
        result = super().run_student(*args, **kwargs)
        with self._report_lock:
            self._report_completed += 1
            self.emit_progress()
        return result

def main():
    parser = argparse.ArgumentParser(description="PhaseSUMMARY CLI Engine")
    parser.add_argument("--zip", type=str, help="Path to exam session zip archive")
    parser.add_argument("--student", type=str, help="Student ID to generate summary for")
    parser.add_argument("--output-dir", type=str, help="Directory to save output markdown files")
    parser.add_argument("--json", action="store_true", help="Output result as JSON to stdout")
    parser.add_argument("--progress", action="store_true", help="Emit report-completion counters to stderr")

    args = parser.parse_args()

    zip_path = args.zip or config.default_zip
    if not zip_path or not os.path.exists(zip_path):
        err = {"ok": False, "error": f"Zip file not found: {zip_path}"}
        print(json.dumps(err, ensure_ascii=False))
        sys.exit(1)

    phase = "memory_limit"
    try:
        apply_memory_limit()
        phase = "archive_validation"
        validate_archive(zip_path)
        phase = "student_validation"
        if args.student:
            validate_student_ids([args.student])
        out_dir = args.output_dir or config.output_dir
        phase = "pipeline_initialization"
        pipeline = ProgressSummaryPipeline(zip_path, output_dir=out_dir, params=config.model.to_pipeline_params(), report_progress=args.progress, single=bool(args.student))
        phase = "student_validation"
        validate_student_ids(pipeline.get_students())
        pipeline.emit_progress()
    except Exception as e:
        print(json.dumps(error_payload(e, phase), ensure_ascii=False))
        sys.exit(1)

    if args.student:
        try:
            res = pipeline.run_student(args.student)
            payload = {
                "ok": True,
                "analysisRuleVersion": "scheduled-signin-v1",
                "summaryRuleVersion": "phase-summary-3.1-2026-11-18",
                "student_id": res["student_id"],
                "session_code": res["session_code"],
                "markdown": res["markdown"],
                "out_path": res["out_path"],
                "check_report": res["check_report"],
                "metrics": res["metrics"]
            }
            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                print(f"Summary generated for {args.student}: {res['out_path']}")
        except Exception as e:
            err = {**error_payload(e, "single_generation"), "student_id": args.student}
            print(json.dumps(err, ensure_ascii=False))
            sys.exit(1)
    else:
        try:
            results = pipeline.run_all()
            if any(not result.get("ok") for result in results.values()):
                raise RuntimeError("One or more student summaries failed.")
            manifest_path = os.path.join(pipeline.output_dir, "session_manifest_summary.md")
            manifest_content = ""
            if os.path.exists(manifest_path):
                with open(manifest_path, "r", encoding="utf-8") as f:
                    manifest_content = f.read()

            payload = {
                "ok": True,
                "analysisRuleVersion": "scheduled-signin-v1",
                "summaryRuleVersion": "phase-summary-3.1-2026-11-18",
                "session_code": pipeline.session_code,
                "student_count": len(results),
                "output_dir": pipeline.output_dir,
                "manifest_path": manifest_path,
                "manifest_content": manifest_content,
                "students": list(results.keys())
            }
            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                print(f"Batch processed {len(results)} students in {pipeline.output_dir}")
        except Exception as e:
            err = error_payload(e, "batch_generation")
            print(json.dumps(err, ensure_ascii=False))
            sys.exit(1)

if __name__ == "__main__":
    main()
