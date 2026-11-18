import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { SUMMARY_MAX_ARCHIVE_BYTES, SUMMARY_MAX_ARCHIVE_FILES } from "../config/summaryLimits";
import { normalizeUploadRelPath } from "./security";
import { s3Storage } from "./s3Storage";

const artifacts = new Set(["events.jsonl", "ai_interactions.jsonl", "metadata.json", "upload_info.json", "snapshot_start.zip"]);

export function validateSummaryZip(buffer: Buffer): void {
  if (!Number.isSafeInteger(SUMMARY_MAX_ARCHIVE_BYTES) || SUMMARY_MAX_ARCHIVE_BYTES < 1 || !Number.isSafeInteger(SUMMARY_MAX_ARCHIVE_FILES) || SUMMARY_MAX_ARCHIVE_FILES < 1) throw new Error("Invalid summary archive limits.");
  if (buffer.length > SUMMARY_MAX_ARCHIVE_BYTES) throw new Error("Summary ZIP exceeds archive limits.");
  // Bound central-directory allocation before adm-zip parses attacker-controlled entries.
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid summary ZIP directory.");
  const entries = buffer.readUInt16LE(end + 10);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || buffer.readUInt16LE(end + 8) !== entries || entries === 65535 || buffer.readUInt32LE(end + 12) + buffer.readUInt32LE(end + 16) > end) throw new Error("Unsupported summary ZIP directory.");
  if (entries > SUMMARY_MAX_ARCHIVE_FILES) throw new Error("Summary ZIP contains too many entries.");
  let bytes = 0;
  let count = 0;
  function inspect(zip: AdmZip) {
    for (const entry of zip.getEntries()) {
      if (++count > SUMMARY_MAX_ARCHIVE_FILES) throw new Error("Summary ZIP contains too many entries.");
      if (!normalizeUploadRelPath(entry.entryName)) throw new Error("Summary ZIP contains an unsafe path.");
      if (entry.isDirectory) continue;
      bytes += entry.header.size;
      if (bytes > SUMMARY_MAX_ARCHIVE_BYTES || (entry.header.size > 1024 * 1024 && entry.header.size / Math.max(1, entry.header.compressedSize) > 200)) {
        throw new Error("Summary ZIP exceeds decompression limits.");
      }
      // Nested inflation and actual-byte checks run in the memory-limited Python worker.
    }
  }
  inspect(new AdmZip(buffer));
  if (!count) throw new Error("Summary ZIP is empty.");
}

/** Assemble only telemetry, preserving local evidence and filling missing files from S3. */
export async function createSummaryArchive(sessionCode: string, tempDir: string): Promise<string> {
  const zip = new AdmZip();
  const files = new Set<string>();
  let bytes = 0;
  function add(name: string, data: Buffer | string) {
    if (files.has(name)) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytes += buffer.length;
    if (bytes > SUMMARY_MAX_ARCHIVE_BYTES || files.size >= SUMMARY_MAX_ARCHIVE_FILES) throw new Error("Session telemetry exceeds summary archive limits.");
    zip.addFile(name, buffer);
    files.add(name);
  }
  function isTelemetry(name: string) {
    const segments = name.split("/");
    return (segments.length === 1 && /^[A-Za-z0-9_-]+\.json$/.test(name) && !/^(manifest|session_manifest|metadata|upload_info)\.json$/i.test(name)) ||
      (segments.length > 1 && artifacts.has(segments.at(-1)!));
  }
  const root = path.resolve("logs", "sessions", sessionCode);
  async function walk(dir: string, prefix: string) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (!normalizeUploadRelPath(name)) continue;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + "/");
      else if (entry.isFile() && isTelemetry(name)) add(name, await fs.promises.readFile(path.join(dir, entry.name)));
    }
  }
  if (fs.existsSync(root)) await walk(root, "");
  if (s3Storage.isAvailable()) {
    for (const relativePath of await s3Storage.listSessionTelemetryFiles(sessionCode)) {
      const [studentId, ...parts] = relativePath.split("/");
      if (!/^[A-Za-z0-9_-]+$/.test(studentId) || !normalizeUploadRelPath(relativePath)) throw new Error("Invalid S3 telemetry path.");
      const filePath = parts.join("/");
      const name = filePath === "prompt_turns.json" ? `${studentId}.json` : relativePath;
      if (!isTelemetry(name) || files.has(name)) continue;
      const content = await s3Storage.getStudentFile(sessionCode, studentId, filePath);
      if (content === null) throw new Error("Unable to read session telemetry from S3.");
      add(name, content);
    }
  }
  if (!files.size) {
    const archiveDir = process.env.SUMMARY_ARCHIVE_DIR || path.resolve("logs", "sessions");
    for (const name of [`${sessionCode}-logs.zip`, `${sessionCode}.zip`, `logs_${sessionCode}.zip`, `session-${sessionCode}-logs.zip`]) {
      const candidate = path.resolve(archiveDir, name);
      if (fs.existsSync(candidate)) {
        validateSummaryZip(await fs.promises.readFile(candidate));
        return candidate;
      }
    }
    throw new Error(`No telemetry available for session ${sessionCode}.`);
  }
  add("session_manifest.json", JSON.stringify({ sessionCode }));
  const buffer = zip.toBuffer();
  validateSummaryZip(buffer);
  const target = path.join(tempDir, `${sessionCode}.zip`);
  await fs.promises.writeFile(target, buffer);
  return target;
}
