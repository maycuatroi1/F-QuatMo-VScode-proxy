import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { sessions, sessionStates, Session, StudentSessionState } from "../../services/sessionStore";
import { redis } from "../../services/redis";
import { s3Storage } from "../../services/s3Storage";
import { SESSIONS_META } from "./session_metadata";

const CHECKPOINT_FILE = path.resolve(process.cwd(), "logs", ".migrated_legacy_sessions_v2");

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

    // 2. Unpack bundle completely into local session directory
    const bundlePath = path.resolve(__dirname, "bundles", `bundle_${sessionCode}.zip`);
    if (fs.existsSync(bundlePath)) {
      try {
        const zip = new AdmZip(bundlePath);
        zip.extractAllTo(sessionTargetDir, true);
        console.log(`[LegacyMigration] Unpacked archive into ${sessionTargetDir}`);
      } catch (err) {
        console.error(`[LegacyMigration] Failed to unpack bundle ${bundlePath}:`, err);
      }
    } else {
      console.warn(`[LegacyMigration] Bundle not found at ${bundlePath}`);
    }

    // 2b. Clean up post-session ghost record for SS-6X47 / HE172034 (anonymous_1792028643935 from Oct 15)
    if (sessionCode === "SS-6X47") {
      const ghostRecordDir = path.join(sessionTargetDir, "HE172034", "exam_records", "anonymous_1792028643935");
      if (fs.existsSync(ghostRecordDir)) {
        try {
          await fs.promises.rm(ghostRecordDir, { recursive: true, force: true });
          console.log("[LegacyMigration] Cleaned up post-session ghost record anonymous_1792028643935 for HE172034");
        } catch {}
      }
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
          const localPromptPath = path.join(sessionTargetDir, `${studentId}.json`);
          let promptTurns: any[] = [];
          if (fs.existsSync(localPromptPath)) {
            try {
              const raw = await fs.promises.readFile(localPromptPath, "utf-8");
              promptTurns = JSON.parse(raw);
            } catch {}
          }

          // 4b. Authoritative upload_info.json (uploadTimestamp MUST BE trueExpire to prevent premature clamping)
          let existingUploadInfo: any = {};
          const localUploadInfoPath = path.join(studentTargetDir, "upload_info.json");
          if (fs.existsSync(localUploadInfoPath)) {
            try {
              existingUploadInfo = JSON.parse(await fs.promises.readFile(localUploadInfoPath, "utf-8"));
            } catch {}
          }

          const authoritativeUploadInfo = {
            ...existingUploadInfo,
            studentId,
            sessionCode,
            uploadTimestamp: trueExpire,
            uploadTimeISO: new Date(trueExpire).toISOString(),
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

              // Upload student exam records from local disk to S3 if not already in S3
              const examRecordsLocalDir = path.join(studentTargetDir, "exam_records");
              if (fs.existsSync(examRecordsLocalDir)) {
                const recDirs = await fs.promises.readdir(examRecordsLocalDir);
                for (const recId of recDirs) {
                  const recPath = path.join(examRecordsLocalDir, recId);
                  const stat = await fs.promises.stat(recPath);
                  if (!stat.isDirectory()) continue;

                  // Upload upload_info.json inside exam record
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
                    `S3 uploadExamRecord upload_info ${sessionCode}/${studentId}/${recId}`,
                  );

                  // Upload events.jsonl if missing from S3
                  const eventsLocalFile = path.join(recPath, "events.jsonl");
                  if (fs.existsSync(eventsLocalFile)) {
                    const s3Events = await s3Storage.getExamRecordArtifact(sessionCode, studentId, recId, "events.jsonl");
                    if (!s3Events || (typeof s3Events === "string" && s3Events.length < 10)) {
                      const eventsContent = await fs.promises.readFile(eventsLocalFile);
                      await withTimeout(
                        s3Storage.uploadExamRecordFile(sessionCode, studentId, recId, "events.jsonl", eventsContent, "application/x-ndjson"),
                        5000,
                        `S3 upload events.jsonl for ${sessionCode}/${studentId}/${recId}`
                      );
                      console.log(`[LegacyMigration] Uploaded missing events.jsonl to S3 for ${sessionCode}/${studentId}/${recId}`);
                    }
                  }

                  // Upload metadata.json if missing from S3
                  const metaLocalFile = path.join(recPath, "metadata.json");
                  if (fs.existsSync(metaLocalFile)) {
                    const s3Meta = await s3Storage.getExamRecordArtifact(sessionCode, studentId, recId, "metadata.json");
                    if (!s3Meta) {
                      const metaContent = await fs.promises.readFile(metaLocalFile, "utf-8");
                      await withTimeout(
                        s3Storage.uploadExamRecordFile(sessionCode, studentId, recId, "metadata.json", metaContent, "application/json"),
                        4000,
                        `S3 upload metadata.json for ${sessionCode}/${studentId}/${recId}`
                      );
                    }
                  }

                  // Upload snapshot_start.zip if missing from S3
                  const snapLocalFile = path.join(recPath, "snapshot_start.zip");
                  if (fs.existsSync(snapLocalFile)) {
                    const s3Snap = await s3Storage.getExamRecordArtifact(sessionCode, studentId, recId, "snapshot_start.zip");
                    if (!s3Snap) {
                      const snapContent = await fs.promises.readFile(snapLocalFile);
                      await withTimeout(
                        s3Storage.uploadExamRecordFile(sessionCode, studentId, recId, "snapshot_start.zip", snapContent, "application/zip"),
                        5000,
                        `S3 upload snapshot_start.zip for ${sessionCode}/${studentId}/${recId}`
                      );
                    }
                  }
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
