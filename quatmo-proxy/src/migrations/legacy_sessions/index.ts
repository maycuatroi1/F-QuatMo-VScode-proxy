import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { sessions, sessionStates, Session, StudentSessionState } from "../../services/sessionStore";
import { redis } from "../../services/redis";
import { s3Storage } from "../../services/s3Storage";
import { SESSIONS_META } from "./session_metadata";

const CHECKPOINT_FILE = path.resolve(process.cwd(), "logs", ".migrated_legacy_sessions_v2");

// Helper for safe timeout on async operations
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
  let timer: any;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
      }),
    ]);
  } catch (err: any) {
    console.warn(`[LegacyMigration] ${err?.message || err}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runLegacySessionMigration(): Promise<void> {
  // 1. Checkpoint verification
  if (fs.existsSync(CHECKPOINT_FILE)) {
    console.log("[LegacyMigration] Sessions SS-6X47 and SS-QLHK already migrated (checkpoint found). Skipping.");
    return;
  }

  const startTime = Date.now();
  console.log("================================================================================");
  console.log("[LegacyMigration] Starting authoritative migration for legacy sessions SS-6X47 & SS-QLHK...");
  console.log("================================================================================");

  const logsSessionsDir = path.resolve(process.cwd(), "logs", "sessions");
  await fs.promises.mkdir(logsSessionsDir, { recursive: true });

  const sessionCodes = Object.keys(SESSIONS_META);

  for (const sessionCode of sessionCodes) {
    const meta = SESSIONS_META[sessionCode];
    if (!meta) continue;

    console.log(`\n[LegacyMigration] ==================== Session: ${sessionCode} (${meta.students.length} accounts) ====================`);

    const sessionTargetDir = path.join(logsSessionsDir, sessionCode);
    await fs.promises.mkdir(sessionTargetDir, { recursive: true });

    // 2. Unpack bundle
    const bundlePath = path.resolve(__dirname, "bundles", `bundle_${sessionCode}.zip`);
    let zip: AdmZip | null = null;
    if (fs.existsSync(bundlePath)) {
      try {
        zip = new AdmZip(bundlePath);
      } catch (err) {
        console.error(`[LegacyMigration] Failed to open bundle ${bundlePath}:`, err);
      }
    } else {
      console.warn(`[LegacyMigration] Bundle not found at ${bundlePath}`);
    }

    // 3. Update SQLite Sessions Table & In-Memory Map
    const studentIds = meta.students.map((s) => s.studentId);
    let sessionObj = sessions.get(sessionCode);
    if (!sessionObj) {
      const newSession: Session = {
        sessionCode,
        startTime: meta.createdAt,
        durationMinutes: meta.durationMinutes || 120,
        aiOption: "agent",
        aiValidityMinutes: 120,
        defaultTokenBudget: 150000,
        allowedStudentIds: new Set(studentIds),
        assignedGroups: [],
        sessionType: "basic",
        sessionPrompt: "",
        promptMode: "scaffolded_code",
        examQuestions: [],
        createdAt: meta.createdAt,
        createdBy: "admin",
        updatedAt: Date.now(),
        updatedBy: "legacy_migration",
      };
      sessionObj = newSession;
      sessions.set(sessionCode, newSession);
    } else {
      sessionObj.durationMinutes = meta.durationMinutes || 120;
      sessionObj.promptMode = sessionObj.promptMode || "scaffolded_code";
      const currentAllowed = new Set(sessionObj.allowedStudentIds);
      studentIds.forEach((id) => currentAllowed.add(id));
      sessionObj.allowedStudentIds = currentAllowed;
      sessionObj.updatedAt = Date.now();
      sessionObj.updatedBy = "legacy_migration";
      sessions.set(sessionCode, sessionObj);
    }

    // 4. Process each student: Disk, SQLite, Redis, S3
    const manifestStudents: any[] = [];

    // Parallelize processing in batches of 5 to maximize throughput
    const batchSize = 5;
    for (let i = 0; i < meta.students.length; i += batchSize) {
      const batch = meta.students.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (student) => {
          const {
            studentId,
            hasLoggedIn,
            trueSignin,
            trueExpire,
            tokensConsumed,
            latestClassification,
            inWindowEvents,
            preSessionFiltered,
            postSessionFiltered,
            uploadIp,
          } = student;

          const studentTargetDir = path.join(sessionTargetDir, studentId);
          await fs.promises.mkdir(studentTargetDir, { recursive: true });

          // 4a. Prompt turns file
          let promptTurns: any[] = [];
          const promptTurnFileInZip = zip?.getEntry(`${studentId}.json`);
          if (promptTurnFileInZip) {
            try {
              const raw = promptTurnFileInZip.getData().toString("utf-8");
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) promptTurns = parsed;
            } catch {}
          }

          // Write prompt turns to local disk
          const localPromptPath = path.join(sessionTargetDir, `${studentId}.json`);
          if (promptTurns.length > 0) {
            await fs.promises.writeFile(localPromptPath, JSON.stringify(promptTurns, null, 2), "utf-8");
          }

          // 4b. Base upload_info
          let existingUploadInfo: any = {};
          const uploadInfoEntry = zip?.getEntry(`${studentId}/upload_info.json`);
          if (uploadInfoEntry) {
            try {
              existingUploadInfo = JSON.parse(uploadInfoEntry.getData().toString("utf-8"));
            } catch {}
          }

          const authoritativeUploadInfo = {
            ...existingUploadInfo,
            studentId,
            sessionCode,
            uploadTimestamp: trueSignin,
            uploadTimeISO: new Date(trueSignin).toISOString(),
            uploadIp: uploadIp || existingUploadInfo.uploadIp || existingUploadInfo.ip || "127.0.0.1",
            validityWindow: {
              signinTimestamp: trueSignin,
              expireTimestamp: trueExpire,
              durationMinutes: meta.durationMinutes,
              inWindowEvents,
              preSessionFiltered,
              postSessionFiltered,
            },
            metrics: {
              inWindowEvents,
              preSessionFiltered,
              postSessionFiltered,
            },
          };

          // Write upload_info.json to local disk
          const localUploadInfoPath = path.join(studentTargetDir, "upload_info.json");
          await fs.promises.writeFile(
            localUploadInfoPath,
            JSON.stringify(authoritativeUploadInfo, null, 2),
            "utf-8",
          );

          // 4c. Update SQLite session_states & In-Memory Map
          const stateKey = `${sessionCode}:${studentId}`;
          const currentState = sessionStates.get(stateKey);
          const studentState: StudentSessionState = {
            sessionCode,
            studentId,
            hasLoggedIn,
            loginTimestamp: trueSignin,
            tokensConsumed,
            reassigned: currentState?.reassigned ?? false,
            latestClassification: latestClassification || currentState?.latestClassification || "none",
            promptCount: student.promptCount,
          };
          sessionStates.set(stateKey, studentState);

          // 4d. Update Redis cache ONLY IF ready (with strict timeout)
          if (redis && redis.status === "ready") {
            try {
              const redisKey = `session:user:${sessionCode}:${studentId}`;
              await withTimeout(
                redis.hset(redisKey, {
                  budget: String(sessionObj?.defaultTokenBudget || 150000),
                  consumed: String(tokensConsumed),
                  loginTime: String(trueSignin),
                  hasLoggedIn: hasLoggedIn ? "true" : "false",
                }),
                1500,
                `Redis HSET ${redisKey}`,
              );
            } catch (rErr) {
              console.warn(`[LegacyMigration] Redis update warning for ${stateKey}:`, rErr);
            }
          }

          // 4e. Synchronize S3 Storage if configured
          if (s3Storage.isAvailable()) {
            try {
              // Upload prompt_turns.json
              if (promptTurns.length > 0) {
                await withTimeout(
                  s3Storage.uploadStudentPromptLog(sessionCode, studentId, promptTurns),
                  4000,
                  `S3 prompt turns ${sessionCode}/${studentId}`,
                );
              }

              // Upload student upload_info.json
              await withTimeout(
                s3Storage.uploadStudentFile(
                  sessionCode,
                  studentId,
                  "upload_info.json",
                  JSON.stringify(authoritativeUploadInfo, null, 2),
                  "application/json",
                ),
                4000,
                `S3 upload_info ${sessionCode}/${studentId}`,
              );

              // If exam records exist on S3, update upload_info.json in each record directory
              const s3Records = await withTimeout(
                s3Storage.listStudentExamRecords(sessionCode, studentId),
                4000,
                `S3 listStudentExamRecords ${sessionCode}/${studentId}`,
              );
              if (Array.isArray(s3Records) && s3Records.length > 0) {
                for (const recId of s3Records) {
                  await withTimeout(
                    s3Storage.uploadExamRecordFile(
                      sessionCode,
                      studentId,
                      recId,
                      "upload_info.json",
                      JSON.stringify(authoritativeUploadInfo, null, 2),
                      "application/json",
                    ),
                    4000,
                    `S3 uploadExamRecordFile ${sessionCode}/${studentId}/${recId}`,
                  );
                }
              }
            } catch (s3Err) {
              console.warn(`[LegacyMigration] S3 sync warning for ${stateKey}:`, s3Err);
            }
          }

          manifestStudents.push({
            studentId,
            hasLoggedIn,
            loginTimestamp: trueSignin,
            tokensConsumed,
            latestClassification,
            promptCount: student.promptCount,
            validityWindow: {
              signinTimestamp: trueSignin,
              expireTimestamp: trueExpire,
              durationMinutes: meta.durationMinutes,
              inWindowEvents,
              preSessionFiltered,
              postSessionFiltered,
            },
          });

          console.log(`[LegacyMigration]   [OK] ${sessionCode}/${studentId} -> joined: ${hasLoggedIn}, signin: ${new Date(trueSignin).toISOString().slice(11, 19)}, tokens: ${tokensConsumed}, inWindowEvents: ${inWindowEvents}`);
        }),
      );
    }

    // 5. Update session_manifest.json on Local Disk and S3
    const manifestObj = {
      sessionCode,
      createdAt: meta.createdAt,
      examDateStr: meta.examDateStr,
      durationMinutes: meta.durationMinutes,
      exportedAt: Date.now(),
      students: manifestStudents,
    };

    const localManifestPath = path.join(sessionTargetDir, "session_manifest.json");
    await fs.promises.writeFile(
      localManifestPath,
      JSON.stringify(manifestObj, null, 2),
      "utf-8",
    );

    if (s3Storage.isAvailable()) {
      try {
        await withTimeout(
          s3Storage.uploadSessionManifest(
            sessionCode,
            JSON.stringify(manifestObj, null, 2),
          ),
          5000,
          `S3 uploadSessionManifest ${sessionCode}`,
        );
      } catch (s3ManErr) {
        console.warn(`[LegacyMigration] S3 session_manifest upload warning for ${sessionCode}:`, s3ManErr);
      }
    }

    console.log(`[LegacyMigration] Session ${sessionCode} manifest generated & uploaded (${manifestStudents.length} students).`);
  }

  // 6. Write Checkpoint
  try {
    await fs.promises.writeFile(
      CHECKPOINT_FILE,
      JSON.stringify(
        {
          migratedAt: new Date().toISOString(),
          version: "v2",
          sessions: sessionCodes,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`[LegacyMigration] Checkpoint created at ${CHECKPOINT_FILE}`);
  } catch (cpErr) {
    console.warn("[LegacyMigration] Failed to create checkpoint file:", cpErr);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("================================================================================");
  console.log(`[LegacyMigration] Legacy migration completed successfully in ${durationSec}s!`);
  console.log("================================================================================");
}
