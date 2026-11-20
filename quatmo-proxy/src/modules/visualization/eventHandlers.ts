import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { readZipTextEntriesSafely } from "../../services/security";
import { appendJsonLines, hasNonEmptyLine } from "../telemetry/jsonl";
import { sanitizeFilename } from "../telemetry/logFiles";
import { toMs, deduplicateRecords, inSessionWindow } from "../../shared/sessionTime";
import { getStudentSessionWindow } from "./sessionWindow";
import { loadEventLogFromS3 } from "./s3EventLog";

export async function getVisualizeStudentEventLog(c: any) {
    const includeSnapshots = !c.get?.("visualizeCountsOnly");
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
    let studentDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      studentId,
    );

    if (!fs.existsSync(studentDir)) {
      const sessionDir = path.resolve(
        process.cwd(),
        "logs",
        "sessions",
        sessionCode,
      );
      if (fs.existsSync(sessionDir)) {
        try {
          const entries = await fs.promises.readdir(sessionDir);
          const match = entries.find(
            (e) => e.toLowerCase() === studentId.toLowerCase(),
          );
          if (match) {
            studentDir = path.join(sessionDir, match);
          }
        } catch {}
      }
    }

    let availableRecords: string[] = [];
    let activeRecordDir = studentDir;
    let coreRecords: any[] = [];
    let aiRecords: any[] = [];
    let metadata: any = null;
    let initialFiles: Record<string, string> = {};
    let uploadTimestamp: number | null = null;
    let uploadTimeISO: string | null = null;
    let validityWindow: any = null;
    let uploadMetrics: any = null;

    if (!fs.existsSync(studentDir)) {
      // Check S3 if no local student directory
      const s3Result = await loadEventLogFromS3(
        sessionCode,
        studentId,
        c.req.query("recordId"),
        includeSnapshots,
      );
      if (s3Result) {
        availableRecords = s3Result.availableRecords || [];
        activeRecordDir = s3Result.activeRecordDir || "";
        coreRecords = s3Result.coreRecords || [];
        aiRecords = s3Result.aiRecords || [];
        metadata = s3Result.metadata;
        initialFiles = s3Result.initialFiles || {};
        uploadTimestamp = s3Result.uploadTimestamp;
        uploadTimeISO = s3Result.uploadTimeISO;
        validityWindow = s3Result.validityWindow;
        uploadMetrics = s3Result.uploadMetrics;
      } else {
        return c.json({
          sessionCode,
          studentId,
          metadata: null,
          coreRecords: [],
          aiRecords: [],
          availableRecords: [],
          initialFiles: {},
        });
      }
    } else {
      try {
        const examRecordsDir = path.join(studentDir, "exam_records");
        if (fs.existsSync(examRecordsDir) || s3Storage.isAvailable()) {
          const recEntries = fs.existsSync(examRecordsDir) ? await fs.promises.readdir(examRecordsDir, {
            withFileTypes: true,
          }) : [];
          for (const r of recEntries) {
            if (r.isDirectory()) {
              availableRecords.push(r.name);
            }
          }
          if (s3Storage.isAvailable()) {
            for (const record of await s3Storage.listStudentExamRecords(sessionCode, studentId)) {
              if (!availableRecords.includes(record)) availableRecords.push(record);
            }
          }
          const artifact = async (record: string, name: string) => {
            const local = path.join(examRecordsDir, record, name);
            if (fs.existsSync(local)) return fs.promises.readFile(local);
            return s3Storage.isAvailable() ? s3Storage.getExamRecordArtifact(sessionCode, studentId, record, name) : null;
          };
          if (availableRecords.length > 0) {
            const reqRecordId = c.req.query("recordId");
            if (availableRecords.length > 1 && (!reqRecordId || reqRecordId === "all_merged")) {
              const allCore: any[] = [];
              const allAi: any[] = [];
              let mergedInitialFiles: Record<string, string> = {};
              let mergedMetadata: any = null;

              for (const rId of availableRecords) {
                const rDir = path.join(examRecordsDir, rId);

                const [ev, ai, meta, snap] = await Promise.all([
                  artifact(rId, "events.jsonl"), artifact(rId, "ai_interactions.jsonl"),
                  artifact(rId, "metadata.json"), includeSnapshots ? artifact(rId, "snapshot_start.zip") : null,
                ]);
                if (meta && !mergedMetadata) { try { mergedMetadata = JSON.parse(meta.toString()); } catch {} }
                if (snap && Object.keys(mergedInitialFiles).length === 0) {
                  try { Object.assign(mergedInitialFiles, readZipTextEntriesSafely(new AdmZip(Buffer.from(snap)))); } catch {}
                }
                if (ev) appendJsonLines(ev.toString(), allCore);
                if (ai) appendJsonLines(ai.toString(), allAi);
              }

              coreRecords = allCore;
              aiRecords = allAi;

              initialFiles = mergedInitialFiles;
              metadata = mergedMetadata || { examSessionId: "all_merged" };
              activeRecordDir = path.join(examRecordsDir, "all_merged");
              availableRecords = ["all_merged", ...availableRecords];
            } else {
              availableRecords.sort().reverse();
              let targetRecordId =
                reqRecordId && availableRecords.includes(reqRecordId)
                  ? reqRecordId
                  : availableRecords[0];

              if (!reqRecordId && availableRecords.length > 1) {
                for (const rId of availableRecords) {
                  const evFile = path.join(examRecordsDir, rId, "events.jsonl");
                  try {
                    if (fs.existsSync(evFile)) {
                      const content = await fs.promises.readFile(evFile, "utf-8");
                      if (hasNonEmptyLine(content)) {
                        targetRecordId = rId;
                        break;
                      }
                    }
                  } catch {}
                }
              }
              activeRecordDir = path.join(examRecordsDir, targetRecordId);


              const [ev, ai, meta, snap] = await Promise.all([
                artifact(targetRecordId, "events.jsonl"), artifact(targetRecordId, "ai_interactions.jsonl"),
                artifact(targetRecordId, "metadata.json"), includeSnapshots ? artifact(targetRecordId, "snapshot_start.zip") : null,
              ]);
              if (meta) { try { metadata = JSON.parse(meta.toString()); } catch {} }
              if (ev) appendJsonLines(ev.toString(), coreRecords);
              if (ai) appendJsonLines(ai.toString(), aiRecords);
              if (snap) { try { Object.assign(initialFiles, readZipTextEntriesSafely(new AdmZip(Buffer.from(snap)))); } catch {} }

            }
          }
        }

        if (!availableRecords.length) {
          for (const [file, target] of [["events.jsonl", coreRecords], ["ai_interactions.jsonl", aiRecords]] as const) {
            const legacyPath = path.join(studentDir, file);
            if (fs.existsSync(legacyPath)) appendJsonLines(await fs.promises.readFile(legacyPath, "utf8"), target);
          }
          if (coreRecords.length || aiRecords.length) availableRecords = ["legacy"];
        }
        const uploadInfoPath = path.join(studentDir, "upload_info.json");
        if (fs.existsSync(uploadInfoPath)) {
          try {
            const uInfo = JSON.parse(
              await fs.promises.readFile(uploadInfoPath, "utf-8"),
            );
            if (uInfo.uploadTimestamp) {
              const rawTs = Number(uInfo.uploadTimestamp);
              uploadTimestamp = rawTs < 1e11 ? rawTs * 1000 : rawTs;
            }
            if (uInfo.uploadTimeISO) uploadTimeISO = uInfo.uploadTimeISO;
            if (uInfo.validityWindow) validityWindow = uInfo.validityWindow;
            if (uInfo.metrics) uploadMetrics = uInfo.metrics;
          } catch {}
        }

        if (
          availableRecords.length === 0 &&
          coreRecords.length === 0 &&
          s3Storage.isAvailable()
        ) {
          const s3Result = await loadEventLogFromS3(
            sessionCode,
            studentId,
            c.req.query("recordId"),
            includeSnapshots,
          );
          if (s3Result) {
            availableRecords = s3Result.availableRecords || [];
            activeRecordDir = s3Result.activeRecordDir || "";
            coreRecords = s3Result.coreRecords || [];
            aiRecords = s3Result.aiRecords || [];
            metadata = s3Result.metadata;
            initialFiles = s3Result.initialFiles || {};
            if (!uploadTimestamp && s3Result.uploadTimestamp) {
              uploadTimestamp = s3Result.uploadTimestamp;
              uploadTimeISO = s3Result.uploadTimeISO;
            }
            if (!validityWindow && s3Result.validityWindow) {
              validityWindow = s3Result.validityWindow;
            }
            if (!uploadMetrics && s3Result.uploadMetrics) {
              uploadMetrics = s3Result.uploadMetrics;
            }
          }
        }
      } catch (err: any) {
        return c.json({ error: `Failed to load event log` }, 500);
      }
    }

    const window = await getStudentSessionWindow(sessionCode, studentId, validityWindow ?? undefined);
    const unclamped = c.req.query("unclamped") === "true" || c.req.query("mode") === "full_raw";
    const uniqueCore = deduplicateRecords(coreRecords);
    const uniqueAi = deduplicateRecords(aiRecords);
    const filteredCore = uniqueCore.filter((e) => inSessionWindow(e?.timestamp, window));
    const filteredAi = uniqueAi.filter((e) => inSessionWindow(e?.timestamp, window));
    const stats = {
      totalRawEvents: coreRecords.length,
      inWindowEvents: filteredCore.length,
      duplicateEvents: coreRecords.length - uniqueCore.length,
      preSessionEvents: uniqueCore.filter((e) => window.signinTimestamp && (toMs(e?.timestamp) ?? Infinity) < window.signinTimestamp).length,
      postSessionEvents: uniqueCore.filter((e) => window.expireTimestamp && (toMs(e?.timestamp) ?? 0) > window.expireTimestamp).length,
      unresolvedEvents: window.status === "unresolved" ? uniqueCore.length : uniqueCore.filter((e) => !toMs(e?.timestamp)).length,
    };
    const chronological = (records: any[]) => [...records].sort((a, b) => (toMs(a?.timestamp) ?? 0) - (toMs(b?.timestamp) ?? 0));
    return c.json({
      sessionCode, studentId, activeRecordDir: path.basename(activeRecordDir), availableRecords,
      validityWindow: window,
      rangeApplied: { from: window.signinTimestamp, to: window.expireTimestamp, mode: unclamped ? "full_raw" : "session_validity" },
      stats, uploadTimestamp, uploadTimeISO, metadata, initialFiles,
      coreRecords: chronological(unclamped ? coreRecords : filteredCore),
      aiRecords: chronological(unclamped ? aiRecords : filteredAi),
      loginTimestamp: window.signinTimestamp, sessionEndTime: window.expireTimestamp,
      totalRawEvents: coreRecords.length, clampedEventsCount: filteredCore.length,
      isClamped: !unclamped && (coreRecords.length !== filteredCore.length || aiRecords.length !== filteredAi.length),
    });
}
