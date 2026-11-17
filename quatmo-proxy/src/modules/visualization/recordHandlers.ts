import path from "path";
import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { sanitizeFilename } from "../telemetry/logFiles";

export async function uploadVisualizeRecord(c: any) {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
    const body = await c.req.json().catch(() => null);

    if (!body || !body.recordId) {
      return c.json({ error: "Missing recordId in request payload" }, 400);
    }

    const recordId = sanitizeFilename(body.recordId);
    const { metadata, events, aiInteractions, snapshotZipBase64 } = body;

    const targetDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      studentId,
      "exam_records",
      recordId,
    );
    await fs.promises.mkdir(targetDir, { recursive: true });

    if (metadata) {
      await fs.promises.writeFile(
        path.join(targetDir, "metadata.json"),
        typeof metadata === "string"
          ? metadata
          : JSON.stringify(metadata, null, 2),
        "utf-8",
      );
    }
    if (events) {
      const content = Array.isArray(events)
        ? events.map((e) => JSON.stringify(e)).join("\n")
        : String(events);
      await fs.promises.writeFile(
        path.join(targetDir, "events.jsonl"),
        content,
        "utf-8",
      );
    }
    if (aiInteractions) {
      const content = Array.isArray(aiInteractions)
        ? aiInteractions.map((e) => JSON.stringify(e)).join("\n")
        : String(aiInteractions);
      await fs.promises.writeFile(
        path.join(targetDir, "ai_interactions.jsonl"),
        content,
        "utf-8",
      );
    }
    if (snapshotZipBase64) {
      const buf = Buffer.from(snapshotZipBase64, "base64");
      await fs.promises.writeFile(
        path.join(targetDir, "snapshot_start.zip"),
        buf,
      );
    }

    if (s3Storage.isAvailable()) {
      if (metadata) {
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "metadata.json",
          typeof metadata === "string"
            ? metadata
            : JSON.stringify(metadata, null, 2),
          "application/json",
        );
      }
      if (events) {
        const content = Array.isArray(events)
          ? events.map((e) => JSON.stringify(e)).join("\n")
          : String(events);
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "events.jsonl",
          content,
          "application/x-ndjson",
        );
      }
      if (aiInteractions) {
        const content = Array.isArray(aiInteractions)
          ? aiInteractions.map((e) => JSON.stringify(e)).join("\n")
          : String(aiInteractions);
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "ai_interactions.jsonl",
          content,
          "application/x-ndjson",
        );
      }
      if (snapshotZipBase64) {
        const buf = Buffer.from(snapshotZipBase64, "base64");
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "snapshot_start.zip",
          buf,
          "application/zip",
        );
      }
    }

    return c.json({ success: true, sessionCode, studentId, recordId });
  }
