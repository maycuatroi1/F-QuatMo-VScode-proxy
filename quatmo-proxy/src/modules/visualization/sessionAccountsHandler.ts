import fs from "node:fs";
import path from "node:path";
import { s3Storage } from "../../services/s3Storage";
import { sanitizeFilename } from "../telemetry/logFiles";
import { getVisualizeStudentEventLog } from "./eventHandlers";
import { readStudentPrompts } from "./promptHandlers";
import { readSessionDefinition } from "./sessionWindow";

export async function listVisualizeSessionAccounts(c: any) {
  const sessionCode = sanitizeFilename(c.req.param("sessionCode")).toUpperCase();
  const root = path.resolve("logs", "sessions", sessionCode);
  const definition = await readSessionDefinition(sessionCode);
  const ids = new Set<string>(definition.allowedStudentIds ?? []);
  for (const s of definition.students ?? []) if (s.studentId) ids.add(s.studentId.toUpperCase());
  if (fs.existsSync(root)) {
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (/manifest|metadata|upload_info|package/i.test(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) ids.add(entry.name.toUpperCase());
      else if (/^[A-Za-z0-9_-]+\.json$/i.test(entry.name)) ids.add(entry.name.slice(0, -5).toUpperCase());
    }
  }
  if (s3Storage.isAvailable()) {
    for (const student of await s3Storage.listStudentsInSessionFromS3(sessionCode)) ids.add(student.studentId.toUpperCase());
  }
  const accounts: any[] = [];
  for (const studentId of ids) {
    const context = {
      req: { param: (name: string) => name === "sessionCode" ? sessionCode : studentId, query: () => undefined },
      get: () => true,
      json: (body: any) => body,
    };
    const event = await getVisualizeStudentEventLog(context);
    const prompts = await readStudentPrompts(sessionCode, studentId);
    accounts.push({
      studentId,
      hasPromptLog: prompts.turns.length > 0,
      hasEventLog: (event.availableRecords?.length ?? 0) > 0 || (event.totalRawEvents ?? 0) > 0,
      promptTurnsCount: prompts.filtered.length,
      eventCount: event.coreRecords?.length ?? 0,
      lastActivity: definition.createdAt ?? definition.startTime ?? 0,
      hasErrors: prompts.filtered.some((t) => !!t.error),
      validityWindow: prompts.window,
    });
  }
  accounts.sort((a, b) => a.studentId.localeCompare(b.studentId));
  return c.json({ sessionCode, accounts });
}
