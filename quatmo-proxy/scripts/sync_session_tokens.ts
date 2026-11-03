import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { sessionStates, stmtSaveState } from "../src/services/sessionStore";
import { safeParseJson } from "../src/services/telemetryMigration";
import { redis } from "../src/services/redis";

async function main() {
  const targetSession = (process.argv[2] || "").trim().toUpperCase();
  console.log(`[SyncScript] Starting token synchronization... Target: ${targetSession || "ALL SESSIONS"}`);

  const sessionsDir = path.resolve(process.cwd(), "logs", "sessions");
  const searchDirs = [
    process.cwd(),
    path.resolve(process.cwd(), "logs"),
    path.resolve(process.cwd(), ".."),
    sessionsDir,
  ];

  let totalUpdated = 0;

  // 1. Scan directory logs
  if (fs.existsSync(sessionsDir)) {
    const sDirs = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    for (const d of sDirs) {
      if (!d.isDirectory()) continue;
      const sCode = d.name.toUpperCase();
      if (targetSession && sCode !== targetSession) continue;

      const mPath = path.join(sessionsDir, d.name, "session_manifest.json");
      if (fs.existsSync(mPath)) {
        try {
          const mJson = safeParseJson(await fs.promises.readFile(mPath, "utf-8"));
          if (mJson && Array.isArray(mJson.students)) {
            for (const s of mJson.students) {
              if (!s.studentId || typeof s.tokensConsumed !== "number") continue;
              const sid = s.studentId.toUpperCase();
              const key = `${sCode}:${sid}`;
              const st = sessionStates.get(key);
              if (st && st.tokensConsumed !== s.tokensConsumed) {
                console.log(`[SyncScript] [Manifest] ${key}: ${st.tokensConsumed.toLocaleString()} -> ${s.tokensConsumed.toLocaleString()}`);
                st.tokensConsumed = s.tokensConsumed;
                if (typeof s.promptTurns === "number") st.promptCount = s.promptTurns;
                sessionStates.set(key, st);
                if (redis && redis.status === "ready") {
                  await redis.hset(`session:user:${sCode}:${sid}`, "consumed", String(s.tokensConsumed));
                }
                totalUpdated++;
              }
            }
          }
        } catch (e: any) {
          console.warn(`[SyncScript] Failed to read ${mPath}:`, e.message);
        }
      }
    }
  }

  // 2. Scan Zip Archives
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = await fs.promises.readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".zip") || (!f.includes("SS-") && !f.includes("logs"))) continue;
        try {
          const zip = new AdmZip(path.join(dir, f));
          const entry = zip.getEntry("session_manifest.json");
          if (entry) {
            const mJson = safeParseJson(entry.getData().toString("utf-8"));
            if (mJson && mJson.sessionCode && Array.isArray(mJson.students)) {
              const sCode = mJson.sessionCode.toUpperCase();
              if (targetSession && sCode !== targetSession) continue;

              for (const s of mJson.students) {
                if (!s.studentId || typeof s.tokensConsumed !== "number") continue;
                const sid = s.studentId.toUpperCase();
                const key = `${sCode}:${sid}`;
                const st = sessionStates.get(key);
                if (st && st.tokensConsumed !== s.tokensConsumed) {
                  console.log(`[SyncScript] [Zip: ${f}] ${key}: ${st.tokensConsumed.toLocaleString()} -> ${s.tokensConsumed.toLocaleString()}`);
                  st.tokensConsumed = s.tokensConsumed;
                  if (typeof s.promptTurns === "number") st.promptCount = s.promptTurns;
                  sessionStates.set(key, st);
                  if (redis && redis.status === "ready") {
                    await redis.hset(`session:user:${sCode}:${sid}`, "consumed", String(s.tokensConsumed));
                  }
                  totalUpdated++;
                }
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  console.log(`[SyncScript] Completed. Updated ${totalUpdated} student token records in SQLite and Redis.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[SyncScript] Error:", err);
  process.exit(1);
});
