import path from "path";
import { s3Storage } from "../../services/s3Storage";
import { redisStore } from "../../services/classifier/redisStore";
import { reconcileStudentPromptTurns } from "../../services/promptLogService";
import { sanitizeFilename } from "../telemetry/logFiles";

export async function getVisualizeStudentPromptLog(c: any) {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
    const sessionDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
    );

    let turns: any[] = [];
    try {
      const reconciled = await reconcileStudentPromptTurns(
        sessionCode,
        studentId,
        sessionDir,
      );
      turns = reconciled.turns || [];
    } catch (err: any) {
      console.warn(
        `[Visualize] Reconcile error for ${sessionCode}/${studentId}:`,
        err?.message || err,
      );
    }

    if (turns.length > 0) {
      try {
        const redisTurns = await redisStore.getTurns(sessionCode, studentId);
        if (redisTurns && redisTurns.length > 0) {
          for (const t of turns) {
            const match = redisTurns.find((rt: any) => rt.prompt === t.prompt);
            if (match) {
              if (!t.classification) t.classification = {};
              if (
                (!t.classification.features ||
                  Object.keys(t.classification.features).length === 0) &&
                match.featureVector
              ) {
                t.classification.features = match.featureVector;
              }
              if (
                typeof match.I_score === "number" &&
                typeof t.classification.iScoreTurn !== "number"
              ) {
                t.classification.iScoreTurn = match.I_score;
              }
              if (
                typeof match.E_score === "number" &&
                typeof t.classification.eScoreTurn !== "number"
              ) {
                t.classification.eScoreTurn = match.E_score;
              }
            }
          }
        }
      } catch {}

      return c.json({
        sessionCode,
        studentId,
        turns,
      });
    }

    // Check S3 if not found locally
    if (s3Storage.isAvailable()) {
      try {
        const s3Turns = await s3Storage.getStudentPromptLog(
          sessionCode,
          studentId,
        );
        if (s3Turns && s3Turns.length > 0) {
          return c.json({ sessionCode, studentId, turns: s3Turns });
        }
      } catch (err: any) {
        console.error("[Visualize] S3 prompt log fetch error:", err);
      }
    }

    return c.json({ sessionCode, studentId, turns: [] });
  }
