import path from "node:path";
import { s3Storage } from "../../services/s3Storage";
import { reconcileStudentPromptTurns } from "../../services/promptLogService";
import { inSessionWindow } from "../../shared/sessionTime";
import { requestTime, reconcilePromptTurns } from "../../shared/promptTurns";
import { sanitizeFilename } from "../telemetry/logFiles";
import { getStudentSessionWindow } from "./sessionWindow";
import { getVisualizeStudentEventLog } from "./eventHandlers";

export async function readStudentPrompts(sessionCode: string, studentId: string) {
  const sessionDir = path.resolve("logs", "sessions", sessionCode);
  let { turns, source } = await reconcileStudentPromptTurns(sessionCode, studentId, sessionDir);
  if (s3Storage.isAvailable() && source !== "local_proxy_log") {
    const raw = await s3Storage.getStudentPromptLog(sessionCode, studentId) ?? [];
    turns = reconcilePromptTurns([...turns, ...raw]);
  }
  const events = await getVisualizeStudentEventLog({
    req: { param: (name: string) => name === "sessionCode" ? sessionCode : studentId,
      query: (name: string) => name === "unclamped" ? "true" : undefined },
    get: () => true, json: (body: any) => body,
  });
  turns = reconcilePromptTurns(turns, events.aiRecords ?? []);
  const window = await getStudentSessionWindow(sessionCode, studentId);
  return { turns, window, filtered: turns.filter((t) => t.associationStatus !== "DUPLICATE_CONFLICT" && inSessionWindow(requestTime(t), window)) };
}

export async function getVisualizeStudentPromptLog(c: any) {
  const sessionCode = sanitizeFilename(c.req.param("sessionCode")).toUpperCase();
  const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
  const data = await readStudentPrompts(sessionCode, studentId);
  return c.json({ sessionCode, studentId, turns: c.req.query("unclamped") === "true" ? data.turns : data.filtered, validityWindow: data.window });
}
