import io
import json
import unittest
import zipfile
import tempfile
from pathlib import Path
from engine.session_window import to_ms, resolve_window, select_records, exclude_request_conflicts
from engine.ingestion import ZipSessionIngester

T = 1790209800000


class SessionWindowTest(unittest.TestCase):
    def archive(self, signin=T, duration=180, upload_signin=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr("session_manifest.json", json.dumps({"createdAt": T, "durationMinutes": duration, "students": [{"studentId": "SE1", "loginTimestamp": signin}]}))
            z.writestr("SE1/upload_info.json", json.dumps({"sessionCode": "TEST", "validityWindow": {"signinTimestamp": upload_signin if upload_signin is not None else signin}}))
            z.writestr("SE1/exam_records/R/events.jsonl", "\n".join(json.dumps({"timestamp": stamp, "type": "file_switch", "payload": {"toFile": "file:///main.py"}}) for stamp in (T-1,T+1000,T+180*60000+1)))
        return buffer.getvalue()

    def test_units_and_strict_selection(self):
        self.assertEqual(to_ms(T/1000), T)
        self.assertIsNone(to_ms(float("inf")))
        records = [{"timestamp":T,"type":"edit","payload":{"text":s}} for s in ("a","b","a")]
        self.assertEqual(len(select_records(records, T, T)),2)
        self.assertEqual(select_records([{"timestamp":T+1}],T,T),[])

    def test_production_includes_instructor_logs_in_normal_enumeration(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp)/"TEST.zip"
            buffer = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(self.archive())) as source, zipfile.ZipFile(buffer, "w") as target:
                for entry in source.infolist():
                    target.writestr(entry.filename.replace("SE1", "DATTT67"), source.read(entry).replace(b"SE1", b"DATTT67"))
            file.write_bytes(buffer.getvalue())
            ingester = ZipSessionIngester(str(file))
            self.assertIn("DATTT67", ingester.get_students())
            self.assertEqual(ingester.load_student("DATTT67").student_id, "DATTT67")

    def test_conflicting_signin_is_unresolved(self):
        with zipfile.ZipFile(io.BytesIO(self.archive(signin=0,upload_signin=T))) as z:
            with self.assertRaisesRegex(ValueError,"sign-in"):
                resolve_window(z,"SE1",["SE1/upload_info.json"])

    def test_conflicting_request_ids_are_excluded_without_deduplicating_repeated_text(self):
        requests = [{"timestamp": T+i, "type":"chat_request", "payload":{"requestId":identity,"prompt":prompt}} for i, (identity,prompt) in enumerate((("conflict","one"),("conflict","two"),("ok1","same"),("ok2","same")))]
        self.assertEqual([r["payload"]["requestId"] for r in exclude_request_conflicts(requests)], ["ok1","ok2"])

    def test_long_session_uses_declared_duration(self):
        with zipfile.ZipFile(io.BytesIO(self.archive(duration=1000))) as z:
            self.assertEqual(resolve_window(z,"SE1",["SE1/upload_info.json"]),(T,T+60000000))

    def test_real_ingester_uses_schedule_instead_of_metadata_or_activity_cluster(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/"TEST.zip"
            file.write_bytes(self.archive())
            original=file.read_bytes()
            data=ZipSessionIngester(str(file)).load_student("SE1")
            self.assertEqual(data.start_ts,T)
            self.assertEqual(data.end_ts,T+180*60000)
            self.assertTrue(all(T<=e["timestamp"]<=T+180*60000 for e in data.events))
            self.assertEqual(file.read_bytes(),original)

    def test_updated_clock_rules_preserve_raw_clock_and_verified_bounds(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr("session_manifest.json", json.dumps({"sessionCode": "TEST", "createdAt": T, "durationMinutes": 180, "students": [{"studentId": "SE1", "loginTimestamp": T}]}))
            z.writestr("SE1/exam_records/R/events.jsonl", json.dumps({"timestamp": T+10000, "type": "terminal_command", "payload": {"command": "python main.py", "durationMs": 3000}}))
            z.writestr("SE1/exam_records/R/ai_interactions.jsonl", json.dumps({"timestamp": T+20000, "type": "chat_request", "payload": {"requestId": f"chat-{T+15000}-x", "messages": [{"role": "user", "content": "Explain sorting"}]}}))
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp)/"TEST.zip"
            file.write_bytes(buffer.getvalue())
            data = ZipSessionIngester(str(file)).load_student("SE1")
            self.assertEqual((data.start_ts, data.end_ts), (T, T+180*60000))
            command = next(e for e in data.events if e.get("type") == "terminal_command")
            request = next(e for e in data.ai_interactions if e.get("type") == "chat_request")
            self.assertEqual(command["timestamp"], T+7000)
            self.assertEqual(command["payload"]["_logged_ts"], T+10000)
            self.assertEqual(request["timestamp"], T+15000)
            self.assertEqual(request["payload"]["_logged_ts"], T+20000)
            self.assertEqual(file.read_bytes(), buffer.getvalue())
