import path from "path";
import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { sessions } from "../../services/sessionStore";
import { sanitizeFilename } from "../telemetry/logFiles";
import { appendJsonLines, countNonEmptyLines } from "../telemetry/jsonl";
import { toMs, sliceRecordsByTimeRange } from "./time";

export async function listVisualizeSessionAccounts(c: any) {
  const sessionCode = sanitizeFilename(
    c.req.param("sessionCode"),
  ).toUpperCase();
  const sessionLogDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode,
  );

  const accountMap = new Map<
    string,
    {
      studentId: string;
      hasPromptLog: boolean;
      hasEventLog: boolean;
      promptTurnsCount: number;
      eventCount: number;
      lastActivity: number;
      hasErrors: boolean;
    }
  >();

  const sessionObj = sessions.get(sessionCode);
  let manifest: any = null;
  const manifestPath = path.join(sessionLogDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
    } catch {}
  }
  const sessionCreationMs =
    toMs(sessionObj?.createdAt) ||
    toMs(sessionObj?.startTime) ||
    toMs(manifest?.createdAt) ||
    toMs(manifest?.startTime) ||
    null;
  const durationMin =
    sessionObj?.durationMinutes || manifest?.durationMinutes || 90;
  const scheduledSessionEnd = sessionCreationMs
    ? sessionCreationMs +
      (durationMin === -1 ? 24 * 60 : durationMin) * 60 * 1000
    : null;

  if (fs.existsSync(sessionLogDir)) {
    try {
      const entries = await fs.promises.readdir(sessionLogDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const entryNameLower = entry.name.toLowerCase();
        if (
          entryNameLower.includes("manifest") ||
          entryNameLower.includes("metadata") ||
          entryNameLower.includes("upload_info") ||
          entryNameLower.includes("package") ||
          entryNameLower.startsWith(".") ||
          entryNameLower.endsWith(".tmp") ||
          entryNameLower.endsWith(".bak") ||
          entryNameLower === "__macosx"
        ) {
          continue;
        }

        const entryPath = path.join(sessionLogDir, entry.name);
        const stat = await fs.promises.stat(entryPath);

        if (entry.isFile() && entry.name.endsWith(".json")) {
          const studentId = entry.name.slice(0, -5);
          let turnsCount = 0;
          let hasErrors = false;
          try {
            const raw = await fs.promises.readFile(entryPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              turnsCount = parsed.length;
              hasErrors = parsed.some((t: any) => !!t.error);
            }
          } catch {}

          const acc = accountMap.get(studentId) || {
            studentId,
            hasPromptLog: false,
            hasEventLog: false,
            promptTurnsCount: 0,
            eventCount: 0,
            lastActivity: stat.mtimeMs,
            hasErrors: false,
          };
          acc.hasPromptLog = true;
          acc.promptTurnsCount = turnsCount;
          acc.hasErrors = acc.hasErrors || hasErrors;
          if (stat.mtimeMs > acc.lastActivity) acc.lastActivity = stat.mtimeMs;
          accountMap.set(studentId, acc);
        } else if (entry.isDirectory()) {
          const studentId = entry.name;
          let totalEvents = 0;
          let foundEvents = false;

          // 1. Check upload_info.json (authoritative in-window event metrics)
          let uploadInfoData: any = null;
          const directUploadInfo = path.join(entryPath, "upload_info.json");
          if (fs.existsSync(directUploadInfo)) {
            try {
              uploadInfoData = JSON.parse(
                await fs.promises.readFile(directUploadInfo, "utf-8"),
              );
            } catch {}
          }
          if (!uploadInfoData) {
            const examRecordsDir = path.join(entryPath, "exam_records");
            if (fs.existsSync(examRecordsDir)) {
              try {
                const recs = await fs.promises.readdir(examRecordsDir);
                for (const r of recs.sort().reverse()) {
                  const rUploadInfo = path.join(examRecordsDir, r, "upload_info.json");
                  if (fs.existsSync(rUploadInfo)) {
                    uploadInfoData = JSON.parse(
                      await fs.promises.readFile(rUploadInfo, "utf-8"),
                    );
                    break;
                  }
                }
              } catch {}
            }
          }

          const uploadExpiry = toMs(
            uploadInfoData?.validityWindow?.expireTimestamp,
          );
          const uploadMetricMatchesSchedule =
            !scheduledSessionEnd ||
            !uploadExpiry ||
            uploadExpiry === scheduledSessionEnd;
          if (
            uploadInfoData?.metrics &&
            typeof uploadInfoData.metrics.inWindowEvents === "number" &&
            uploadInfoData.metrics.inWindowEvents > 0 &&
            uploadMetricMatchesSchedule
          ) {
            totalEvents = uploadInfoData.metrics.inWindowEvents;
            foundEvents = true;
          } else {
            // 2. Fallback: parse events.jsonl and slice strictly by session window
            const sessionBeginTime =
              toMs(uploadInfoData?.validityWindow?.signinTimestamp) ||
              sessionCreationMs;
            const sessionEndTime =
              scheduledSessionEnd ||
              toMs(uploadInfoData?.validityWindow?.expireTimestamp);

            const allowedDates = new Set<string>();
            if (sessionBeginTime) {
              allowedDates.add(
                new Date(sessionBeginTime).toISOString().slice(0, 10),
              );
            }
            if (sessionEndTime) {
              allowedDates.add(
                new Date(sessionEndTime).toISOString().slice(0, 10),
              );
            }

            async function findEvents(dir: string) {
              const sub = await fs.promises.readdir(dir, {
                withFileTypes: true,
              });
              for (const s of sub) {
                const full = path.join(dir, s.name);
                if (s.isDirectory()) {
                  await findEvents(full);
                } else if (s.name === "events.jsonl") {
                  foundEvents = true;
                  try {
                    const content = await fs.promises.readFile(full, "utf-8");
                    const recs: any[] = [];
                    appendJsonLines(content, recs);
                    if (recs.length > 0) {
                      if (
                        sessionBeginTime ||
                        sessionEndTime ||
                        allowedDates.size > 0
                      ) {
                        const sliced = sliceRecordsByTimeRange(
                          recs,
                          sessionBeginTime,
                          sessionEndTime,
                          allowedDates,
                        );
                        totalEvents += (sliced.sliced.length > 0 ? sliced.sliced.length : recs.length);
                      } else {
                        totalEvents += recs.length;
                      }
                    }
                  } catch {}
                }
              }
            }
            await findEvents(entryPath);
          }

          const acc = accountMap.get(studentId) || {
            studentId,
            hasPromptLog: false,
            hasEventLog: false,
            promptTurnsCount: 0,
            eventCount: 0,
            lastActivity: stat.mtimeMs,
            hasErrors: false,
          };
          acc.hasEventLog = foundEvents;
          acc.eventCount = totalEvents;
          if (stat.mtimeMs > acc.lastActivity) acc.lastActivity = stat.mtimeMs;
          accountMap.set(studentId, acc);
        }
      }
    } catch {}
  }

  // Include in-memory session students if allowed
  if (sessionObj && sessionObj.allowedStudentIds) {
    for (const sid of sessionObj.allowedStudentIds) {
      if (!accountMap.has(sid)) {
        accountMap.set(sid, {
          studentId: sid,
          hasPromptLog: false,
          hasEventLog: false,
          promptTurnsCount: 0,
          eventCount: 0,
          lastActivity: sessionObj.createdAt || Date.now(),
          hasErrors: false,
        });
      }
    }
  }

  // Include S3 students for this session
  if (s3Storage.isAvailable()) {
    try {
      const s3Students =
        await s3Storage.listStudentsInSessionFromS3(sessionCode);
      await Promise.all(
        s3Students.map(async (s) => {
          let s3EventCount: number | null = null;
          if (s.hasEventLog) {
            try {
              const uRaw = await s3Storage.getStudentFile(
                sessionCode,
                s.studentId,
                "upload_info.json",
              );
              if (typeof uRaw === "string") {
                const uInfo = JSON.parse(uRaw);
                if (
                  uInfo?.metrics &&
                  typeof uInfo.metrics.inWindowEvents === "number" &&
                  uInfo.metrics.inWindowEvents > 0
                ) {
                  s3EventCount = uInfo.metrics.inWindowEvents;
                }
              }
              if (s3EventCount === null || s3EventCount === 0) {
                const s3Records = await s3Storage.listStudentExamRecords(
                  sessionCode,
                  s.studentId,
                );
                if (s3Records && s3Records.length > 0) {
                  for (const targetRec of s3Records) {
                    const recURaw = await s3Storage.getExamRecordArtifact(
                      sessionCode,
                      s.studentId,
                      targetRec,
                      "upload_info.json",
                    );
                    if (typeof recURaw === "string") {
                      try {
                        const recInfo = JSON.parse(recURaw);
                        if (
                          recInfo?.metrics &&
                          typeof recInfo.metrics.inWindowEvents === "number" &&
                          recInfo.metrics.inWindowEvents > 0
                        ) {
                          s3EventCount = (s3EventCount || 0) + recInfo.metrics.inWindowEvents;
                          break;
                        }
                      } catch {}
                    }
                  }
                  if (s3EventCount === null || s3EventCount === 0) {
                    for (const targetRec of s3Records) {
                      const evRaw = await s3Storage.getExamRecordArtifact(
                        sessionCode,
                        s.studentId,
                        targetRec,
                        "events.jsonl",
                      );
                      if (typeof evRaw === "string") {
                        const cnt = countNonEmptyLines(evRaw);
                        if (cnt > 0) {
                          s3EventCount = (s3EventCount || 0) + cnt;
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          }

          const existing = accountMap.get(s.studentId);
          if (!existing) {
            accountMap.set(s.studentId, {
              studentId: s.studentId,
              hasPromptLog: s.hasPromptLog,
              hasEventLog: s.hasEventLog,
              promptTurnsCount: s.hasPromptLog ? 1 : 0,
              eventCount:
                s3EventCount !== null ? s3EventCount : s.hasEventLog ? 1 : 0,
              lastActivity: s.lastActivity || Date.now(),
              hasErrors: false,
            });
          } else {
            existing.hasPromptLog = existing.hasPromptLog || s.hasPromptLog;
            existing.hasEventLog = existing.hasEventLog || s.hasEventLog;
            if (s3EventCount !== null && s3EventCount > 0) {
              existing.eventCount = s3EventCount;
            }
            if (s.lastActivity && s.lastActivity > existing.lastActivity) {
              existing.lastActivity = s.lastActivity;
            }
          }
        }),
      );
    } catch (err) {
      console.error("[Visualize] S3 students listing error:", err);
    }
  }

  const accounts = Array.from(accountMap.values()).filter((a) => {
    const sid = (a.studentId || "").toLowerCase();
    return (
      !sid.includes("manifest") &&
      !sid.includes("metadata") &&
      !sid.includes("package") &&
      !sid.startsWith(".") &&
      sid !== "__macosx"
    );
  });
  accounts.sort((a, b) => {
    const aHas = a.hasPromptLog || a.hasEventLog ? 1 : 0;
    const bHas = b.hasPromptLog || b.hasEventLog ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.lastActivity - a.lastActivity;
  });

  return c.json({ sessionCode, accounts });
}
