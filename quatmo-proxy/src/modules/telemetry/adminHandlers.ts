import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import { redis } from "../../services/redis";
import { sessionStates } from "../../services/sessionStore";
import { requireCaller } from "../../shared/http/adminCaller";
import { sanitizeFilename } from "./logFiles";

export async function syncSessionTokens(c: any) {
  requireCaller(c);
  const sessionCode = sanitizeFilename(c.req.param("sessionCode") || "").toUpperCase();
  if (!sessionCode) {
    return c.json({ error: "Session code is required." }, 400);
  }

  const { reconcileStudentPromptTurns, safeParseJson } = await import("../../services/promptLogService");
  const sessionLogDir = path.resolve(process.cwd(), "logs", "sessions", sessionCode);
  const updatedStudents: Array<{ studentId: string; oldTokens: number; newTokens: number }> = [];
  const reconciledStudents = new Set<string>();

  // 1. Check directory logs if available
  if (fs.existsSync(sessionLogDir)) {
    try {
      const files = await fs.promises.readdir(sessionLogDir);
      for (const f of files) {
        if (!f.endsWith(".json") || f.includes("manifest")) continue;
        const studentId = f.replace(/\.json$/, "").toUpperCase();
        const stateKey = `${sessionCode}:${studentId}`;
        const st = sessionStates.get(stateKey);
        const oldTokens = st?.tokensConsumed ?? 0;
        const res = await reconcileStudentPromptTurns(sessionCode, studentId, sessionLogDir);
        if (!res.turns.length || res.turns.some((t) => !Number.isFinite(t.tokensConsumedTotal))) continue;
        reconciledStudents.add(studentId);
        const newTokens = res.turns.reduce((acc, t) => acc + (t.tokensConsumedTotal || 0), 0);
        if (st && (st.tokensConsumed !== newTokens || res.wasRepaired)) {
          st.tokensConsumed = newTokens;
          st.promptCount = res.turns.length;
          sessionStates.set(stateKey, st);
          if (redis && redis.status === "ready") {
            await redis.hset(`session:user:${sessionCode}:${studentId}`, "consumed", String(newTokens));
          }
          updatedStudents.push({ studentId, oldTokens, newTokens });
        }
      }
    } catch {}
  }

  // 2. Check session_manifest.json in sessionLogDir or root zip files
  const manifestPath = path.join(sessionLogDir, "session_manifest.json");
  let manifestData: any = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifestData = safeParseJson(await fs.promises.readFile(manifestPath, "utf-8"));
    } catch {}
  }

  if (!manifestData) {
    const zipCandidates = [
      path.join(process.cwd(), `logs_${sessionCode}.zip`),
      path.join(process.cwd(), `session-${sessionCode}-logs.zip`),
      path.join(process.cwd(), "logs", `logs_${sessionCode}.zip`),
      path.join(process.cwd(), "logs", `session-${sessionCode}-logs.zip`),
      path.join(process.cwd(), "..", `logs_${sessionCode}.zip`),
    ];
    for (const zPath of zipCandidates) {
      if (fs.existsSync(zPath)) {
        try {
          const zip = new AdmZip(zPath);
          const entry = zip.getEntry("session_manifest.json");
          if (entry) {
            manifestData = safeParseJson(entry.getData().toString("utf-8"));
            break;
          }
        } catch {}
      }
    }
  }

  if (manifestData && Array.isArray(manifestData.students)) {
    for (const sItem of manifestData.students) {
      if (!sItem.studentId || typeof sItem.tokensConsumed !== "number") continue;
      const safeSid = sItem.studentId.toUpperCase();
      if (reconciledStudents.has(safeSid)) continue;
      const stateKey = `${sessionCode}:${safeSid}`;
      const st = sessionStates.get(stateKey);
      const oldTokens = st?.tokensConsumed ?? 0;
      if (st && st.tokensConsumed !== sItem.tokensConsumed) {
        st.tokensConsumed = sItem.tokensConsumed;
        if (typeof sItem.promptTurns === "number") st.promptCount = sItem.promptTurns;
        sessionStates.set(stateKey, st);
        if (redis && redis.status === "ready") {
          await redis.hset(`session:user:${sessionCode}:${safeSid}`, "consumed", String(sItem.tokensConsumed));
        }
        if (!updatedStudents.some((u) => u.studentId === safeSid)) {
          updatedStudents.push({ studentId: safeSid, oldTokens, newTokens: sItem.tokensConsumed });
        }
      }
    }
  }

  return c.json({
    success: true,
    sessionCode,
    updatedCount: updatedStudents.length,
    students: updatedStudents,
  });
}
