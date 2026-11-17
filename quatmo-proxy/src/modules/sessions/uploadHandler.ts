import * as fs from "fs";
import * as path from "path";
import { verify } from "hono/jwt";
import { getJwtSecret } from "../../services/jwtKey";
import { sessions, sessionStates } from "../../services/sessionStore";
import { s3Storage } from "../../services/s3Storage";
import { normalizeUploadRelPath, resolveInside } from "../../services/security";
import { MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES } from "../../config/uploadLimits";
import { verifyTokenSignatureOnly } from "./uploadToken";
import { sanitizeFilename, toMs, sanitizeJsonlBuffer, mergeJsonlBuffers, mergeMetadataBuffers } from "./uploadArtifacts";

export async function uploadSessionLogs(c: any) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  let tokenPayload: any;
  try {
    tokenPayload = await verify(token, getJwtSecret(), "HS256" as any);
  } catch {
    // If standard verification fails (e.g. token expired because session ended),
    // verify the cryptographic signature directly to permit valid students to submit their logs.
    tokenPayload = await verifyTokenSignatureOnly(token, getJwtSecret());
    if (!tokenPayload) {
      return c.json({ error: "Token expired or invalid" }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenExp = Number(
      tokenPayload.exp || tokenPayload.sessionEndTime || 0,
    );
    const maxGraceSeconds = 14 * 24 * 3600; // 14-day upload grace window
    if (tokenExp > 0 && now > tokenExp + maxGraceSeconds) {
      return c.json(
        { error: "Log upload grace period (14 days) has expired" },
        401,
      );
    }
  }

  // Identity comes ONLY from the verified session token. Body fields are accepted
  // for backward compatibility but must match the token.
  const tokenSessionCode = String(tokenPayload?.sessionCode || "")
    .trim()
    .toUpperCase();
  const tokenStudentId = String(tokenPayload?.studentId || "")
    .trim()
    .toUpperCase();
  if (!tokenSessionCode || !tokenStudentId) {
    return c.json(
      { error: "A session token is required to upload logs." },
      403,
    );
  }

  let sessionCode = "";
  let studentId = "";
  let uploadReason = "";
  interface ParsedUploadFile {
    relativePath: string;
    buffer: Buffer;
  }
  const uploadFiles: ParsedUploadFile[] = [];

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Failed to parse multipart form data" }, 400);
    }
    sessionCode = String(
      formData.get("sessionCode") || tokenPayload.sessionCode || "",
    )
      .trim()
      .toUpperCase();
    studentId = String(
      formData.get("studentId") || tokenPayload.studentId || "",
    )
      .trim()
      .toUpperCase();
    uploadReason = String(formData.get("uploadReason") || "").trim();

    // Parse path mapping if provided as JSON array
    let explicitPaths: string[] = [];
    const pathsRaw = formData.get("filePaths");
    if (typeof pathsRaw === "string") {
      try {
        explicitPaths = JSON.parse(pathsRaw);
      } catch {
        /* ignore */
      }
    }

    const fileEntries = formData.getAll("files");
    for (let i = 0; i < fileEntries.length; i++) {
      const entry = fileEntries[i];
      if (entry && typeof (entry as any).arrayBuffer === "function") {
        const fileObj = entry as File;
        const relPath = explicitPaths[i] || fileObj.name;
        if (relPath) {
          const ab = await fileObj.arrayBuffer();
          uploadFiles.push({
            relativePath: relPath,
            buffer: Buffer.from(ab),
          });
        }
      }
    }
  } else {
    // Fallback: Legacy JSON payload
    const body = await c.req.json().catch(() => ({}));
    sessionCode = String(body.sessionCode || tokenPayload.sessionCode || "")
      .trim()
      .toUpperCase();
    studentId = String(body.studentId || tokenPayload.studentId || "")
      .trim()
      .toUpperCase();
    uploadReason = String(body.uploadReason || "").trim();

    const rawFiles: Array<{
      relativePath: string;
      content: string;
      encoding?: string;
    }> = body.files || [];
    for (const f of rawFiles) {
      if (f && f.relativePath && f.content !== undefined) {
        uploadFiles.push({
          relativePath: f.relativePath,
          buffer:
            f.encoding === "base64"
              ? Buffer.from(f.content, "base64")
              : Buffer.from(f.content, "utf-8"),
        });
      }
    }
  }

  sessionCode = sessionCode || tokenSessionCode;
  studentId = studentId || tokenStudentId;
  if (sessionCode !== tokenSessionCode || studentId !== tokenStudentId) {
    return c.json(
      { error: "sessionCode/studentId do not match your session token." },
      403,
    );
  }

  if (uploadFiles.length > MAX_UPLOAD_FILES) {
    return c.json({ error: `Too many files (max ${MAX_UPLOAD_FILES}).` }, 413);
  }
  // Drop (instead of rejecting the whole submission) entries whose path is absolute,
  // contains "..", or would overwrite the server-generated upload_info.json. The rest
  // of the student's work is still stored, and nothing can escape the student folder.
  let totalBytes = 0;
  let droppedFiles = 0;
  for (let i = uploadFiles.length - 1; i >= 0; i--) {
    const f = uploadFiles[i];
    const normalized = normalizeUploadRelPath(f.relativePath);
    if (!normalized || normalized.toLowerCase() === "upload_info.json") {
      uploadFiles.splice(i, 1);
      droppedFiles++;
      continue;
    }
    f.relativePath = normalized;
    totalBytes += f.buffer.length;
  }
  if (droppedFiles > 0) {
    console.warn(
      `[SessionAuth] upload-logs ${sessionCode}/${studentId}: dropped ${droppedFiles} file(s) with unsafe paths`,
    );
    if (uploadFiles.length === 0) {
      return c.json({ error: "Invalid file path." }, 400);
    }
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `Upload too large (max ${MAX_UPLOAD_BYTES} bytes).` },
      413,
    );
  }

  const targetDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sanitizeFilename(sessionCode),
    sanitizeFilename(studentId),
  );

  await fs.promises.mkdir(targetDir, { recursive: true });

  // Resolve authoritative session temporal boundaries for log sanitization [T_signin, T_expire + grace]
  const session = sessions.get(sessionCode);
  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);

  const signinTimeMs =
    toMs(tokenPayload?.loginTime) ||
    toMs(tokenPayload?.loginTimestamp) ||
    toMs(state?.loginTimestamp) ||
    toMs(session?.startTime) ||
    toMs(session?.createdAt);

  const durationMin = session?.durationMinutes || 90;
  const graceMs = 60 * 1000; // 60s network/flush grace window

  let expireTimeMs: number | null = null;
  if (tokenPayload?.sessionEndTime) {
    expireTimeMs = toMs(tokenPayload.sessionEndTime);
  } else if (session?.endedAt && session.endedAt > 0) {
    expireTimeMs = toMs(session.endedAt);
  } else if (signinTimeMs) {
    expireTimeMs = signinTimeMs + durationMin * 60 * 1000;
  }

  const nowMs = Date.now();
  if (expireTimeMs && (durationMin >= 180 || expireTimeMs > nowMs)) {
    expireTimeMs = Math.min(expireTimeMs, nowMs);
  }

  const minUploadTimestampMs = signinTimeMs ? signinTimeMs : null;
  const maxUploadTimestampMs = expireTimeMs ? expireTimeMs + graceMs : null;

  let allowedDates: Set<string> | undefined = undefined;
  if (signinTimeMs) {
    allowedDates = new Set<string>();
    allowedDates.add(new Date(signinTimeMs).toISOString().slice(0, 10));
    if (expireTimeMs) {
      allowedDates.add(new Date(expireTimeMs).toISOString().slice(0, 10));
    }
  }

  const logSanitizeMetrics = {
    totalRawEvents: 0,
    inWindowEvents: 0,
    droppedPreSigninEvents: 0,
    droppedPostExpireEvents: 0,
    droppedOutsideDateEvents: 0,
  };

  // 1. Asynchronous concurrent local disk writes with JSONL merge support (preserves historical logs across reassignments)
  await Promise.all(
    uploadFiles.map(async (file) => {
      const destPath = resolveInside(targetDir, file.relativePath);
      if (!destPath) return;
      const destDir = path.dirname(destPath);
      await fs.promises.mkdir(destDir, { recursive: true });

      // Preserve baseline initial snapshot: never overwrite start snapshot from machine 1
      if (
        file.relativePath.endsWith("snapshot_start.zip") &&
        fs.existsSync(destPath)
      ) {
        return;
      }

      if (
        file.relativePath.endsWith("events.jsonl") ||
        file.relativePath.endsWith("ai_interactions.jsonl")
      ) {
        // Sanitize incoming uploaded buffer strictly against [T_signin, T_expire + grace]
        const sanitizeRes = sanitizeJsonlBuffer(
          file.buffer,
          minUploadTimestampMs,
          maxUploadTimestampMs,
          allowedDates,
        );
        file.buffer = sanitizeRes.buffer;

        if (file.relativePath.endsWith("events.jsonl")) {
          logSanitizeMetrics.totalRawEvents = sanitizeRes.totalLines;
          logSanitizeMetrics.inWindowEvents = sanitizeRes.inWindowLines;
          logSanitizeMetrics.droppedPreSigninEvents =
            sanitizeRes.droppedPreSigninLines;
          logSanitizeMetrics.droppedPostExpireEvents =
            sanitizeRes.droppedPostExpireLines;
          logSanitizeMetrics.droppedOutsideDateEvents =
            sanitizeRes.droppedOutsideDateLines;
        }

        if (fs.existsSync(destPath)) {
          try {
            const existingBuf = await fs.promises.readFile(destPath);
            const sanitizedExisting = sanitizeJsonlBuffer(
              existingBuf,
              minUploadTimestampMs,
              maxUploadTimestampMs,
              allowedDates,
            );
            file.buffer = mergeJsonlBuffers(
              sanitizedExisting.buffer,
              file.buffer,
            );
          } catch (err) {
            console.warn(
              `[Logs] Failed to merge existing ${file.relativePath}:`,
              err,
            );
          }
        }
      } else if (
        file.relativePath.endsWith("metadata.json") &&
        fs.existsSync(destPath)
      ) {
        try {
          const existingBuf = await fs.promises.readFile(destPath);
          file.buffer = mergeMetadataBuffers(existingBuf, file.buffer);
        } catch (err) {
          console.warn(`[Logs] Failed to merge existing metadata.json:`, err);
        }
      }

      await fs.promises.writeFile(destPath, file.buffer);
    }),
  );

  const savedCount = uploadFiles.length;
  const metaPath = path.join(targetDir, "upload_info.json");
  const metaData = {
    studentId,
    sessionCode,
    uploadReason: uploadReason || undefined,
    uploadTimestamp: Math.floor(Date.now() / 1000),
    uploadTimeISO: new Date().toISOString(),
    filesUploaded: savedCount,
    ip: c.req.header("x-forwarded-for") || "local",
    validityWindow: {
      signinTimestamp: signinTimeMs || undefined,
      expireTimestamp: expireTimeMs || undefined,
      signinISO: signinTimeMs
        ? new Date(signinTimeMs).toISOString()
        : undefined,
      expireISO: expireTimeMs
        ? new Date(expireTimeMs).toISOString()
        : undefined,
      durationMinutes: durationMin,
      graceSeconds: 60,
    },
    metrics: logSanitizeMetrics,
  };
  await fs.promises.writeFile(
    metaPath,
    JSON.stringify(metaData, null, 2),
    "utf-8",
  );

  console.log(
    `[Logs] Uploaded ${savedCount} monitoring log file(s) for student ${studentId} in session ${sessionCode}`,
  );

  // 2. High-throughput parallel S3 upload with connection pooling
  if (s3Storage.isAvailable()) {
    try {
      // Clean previous exam records for this student in this session
      await s3Storage.purgeStudentExamRecords(sessionCode, studentId);

      // Upload all files concurrently
      const s3UploadPromises = uploadFiles.map((file) => {
        return s3Storage.uploadStudentFile(
          sessionCode,
          studentId,
          file.relativePath,
          file.buffer,
        );
      });

      s3UploadPromises.push(
        s3Storage.uploadStudentFile(
          sessionCode,
          studentId,
          "upload_info.json",
          JSON.stringify(metaData, null, 2),
          "application/json",
        ),
      );

      await Promise.all(s3UploadPromises);
      console.log(
        `[S3 Storage] High-throughput parallel synced ${savedCount} log file(s) for student ${studentId} in session ${sessionCode} to S3`,
      );
    } catch (s3Err) {
      console.error(
        `[S3 Storage] Failed to sync uploaded logs to S3 for ${sessionCode}/${studentId}:`,
        s3Err,
      );
    }
  }

  return c.json({
    success: true,
    message: `Successfully uploaded ${savedCount} monitoring log file(s).`,
    sessionCode,
    studentId,
    savedCount,
  });
}
