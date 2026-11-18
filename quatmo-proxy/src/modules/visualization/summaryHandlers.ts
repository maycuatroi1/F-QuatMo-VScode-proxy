import fs from "node:fs";
import path from "node:path";
import { summaryStorageService } from "../../services/summaryStorage";
import { sanitizeFilename } from "../telemetry/logFiles";
import { bodyLimit } from "hono/body-limit";
import { sessions } from "../../services/sessionStore";
import { requireCaller } from "../../shared/http/adminCaller";
import { SUMMARY_MAX_ARCHIVE_BYTES } from "../../config/summaryLimits";
import { validateSummaryZip } from "../../services/summaryArchive";
import { reportSummaryProgress } from "./summaryGuard";

export const summaryZipLimit = bodyLimit({ maxSize: SUMMARY_MAX_ARCHIVE_BYTES });

function generationFailure(c: any, err: any) {
  // Child-process errors may contain full stdout/stderr, reports or credentials.
  console.error("[Summary API] Generation failed", {
    code: typeof err?.code === "string" || typeof err?.code === "number" ? err.code : undefined,
    signal: typeof err?.signal === "string" ? err.signal : undefined,
    engineDiagnostic: err?.engineDiagnostic,
  });
  return c.json({ ok: false, error: "Unable to generate summary. Check the engine configuration or try again." }, 500);
}

export const getStudentSummary = async (c: any) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();

    let result = await summaryStorageService.getStudentSummary(
      sessionCode,
      studentId,
    );


    if (!result) {
      return c.json(
        {
          ok: false,
          error: "Summary not found for this student.",
          sessionCode,
          studentId,
        },
        404,
      );
    }

    return c.json(result);
  };

export const generateStudentSummary = async (c: any) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();

    try {
      const generated = await summaryStorageService.generateStudentSummary(
        sessionCode,
        studentId,
        undefined,
        true,
        reportSummaryProgress(c),
      );
      return c.json(generated);
    } catch (err: any) {
      return generationFailure(c, err);
    }
  };

export const getSessionSummaryManifest = async (c: any) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const manifest =
      await summaryStorageService.getSessionManifest(sessionCode);

    if (!manifest) {
      return c.json(
        {
          ok: false,
          error: "Summary manifest not found for this session.",
          sessionCode,
        },
        404,
      );
    }

    return c.json({
      ok: true,
      sessionCode,
      manifestMarkdown: manifest.manifestMarkdown,
      source: manifest.source,
    });
  };

export const generateSessionSummaries = async (c: any) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();

    try {
      const res =
        await summaryStorageService.generateSessionSummaries(sessionCode, undefined, true, reportSummaryProgress(c));
      return c.json(res);
    } catch (err: any) {
      return generationFailure(c, err);
    }
  };

export const generateSummaryFromZip = async (c: any) => {
  let tempDir: string | undefined;
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    const sessionCode = String(body.sessionCode || "HISTORICAL_SESSION").toUpperCase();
    const studentId = typeof body.studentId === "string" ? body.studentId.toUpperCase() : undefined;
    const mode = body.mode || (studentId ? "single" : "all");
    if (!/^[A-Z0-9_-]+$/.test(sessionCode) || (studentId !== undefined && !/^[A-Z0-9_-]+$/.test(studentId)) || !["single", "all"].includes(String(mode)) || (mode === "single" && !studentId)) {
      return c.json({ ok: false, error: "Invalid session, student or generation mode." }, 400);
    }
    const caller = requireCaller(c);
    const session = sessions.get(sessionCode);
    if (session && caller.role !== "admin" && (session.createdBy || "admin").toLowerCase() !== caller.username.toLowerCase()) {
      return c.json({ ok: false, error: "Forbidden. You do not own this session." }, 403);
    }
    if (!(file instanceof File) || !file.size || file.size > SUMMARY_MAX_ARCHIVE_BYTES) {
      return c.json({ ok: false, error: "A valid telemetry ZIP within the upload limit is required." }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try { validateSummaryZip(buffer); } catch {
      return c.json({ ok: false, error: "Invalid or unsafe telemetry ZIP archive." }, 400);
    }
    const root = path.resolve("logs", "temp_zips");
    await fs.promises.mkdir(root, { recursive: true });
    tempDir = await fs.promises.mkdtemp(path.join(root, "summary-"));
    const zipPath = path.join(tempDir, sessionCode + ".zip");
    await fs.promises.writeFile(zipPath, buffer);
    // Historical imports without a managed session stay in the importing UI.
    const persist = Boolean(session);
    const result = mode === "all"
      ? await summaryStorageService.generateSessionSummaries(sessionCode, zipPath, persist, reportSummaryProgress(c))
      : await summaryStorageService.generateStudentSummary(sessionCode, studentId!, zipPath, persist, reportSummaryProgress(c));
    return c.json(result);
  } catch (err: any) {
    return generationFailure(c, err);
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
};

export const listSessionSummaries = async (c: any) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const list =
      await summaryStorageService.listSessionSummaries(sessionCode);
    const listed = new Set(list.map((item) => item.studentId));
    for (const studentId of sessions.get(sessionCode)?.allowedStudentIds || []) {
      if (!listed.has(studentId)) list.push({ studentId, hasSummary: false, source: "none" });
    }
    return c.json({ ok: true, sessionCode, summaries: list });
  };
