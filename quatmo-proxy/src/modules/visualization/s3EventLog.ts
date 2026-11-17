import AdmZip from "adm-zip";
import { s3Storage } from "../../services/s3Storage";
import { readZipTextEntriesSafely } from "../../services/security";
import { appendJsonLines } from "../telemetry/jsonl";

export async function loadEventLogFromS3(
  sessionCode: string,
  studentId: string,
  reqRecordId?: string,
) {
  if (!s3Storage.isAvailable()) return null;
  try {
    const s3Records = await s3Storage.listStudentExamRecords(
      sessionCode,
      studentId,
    );
    if (!s3Records || s3Records.length === 0) return null;
    const targetRecordId =
      reqRecordId && s3Records.includes(reqRecordId)
        ? reqRecordId
        : s3Records[0];

    const [eventsRaw, aiRaw, metaRaw, zipBuffer, uploadInfoRaw] =
      await Promise.all([
        s3Storage.getExamRecordArtifact(
          sessionCode,
          studentId,
          targetRecordId,
          "events.jsonl",
        ),
        s3Storage.getExamRecordArtifact(
          sessionCode,
          studentId,
          targetRecordId,
          "ai_interactions.jsonl",
        ),
        s3Storage.getExamRecordArtifact(
          sessionCode,
          studentId,
          targetRecordId,
          "metadata.json",
        ),
        s3Storage.getExamRecordArtifact(
          sessionCode,
          studentId,
          targetRecordId,
          "snapshot_start.zip",
        ),
        s3Storage.getStudentFile(sessionCode, studentId, "upload_info.json"),
      ]);

    let uploadTimestamp: number | null = null;
    let uploadTimeISO: string | null = null;
    let validityWindow: any = null;
    let uploadMetrics: any = null;
    if (typeof uploadInfoRaw === "string") {
      try {
        const u = JSON.parse(uploadInfoRaw);
        if (u.uploadTimestamp) {
          const raw = Number(u.uploadTimestamp);
          uploadTimestamp = raw < 1e11 ? raw * 1000 : raw;
        }
        if (u.uploadTimeISO) uploadTimeISO = u.uploadTimeISO;
        if (u.validityWindow) validityWindow = u.validityWindow;
        if (u.metrics) uploadMetrics = u.metrics;
      } catch {}
    }

    // Auto-synthesize unified all_merged record when multiple S3 records exist
    if (s3Records.length > 1 && (!reqRecordId || reqRecordId === "all_merged")) {
      const allCore: any[] = [];
      const allAi: any[] = [];
      let mergedInitialFiles: Record<string, string> = {};
      let mergedMetadata: any = null;

      for (const rId of s3Records) {
        const [evRaw, aRaw, mRaw, zBuf] = await Promise.all([
          s3Storage.getExamRecordArtifact(sessionCode, studentId, rId, "events.jsonl"),
          s3Storage.getExamRecordArtifact(sessionCode, studentId, rId, "ai_interactions.jsonl"),
          s3Storage.getExamRecordArtifact(sessionCode, studentId, rId, "metadata.json"),
          s3Storage.getExamRecordArtifact(sessionCode, studentId, rId, "snapshot_start.zip"),
        ]);
        if (typeof mRaw === "string" && !mergedMetadata) {
          try {
            mergedMetadata = JSON.parse(mRaw);
          } catch {}
        }
        if (Buffer.isBuffer(zBuf) && Object.keys(mergedInitialFiles).length === 0) {
          try {
            const zip = new AdmZip(zBuf);
            Object.assign(mergedInitialFiles, readZipTextEntriesSafely(zip));
          } catch {}
        }
        if (typeof evRaw === "string") appendJsonLines(evRaw, allCore);
        if (typeof aRaw === "string") appendJsonLines(aRaw, allAi);
      }

      const seenCore = new Set<string>();
      const dedupedCore = allCore
        .filter((e) => {
          const k = String(e.timestamp) + "_" + String(e.type);
          if (seenCore.has(k)) return false;
          seenCore.add(k);
          return true;
        })
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

      const seenAi = new Set<string>();
      const dedupedAi = allAi
        .filter((e) => {
          const k = String(e.timestamp) + "_" + String(e.type);
          if (seenAi.has(k)) return false;
          seenAi.add(k);
          return true;
        })
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

      return {
        sessionCode,
        studentId,
        activeRecordDir: "all_merged",
        availableRecords: ["all_merged", ...s3Records],
        metadata: mergedMetadata || {
          examSessionId: "all_merged",
          examStartAt: dedupedCore[0]?.timestamp || Date.now(),
          examEndAt:
            dedupedCore[dedupedCore.length - 1]?.timestamp || Date.now(),
        },
        coreRecords: dedupedCore,
        aiRecords: dedupedAi,
        initialFiles: mergedInitialFiles,
        uploadTimestamp,
        uploadTimeISO,
        validityWindow,
        uploadMetrics,
      };
    }

    const coreRecords: any[] = [];
    const aiRecords: any[] = [];
    let metadata: any = null;
    const initialFiles: Record<string, string> = {};

    if (typeof metaRaw === "string") {
      try {
        metadata = JSON.parse(metaRaw);
      } catch {}
    }
    if (typeof eventsRaw === "string") appendJsonLines(eventsRaw, coreRecords);
    if (typeof aiRaw === "string") appendJsonLines(aiRaw, aiRecords);
    if (Buffer.isBuffer(zipBuffer)) {
      try {
        const zip = new AdmZip(zipBuffer);
        Object.assign(initialFiles, readZipTextEntriesSafely(zip));
      } catch {}
    }

    // If default record produced 0 core events, search other S3 records
    if (!reqRecordId && s3Records.length > 1 && coreRecords.length === 0) {
      for (const altRecId of s3Records) {
        if (altRecId === targetRecordId) continue;
        const altEventsRaw = await s3Storage.getExamRecordArtifact(
          sessionCode,
          studentId,
          altRecId,
          "events.jsonl",
        );
        if (typeof altEventsRaw === "string" && altEventsRaw.trim().length > 0) {
          return loadEventLogFromS3(sessionCode, studentId, altRecId);
        }
      }
    }

    return {
      sessionCode,
      studentId,
      activeRecordDir: targetRecordId,
      availableRecords: s3Records,
      metadata: metadata || {
        examSessionId: targetRecordId,
        examStartAt: coreRecords[0]?.timestamp || Date.now(),
        examEndAt: coreRecords[coreRecords.length - 1]?.timestamp || Date.now(),
      },
      coreRecords,
      aiRecords,
      initialFiles,
      uploadTimestamp,
      uploadTimeISO,
      validityWindow,
      uploadMetrics,
    };
  } catch (err: any) {
    console.error("[Visualize] S3 event log fetch error:", err);
    return null;
  }
}
