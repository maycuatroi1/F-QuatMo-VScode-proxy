"""Scheduled analysis window; source ZIPs are read-only."""
import json
import math
import re
from datetime import datetime


def to_ms(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = float(value)
        if not math.isfinite(number) or number <= 0:
            return None
        return number * 1000 if number < 1e11 else number
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return parsed.timestamp() * 1000 if parsed.tzinfo else None
        except (TypeError, ValueError):
            return None


def request_time(turn):
    match = re.match(r"chat-(\d+)-", str(turn.get("requestId", "")))
    return to_ms(turn.get("createdAt")) or (to_ms(match[1]) if match else None) or to_ms(turn.get("timestamp"))


def resolve_window(archive, student_id, upload_paths):
    try:
        manifest = json.loads(archive.read("session_manifest.json"))
    except (KeyError, ValueError):
        raise ValueError("Session schedule is required for summary analysis.")
    created = to_ms(manifest.get("createdAt")) or to_ms(manifest.get("startTime"))
    try:
        duration = float(manifest.get("durationMinutes"))
    except (TypeError, ValueError):
        duration = float("nan")
    if not created or not math.isfinite(duration) or (duration <= 0 and duration != -1):
        raise ValueError("Unresolved session schedule.")
    end = created + (1440 if duration == -1 else duration) * 60000
    values = []
    for student in manifest.get("students", []):
        if str(student.get("studentId", "")).upper() == student_id.upper() and student.get("loginTimestamp") is not None:
            values.append(to_ms(student["loginTimestamp"]))
    for name in upload_paths:
        info = json.loads(archive.read(name))
        value = info.get("validityWindow", {}).get("signinTimestamp")
        if value is not None:
            values.append(to_ms(value))
    if not values or not values[0] or any(value != values[0] for value in values) or not created <= values[0] <= end:
        raise ValueError("Unresolved student sign-in.")
    return values[0], end


def select_records(records, begin, end):
    seen = set()
    result = []
    for record in records:
        if not isinstance(record, dict):
            continue
        timestamp = to_ms(record.get("timestamp"))
        if timestamp is None or not begin <= timestamp <= end:
            continue
        key = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        if key in seen:
            continue
        seen.add(key)
        result.append({**record, "timestamp": timestamp})
    return result


def exclude_request_conflicts(records):
    requests = {}
    for record in records:
        if record.get("type") in ("chat_request", "ai_request") or "prompt" in record:
            identity = record.get("requestId") or record.get("payload", {}).get("requestId")
            if identity:
                requests.setdefault(identity, set()).add(json.dumps(record, sort_keys=True, ensure_ascii=False))
    conflicts = {identity for identity, variants in requests.items() if len(variants) > 1}
    return [record for record in records if (record.get("requestId") or record.get("payload", {}).get("requestId")) not in conflicts]
