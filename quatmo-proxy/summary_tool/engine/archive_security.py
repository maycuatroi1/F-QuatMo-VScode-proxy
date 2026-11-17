"""Validate untrusted archives before the research pipeline reads them."""
import io
import os
from pathlib import Path
import re
import stat
import sys
import zipfile


def apply_memory_limit():
    if sys.platform != "linux":
        return
    import resource
    megabytes = int(os.getenv("SUMMARY_ENGINE_MEMORY_MB") or "1024")
    if megabytes < 1:
        raise ValueError("Invalid summary memory limit.")
    requested = megabytes * 1024 * 1024
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    maximum = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
    resource.setrlimit(resource.RLIMIT_AS, (maximum, maximum))


def validate_archive(filename):
    maximum_bytes = int(os.getenv("MAX_UPLOAD_BYTES") or str(100 * 1024 * 1024))
    maximum_files = int(os.getenv("MAX_UPLOAD_FILES") or "5000")
    if maximum_bytes < 1 or maximum_files < 1:
        raise ValueError("Invalid summary archive limits.")
    if Path(filename).stat().st_size > maximum_bytes:
        raise ValueError("Summary archive exceeds size limits.")
    actual_bytes = 0
    entry_count = 0

    def inspect(archive, nested=False):
        nonlocal actual_bytes, entry_count
        entries = archive.infolist()
        entry_count += len(entries)
        if entry_count > maximum_files:
            raise ValueError("Summary archive contains too many entries.")
        names = set()
        declared_bytes = 0
        for entry in entries:
            name = entry.filename.replace("\\", "/")
            segments = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\0" in name or ":" in name
                    or any(part in ("", ".", "..") for part in segments)
                    or name in names or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError("Summary archive contains unsafe or duplicate paths.")
            names.add(name)
            declared_bytes += entry.file_size
            if (declared_bytes + actual_bytes > maximum_bytes
                    or (entry.file_size > 1024 * 1024 and entry.file_size / max(1, entry.compress_size) > 200)):
                raise ValueError("Summary archive exceeds decompression limits.")
        for entry in entries:
            if entry.is_dir():
                continue
            is_snapshot = not nested and entry.filename.replace("\\", "/").endswith("snapshot_start.zip")
            chunks = []
            with archive.open(entry) as stream:
                while True:
                    chunk = stream.read(min(65536, maximum_bytes - actual_bytes + 1))
                    if not chunk:
                        break
                    actual_bytes += len(chunk)
                    if actual_bytes > maximum_bytes:
                        raise ValueError("Summary archive exceeds decompression limits.")
                    if is_snapshot:
                        chunks.append(chunk)
            if is_snapshot:
                with zipfile.ZipFile(io.BytesIO(b"".join(chunks))) as snapshot:
                    inspect(snapshot, nested=True)
        if not entries and not nested:
            raise ValueError("Summary archive is empty.")

    with zipfile.ZipFile(filename) as archive:
        inspect(archive)


def validate_student_ids(student_ids):
    seen = set()
    for student in student_ids:
        if not isinstance(student, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", student) or student.upper() in seen:
            raise ValueError("Unsafe or ambiguous student ID in summary archive.")
        seen.add(student.upper())
