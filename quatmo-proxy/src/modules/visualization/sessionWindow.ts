import fs from "node:fs";
import path from "node:path";
import { sessions, sessionStates } from "../../services/sessionStore";
import { s3Storage } from "../../services/s3Storage";
import { resolveSessionWindow } from "../../shared/sessionTime";

export async function readSessionDefinition(code: string) {
  let manifest: any = null;
  const file = path.resolve("logs", "sessions", code, "session_manifest.json");
  if (fs.existsSync(file)) {
    try { manifest = JSON.parse(await fs.promises.readFile(file, "utf8")); } catch {}
  } else if (s3Storage.isAvailable()) {
    manifest = await s3Storage.getSessionManifest(code);
  }
  return { ...manifest, ...sessions.get(code) };
}

export async function getStudentSessionWindow(code: string, student: string, uploadedWindow?: any) {
  const session = await readSessionDefinition(code);
  if (uploadedWindow === undefined) {
    const root = path.resolve("logs", "sessions", code);
    const entries = fs.existsSync(root) ? await fs.promises.readdir(root) : [];
    const directory = entries.find((e) => e.toUpperCase() === student.toUpperCase()) ?? student;
    const file = path.join(root, directory, "upload_info.json");
    try {
      const raw = fs.existsSync(file) ? await fs.promises.readFile(file, "utf8") :
        s3Storage.isAvailable() ? await s3Storage.getStudentFile(code, student, "upload_info.json") : null;
      if (typeof raw === "string") uploadedWindow = JSON.parse(raw).validityWindow;
    } catch {}
  }
  const manifestStudent = Array.isArray(session.students)
    ? session.students.find((s: any) => s.studentId?.toUpperCase() === student.toUpperCase()) : undefined;
  return resolveSessionWindow(session, [
    sessionStates.get(`${code}:${student}`)?.loginTimestamp,
    manifestStudent?.loginTimestamp,
    uploadedWindow?.signinTimestamp,
  ]);
}
