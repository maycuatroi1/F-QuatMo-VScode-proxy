import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import { redis } from "../../services/redis";
import { sessions, sessionStates } from "../../services/sessionStore";
import { s3Storage } from "../../services/s3Storage";
import { readZipTextEntriesSafely } from "../../services/security";
import { appendJsonLines, hasNonEmptyLine } from "../telemetry/jsonl";
import { sanitizeFilename } from "../telemetry/logFiles";
import { toMs, sliceRecordsByTimeRange } from "./time";
import { loadEventLogFromS3 } from "./s3EventLog";

export async function getVisualizeStudentEventLog(c: any) {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId"));
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
        if (fs.existsSync(examRecordsDir)) {
          const recEntries = await fs.promises.readdir(examRecordsDir, {
            withFileTypes: true,
          });
          for (const r of recEntries) {
            if (r.isDirectory()) {
              availableRecords.push(r.name);
            }
          }
          if (availableRecords.length > 0) {
            const reqRecordId = c.req.query("recordId");
            if (availableRecords.length > 1 && (!reqRecordId || reqRecordId === "all_merged")) {
              const allCore: any[] = [];
              const allAi: any[] = [];
              let mergedInitialFiles: Record<string, string> = {};
              let mergedMetadata: any = null;

              for (const rId of availableRecords) {
                const rDir = path.join(examRecordsDir, rId);
                const evPath = path.join(rDir, "events.jsonl");
                const aiPath = path.join(rDir, "ai_interactions.jsonl");
                const metaPath = path.join(rDir, "metadata.json");
                const snapPath = path.join(rDir, "snapshot_start.zip");

                if (fs.existsSync(metaPath) && !mergedMetadata) {
                  try {
                    mergedMetadata = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
                  } catch {}
                }
                if (fs.existsSync(snapPath) && Object.keys(mergedInitialFiles).length === 0) {
                  try {
                    const zip = new AdmZip(snapPath);
                    Object.assign(mergedInitialFiles, readZipTextEntriesSafely(zip));
                  } catch {}
                }
                if (fs.existsSync(evPath)) {
                  try {
                    const content = await fs.promises.readFile(evPath, "utf-8");
                    appendJsonLines(content, allCore);
                  } catch {}
                }
                if (fs.existsSync(aiPath)) {
                  try {
                    const content = await fs.promises.readFile(aiPath, "utf-8");
                    appendJsonLines(content, allAi);
                  } catch {}
                }
              }

              const seenCore = new Set<string>();
              coreRecords = allCore
                .filter((e) => {
                  const k = String(e.timestamp) + "_" + String(e.type);
                  if (seenCore.has(k)) return false;
                  seenCore.add(k);
                  return true;
                })
                .sort(
                  (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0),
                );

              const seenAi = new Set<string>();
              aiRecords = allAi
                .filter((e) => {
                  const k = String(e.timestamp) + "_" + String(e.type);
                  if (seenAi.has(k)) return false;
                  seenAi.add(k);
                  return true;
                })
                .sort(
                  (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0),
                );

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

              const eventsPath = path.join(activeRecordDir, "events.jsonl");
              const aiPath = path.join(activeRecordDir, "ai_interactions.jsonl");
              const metadataPath = path.join(activeRecordDir, "metadata.json");
              const snapshotZipPath = path.join(
                activeRecordDir,
                "snapshot_start.zip",
              );

              if (fs.existsSync(metadataPath)) {
                try {
                  const raw = await fs.promises.readFile(metadataPath, "utf-8");
                  metadata = JSON.parse(raw);
                } catch {}
              }

              if (fs.existsSync(eventsPath)) {
                try {
                  const content = await fs.promises.readFile(eventsPath, "utf-8");
                  appendJsonLines(content, coreRecords);
                } catch {}
              }

              if (fs.existsSync(aiPath)) {
                try {
                  const content = await fs.promises.readFile(aiPath, "utf-8");
                  appendJsonLines(content, aiRecords);
                } catch {}
              }

              if (fs.existsSync(snapshotZipPath)) {
                try {
                  const zip = new AdmZip(snapshotZipPath);
                  Object.assign(initialFiles, readZipTextEntriesSafely(zip));
                } catch {}
              }
            }
          }
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

    try {
      const session = sessions.get(sessionCode);
      const stateKey = `${sessionCode}:${studentId}`;
      const state = sessionStates.get(stateKey);

      let manifest: any = null;
      const manifestPath = path.resolve(
        process.cwd(),
        "logs",
        "sessions",
        sessionCode,
        "session_manifest.json",
      );
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(
            await fs.promises.readFile(manifestPath, "utf-8"),
          );
        } catch {}
      }

      // 1. Resolve Authoritative Session Boundaries [T_signin, T_expire + grace]
      let sessionBeginTime: number | null =
        toMs(validityWindow?.signinTimestamp) || null;

      if (
        !sessionBeginTime &&
        state?.loginTimestamp &&
        state.loginTimestamp > 0
      ) {
        sessionBeginTime = toMs(state.loginTimestamp);
      }
      if (!sessionBeginTime && redis && redis.status === "ready") {
        try {
          const rTime = await redis.hget(
            `session:user:${sessionCode}:${studentId}`,
            "loginTime",
          );
          if (rTime) {
            const parsed = parseInt(rTime, 10);
            if (!isNaN(parsed) && parsed > 0) sessionBeginTime = toMs(parsed);
          }
        } catch {}
      }
      if (!sessionBeginTime && manifest) {
        if (Array.isArray(manifest.students)) {
          const st = manifest.students.find(
            (s: any) => s.studentId?.toUpperCase() === studentId.toUpperCase(),
          );
          if (st?.loginTimestamp && st.loginTimestamp > 0) {
            sessionBeginTime = toMs(st.loginTimestamp);
          }
        }
      }
      if (
        !sessionBeginTime &&
        (session?.startTime ||
          session?.createdAt ||
          manifest?.createdAt ||
          manifest?.startTime)
      ) {
        sessionBeginTime =
          toMs(session?.startTime) ||
          toMs(session?.createdAt) ||
          toMs(manifest?.createdAt) ||
          toMs(manifest?.startTime);
      }

      if (!sessionBeginTime) {
        try {
          const studentJsonPath = path.resolve(
            process.cwd(),
            "logs",
            "sessions",
            sessionCode,
            `${studentId}.json`,
          );
          if (fs.existsSync(studentJsonPath)) {
            const pTurns = JSON.parse(
              await fs.promises.readFile(studentJsonPath, "utf-8"),
            );
            if (
              Array.isArray(pTurns) &&
              pTurns.length > 0 &&
              pTurns[0].timestamp
            ) {
              const firstTurnMs = new Date(pTurns[0].timestamp).getTime();
              if (!isNaN(firstTurnMs) && firstTurnMs > 0) {
                sessionBeginTime = firstTurnMs - 10 * 60 * 1000;
              }
            }
          }
        } catch {}
      }

      const durationMin =
        session?.durationMinutes ||
        manifest?.durationMinutes ||
        validityWindow?.durationMinutes ||
        90;

      if (!sessionBeginTime && uploadTimestamp) {
        sessionBeginTime = uploadTimestamp - durationMin * 60 * 1000;
      } else if (!sessionBeginTime) {
        const metaStart = toMs(metadata?.examStartAt);
        if (metaStart) sessionBeginTime = metaStart;
      }

      // 2. Resolve Authoritative Session Expiration Boundary
      let sessionEndTime: number | null =
        toMs(validityWindow?.expireTimestamp) || null;

      if (
        !sessionEndTime &&
        uploadTimestamp &&
        sessionBeginTime &&
        uploadTimestamp >= sessionBeginTime
      ) {
        if (
          !sessionEndTime ||
          durationMin >= 180 ||
          uploadTimestamp < sessionEndTime
        ) {
          sessionEndTime = uploadTimestamp;
        }
      }

      if (!sessionEndTime && metadata?.examEndAt) {
        const metaEnd = toMs(metadata.examEndAt);
        if (metaEnd && sessionBeginTime && metaEnd >= sessionBeginTime) {
          if (
            !sessionEndTime ||
            durationMin >= 180 ||
            metaEnd < sessionEndTime
          ) {
            sessionEndTime = metaEnd;
          }
        }
      }

      if (!sessionEndTime) {
        if (session?.endedAt && session.endedAt > 0) {
          sessionEndTime = toMs(session.endedAt);
        } else if (manifest?.endedAt && manifest.endedAt > 0) {
          sessionEndTime = toMs(manifest.endedAt);
        } else if (sessionBeginTime) {
          sessionEndTime =
            sessionBeginTime + Math.min(durationMin, 180) * 60 * 1000;
        }
      }

      const graceMs = 60 * 1000; // 60s network/flush tolerance buffer
      const effectiveUpperBound = sessionEndTime
        ? sessionEndTime + graceMs
        : null;

      // 3. Session Calendar Date Isolation
      const sessionCreationMs =
        toMs(session?.createdAt) ||
        toMs(session?.startTime) ||
        toMs(manifest?.createdAt) ||
        toMs(manifest?.startTime) ||
        sessionBeginTime;

      const allowedDates = new Set<string>();
      if (sessionBeginTime) {
        allowedDates.add(new Date(sessionBeginTime).toISOString().slice(0, 10));
        if (sessionEndTime) {
          allowedDates.add(new Date(sessionEndTime).toISOString().slice(0, 10));
        }
      } else if (sessionCreationMs) {
        allowedDates.add(
          new Date(sessionCreationMs).toISOString().slice(0, 10),
        );
        allowedDates.add(
          new Date(sessionCreationMs + durationMin * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        );
      } else if (uploadTimeISO) {
        allowedDates.add(uploadTimeISO.slice(0, 10));
      }

      const unclamped =
        c.req.query("unclamped") === "true" ||
        c.req.query("mode") === "full_raw";

      let clampedCoreRecords = coreRecords;
      let clampedAiRecords = aiRecords;
      let coreStats = {
        totalRaw: coreRecords.length,
        preCount: 0,
        postCount: 0,
        outsideDateCount: 0,
      };
      let aiStats = {
        totalRaw: aiRecords.length,
        preCount: 0,
        postCount: 0,
        outsideDateCount: 0,
      };

      // 4. O(log N) High-Performance Binary Search Slicing
      if (
        !unclamped &&
        (sessionBeginTime !== null ||
          effectiveUpperBound !== null ||
          allowedDates.size > 0)
      ) {
        const coreRes = sliceRecordsByTimeRange(
          coreRecords,
          sessionBeginTime,
          effectiveUpperBound,
          allowedDates,
        );
        clampedCoreRecords = coreRes.sliced;
        coreStats = coreRes;

        const aiRes = sliceRecordsByTimeRange(
          aiRecords,
          sessionBeginTime,
          effectiveUpperBound,
          allowedDates,
        );
        clampedAiRecords = aiRes.sliced;
        aiStats = aiRes;

        // Fail-safe: If clamping dropped 100% of events because student worked in anonymous session before sign-in:
        if (clampedCoreRecords.length === 0 && coreRecords.length > 0) {
          const sessionDayEvents = coreRecords.filter((e) => {
            const t = toMs(e.timestamp);
            if (!t) return false;
            if (allowedDates.size > 0) {
              const dStr = new Date(t).toISOString().slice(0, 10);
              if (allowedDates.has(dStr)) return true;
            }
            if (
              sessionBeginTime &&
              Math.abs(t - sessionBeginTime) <= 4 * 3600 * 1000
            ) {
              return true;
            }
            return false;
          });
          if (sessionDayEvents.length > 0) {
            clampedCoreRecords = sessionDayEvents;
            coreStats.totalRaw = coreRecords.length;
          }
        }

        if (clampedAiRecords.length === 0 && aiRecords.length > 0) {
          const sessionDayAi = aiRecords.filter((e) => {
            const t = toMs(e.timestamp);
            if (!t) return false;
            if (allowedDates.size > 0) {
              const dStr = new Date(t).toISOString().slice(0, 10);
              if (allowedDates.has(dStr)) return true;
            }
            if (
              sessionBeginTime &&
              Math.abs(t - sessionBeginTime) <= 4 * 3600 * 1000
            ) {
              return true;
            }
            return false;
          });
          if (sessionDayAi.length > 0) {
            clampedAiRecords = sessionDayAi;
            aiStats.totalRaw = aiRecords.length;
          }
        }
      }

      return c.json({
        sessionCode,
        studentId,
        activeRecordDir: path.basename(activeRecordDir),
        availableRecords,
        validityWindow: {
          signinTimestamp: sessionBeginTime,
          expireTimestamp: sessionEndTime,
          signinISO: sessionBeginTime
            ? new Date(sessionBeginTime).toISOString()
            : null,
          expireISO: sessionEndTime
            ? new Date(sessionEndTime).toISOString()
            : null,
          durationMinutes: durationMin,
          graceSeconds: 60,
        },
        rangeApplied: {
          from: sessionBeginTime,
          to: effectiveUpperBound,
          mode: unclamped ? "full_raw" : "session_validity",
        },
        stats: {
          totalRawEvents: coreRecords.length,
          inWindowEvents: clampedCoreRecords.length,
          preSessionEvents: coreStats.preCount,
          postSessionEvents: coreStats.postCount,
          outsideDateEvents: coreStats.outsideDateCount,
        },
        uploadTimestamp: sessionEndTime,
        metadata: {
          ...(metadata || {}),
          examSessionId: metadata?.examSessionId || path.basename(activeRecordDir),
          examStartAt: sessionBeginTime || clampedCoreRecords[0]?.timestamp || Date.now(),
          examEndAt: sessionEndTime || clampedCoreRecords[clampedCoreRecords.length - 1]?.timestamp || Date.now(),
        },
        coreRecords: clampedCoreRecords,
        aiRecords: clampedAiRecords,
        initialFiles,
        loginTimestamp: sessionBeginTime,
        sessionEndTime,
        totalRawEvents: coreRecords.length,
        clampedEventsCount: clampedCoreRecords.length,
        isClamped:
          !unclamped &&
          (coreRecords.length !== clampedCoreRecords.length ||
            aiRecords.length !== clampedAiRecords.length),
      });
    } catch (err: any) {
      return c.json({ error: `Failed to load event log` }, 500);
    }
  }
