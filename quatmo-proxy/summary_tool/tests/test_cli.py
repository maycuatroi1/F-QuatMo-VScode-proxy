"""Synthetic-only checks for the engine packaged in the proxy image."""
import hashlib
import io
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(os.environ.get("SUMMARY_TOOL_ROOT", Path(__file__).resolve().parents[1]))
CLI = ROOT / "generate_cli.py"


class PackagedSummaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="summary-synthetic-")
        self.work = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        self.env.update({
            "PYTHONPATH": str(ROOT), "PYTHONDONTWRITEBYTECODE": "1",
            "SUMMARY_LLM_ENABLED": "false", "SUMMARY_LLM_MODEL": "gemma-4-26b",
            "CUSTOM_MODEL_NAME": "qwen3-coder", "CUSTOM_API_KEY": "synthetic-only-key",
            "SUMMARY_LLM_BASE_URL": "https://summary-fixture.invalid/v1",
            "MAX_UPLOAD_BYTES": "", "MAX_UPLOAD_FILES": "", "SUMMARY_ENGINE_MEMORY_MB": "",
        })

    def run_cli(self, *args):
        result = subprocess.run([sys.executable, str(CLI), *map(str, args)],
                                cwd=self.work, env=self.env, capture_output=True, text=True,
                                encoding="utf-8", timeout=30)
        return result, json.loads(result.stdout.strip().splitlines()[-1])

    def test_single_and_batch_preserve_input_and_emit_reports(self):
        archive = self.work / "SYNTHETIC_SESSION.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for student in ("SE1", "SE2"):
                output.writestr(f"{student}/upload_info.json", json.dumps({"sessionCode": "SYNTHETIC_SESSION"}))
                output.writestr(f"{student}/exam_records/REC/metadata.json", json.dumps({
                    "examStartAt": 1700000000000, "examEndAt": 1700000120000,
                }))
                output.writestr(f"{student}/exam_records/REC/events.jsonl", json.dumps({
                    "event": "save", "timestamp": 1700000060000,
                }) + "\n")
        original_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        output_dir = self.work / "output"
        result, single = self.run_cli("--zip", archive, "--student", "SE1", "--output-dir", output_dir, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(single["ok"])
        self.assertEqual(single["student_id"], "SE1")
        self.assertTrue(single["markdown"])
        self.assertFalse(single["check_report"]["llm_used"])
        result, batch = self.run_cli("--zip", archive, "--output-dir", output_dir, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(batch["ok"])
        self.assertEqual(sorted(batch["students"]), ["SE1", "SE2"])
        self.assertTrue(batch["manifest_content"])
        for student in batch["students"]:
            self.assertTrue((output_dir / archive.stem / "students" / f"{student}_summary.md").read_text(encoding="utf-8"))
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), original_hash)

    def test_missing_archive_returns_error_without_output(self):
        output = self.work / "should-not-exist"
        result, payload = self.run_cli("--zip", self.work / "missing.zip", "--output-dir", output, "--json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(payload["ok"])
        self.assertFalse(output.exists())

    def test_runtime_env_selects_summary_model_and_existing_custom_key(self):
        code = "from engine.config import config; import json; print(json.dumps({'model': config.model.model_name, 'uses_custom_key': config.model.api_key == 'synthetic-only-key'}))"
        result = subprocess.run([sys.executable, "-c", code], cwd=self.work, env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"model": "gemma-4-26b", "uses_custom_key": True})

    def test_llm_transport_verifies_tls_and_uses_configured_model(self):
        sys.path.insert(0, str(ROOT))
        self.addCleanup(lambda: sys.path.remove(str(ROOT)))
        with patch.dict(os.environ, self.env, clear=True):
            from engine.llm_client import GemmaSummarizer
            client = GemmaSummarizer(model="gemma-4-26b", base_url="https://fixture.invalid/v1", api_key="synthetic-key", aliases="none")
        response = io.BytesIO(json.dumps({"choices": [{"message": {"content": '{"key_points":["synthetic"],"timeline":[]}'}}]}).encode())
        response.headers = {"Content-Type": "application/json"}

        def fake_upstream(request, *, timeout):
            context = build.call_args.args[0]._context
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertEqual(json.loads(request.data)["model"], "gemma-4-26b")
            return response

        with patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = fake_upstream
            draft, calls = client.realize([], [], max_retries=0)
        build.return_value.open.assert_called_once()
        self.assertEqual(draft["key_points"], ["synthetic"])
        self.assertEqual(calls[0]["status"], "success")

    def test_nested_snapshot_alias_is_rejected_before_pipeline(self):
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr("large.txt", b"0" * (2 * 1024 * 1024))
        for name in ("snapshot_start.zip", "prefix_snapshot_start.zip"):
            archive = self.work / name
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("SE1/exam_records/REC/" + name, nested.getvalue())
            before = hashlib.sha256(archive.read_bytes()).hexdigest()
            result, payload = self.run_cli("--zip", archive, "--output-dir", self.work / "out", "--json")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(payload["ok"])
            self.assertFalse((self.work / "out").exists())
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), before)

    def test_archive_rejects_traversal_duplicate_paths_and_ambiguous_students(self):
        import warnings
        for entries in (("../events.jsonl",), ("SE1/events.jsonl", "SE1/events.jsonl"), ("SE1/events.jsonl", "se1/events.jsonl")):
            archive = self.work / "unsafe.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive, "w") as output:
                    for name in entries:
                        output.writestr(name, '{"event":"save"}\n')
            result, payload = self.run_cli("--zip", archive, "--output-dir", self.work / "out", "--json")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(payload["ok"])

    def test_redirects_cannot_forward_authorization(self):
        sys.path.insert(0, str(ROOT))
        self.addCleanup(lambda: sys.path.remove(str(ROOT)))
        from engine.llm_client import NoSummaryRedirect
        from urllib.request import Request
        request = Request("https://fixture.invalid/v1/chat/completions", headers={"Authorization": "Bearer synthetic"})
        self.assertIsNone(NoSummaryRedirect().redirect_request(request, None, 302, "Found", {}, "https://other.invalid/"))

    @unittest.skipUnless(sys.platform == "linux", "Production worker limit is Linux-specific")
    def test_linux_worker_has_configured_memory_limit(self):
        self.env["SUMMARY_ENGINE_MEMORY_MB"] = "256"
        code = "from engine.archive_security import apply_memory_limit; import resource; apply_memory_limit(); print(resource.getrlimit(resource.RLIMIT_AS)[0])"
        result = subprocess.run([sys.executable, "-c", code], cwd=self.work, env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(int(result.stdout), 256 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
