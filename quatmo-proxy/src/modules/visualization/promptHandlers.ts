import { reconcilePromptTurns } from "../../shared/promptTurns";
import { sanitizeFilename } from "../telemetry/logFiles";
import { getVisualizeStudentEventLog } from "./eventHandlers";

export async function readStudentPrompts(sessionCode: string, studentId: string, unclamped = false) {
  const events = await getVisualizeStudentEventLog({
    req: { param: (name: string) => name === "sessionCode" ? sessionCode : studentId,
      query: (name: string) => name === "unclamped" && unclamped ? "true" : undefined },
    get: () => true, json: (body: any) => body,
  });
  const turns = reconcilePromptTurns([], events.aiRecords ?? []);
  return { turns, window: events.validityWindow, filtered: turns };
}

export async function getVisualizeStudentPromptLog(c: any) {
  const sessionCode = sanitizeFilename(c.req.param("sessionCode")).toUpperCase();
  const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
  const unclamped = c.req.query("unclamped") === "true";
  const data = await readStudentPrompts(sessionCode, studentId, unclamped);
  return c.json({ sessionCode, studentId, turns: unclamped ? data.turns : data.filtered, validityWindow: data.window });
}
