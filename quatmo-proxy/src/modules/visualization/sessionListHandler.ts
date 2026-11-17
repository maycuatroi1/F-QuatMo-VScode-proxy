import path from "path";
import fs from "fs";
import { sessions } from "../../services/sessionStore";
import { s3Storage } from "../../services/s3Storage";
import { requireCaller } from "../../shared/http/adminCaller";
import { toMs } from "./time";

export async function listVisualizeSessions(c: any) {
  const sessionsLogDir = path.resolve(process.cwd(), "logs", "sessions");
  const resultSessions: Array<{
    sessionCode: string;
    sessionName: string;
    promptLogCount: number;
    eventLogCount: number;
    lastActivity: number;
    studentCount: number;
    startTime?: number;
    createdAt?: number;
    durationMinutes?: number;
    endedAt?: number;
  }> = [];

  const scannedCodes = new Set<string>();

  if (fs.existsSync(sessionsLogDir)) {
    try {
      const entries = await fs.promises.readdir(sessionsLogDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const code = entry.name.toUpperCase();
        scannedCodes.add(code);
        const sessionPath = path.join(sessionsLogDir, entry.name);
        const sessionObj = sessions.get(code);

        let promptLogCount = 0;
        let eventLogCount = 0;
        let lastActivity = 0;
        const studentIds = new Set<string>();

        try {
          const subEntries = await fs.promises.readdir(sessionPath, {
            withFileTypes: true,
          });
          for (const sub of subEntries) {
            const subNameLower = sub.name.toLowerCase();
            if (
              subNameLower.includes("manifest") ||
              subNameLower.includes("metadata") ||
              subNameLower.includes("upload_info") ||
              subNameLower.includes("package") ||
              subNameLower.startsWith(".") ||
              subNameLower.endsWith(".tmp") ||
              subNameLower.endsWith(".bak") ||
              subNameLower === "__macosx"
            ) {
              continue;
            }

            const subPath = path.join(sessionPath, sub.name);
            const stat = await fs.promises.stat(subPath);
            if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;

            if (
              sub.isFile() &&
              sub.name.endsWith(".json") &&
              !sub.name.includes("-logs")
            ) {
              promptLogCount++;
              const studentId = sub.name.replace(/\.json$/, "");
              studentIds.add(studentId);
            } else if (sub.isDirectory()) {
              eventLogCount++;
              studentIds.add(sub.name);
            }
          }
        } catch {}

        const sStart = toMs(sessionObj?.startTime);
        const sCreated = toMs(sessionObj?.createdAt);
        const sEnd = toMs(sessionObj?.endedAt);
        resultSessions.push({
          sessionCode: code,
          sessionName: code,
          promptLogCount,
          eventLogCount,
          lastActivity: lastActivity || (sCreated ? sCreated : Date.now()),
          studentCount: studentIds.size,
          startTime: sStart || sCreated || undefined,
          createdAt: sCreated || sStart || undefined,
          durationMinutes: sessionObj?.durationMinutes || 90,
          endedAt: sEnd || undefined,
        });
      }
    } catch {}
  }

  // Include in-memory sessions that haven't written to disk yet
  for (const [code, sessionObj] of sessions.entries()) {
    if (!scannedCodes.has(code)) {
      scannedCodes.add(code);
      const sStart = toMs(sessionObj.startTime);
      const sCreated = toMs(sessionObj.createdAt);
      const sEnd = toMs(sessionObj.endedAt);
      resultSessions.push({
        sessionCode: code,
        sessionName: code,
        promptLogCount: 0,
        eventLogCount: 0,
        lastActivity: sCreated || Date.now(),
        studentCount: sessionObj.allowedStudentIds
          ? sessionObj.allowedStudentIds.size
          : 0,
        startTime: sStart || sCreated || undefined,
        createdAt: sCreated || sStart || undefined,
        durationMinutes: sessionObj.durationMinutes || 90,
        endedAt: sEnd || undefined,
      });
    }
  }

  // Include S3 sessions
  if (s3Storage.isAvailable()) {
    try {
      const s3SessionCodes = await s3Storage.listSessionsFromS3();
      for (const code of s3SessionCodes) {
        if (!scannedCodes.has(code)) {
          scannedCodes.add(code);
          const students = await s3Storage.listStudentsInSessionFromS3(code);
          const sessionObj = sessions.get(code);
          const promptLogCount = students.filter((s) => s.hasPromptLog).length;
          const eventLogCount = students.filter((s) => s.hasEventLog).length;
          const sStart = toMs(sessionObj?.startTime);
          const sCreated = toMs(sessionObj?.createdAt);
          const sEnd = toMs(sessionObj?.endedAt);
          const lastActivity = Math.max(
            ...students.map((s) => s.lastActivity || 0),
            sCreated || Date.now(),
          );
          resultSessions.push({
            sessionCode: code,
            sessionName: code,
            promptLogCount,
            eventLogCount,
            lastActivity,
            studentCount:
              students.length || sessionObj?.allowedStudentIds?.size || 0,
            startTime: sStart || sCreated || undefined,
            createdAt: sCreated || sStart || undefined,
            durationMinutes: sessionObj?.durationMinutes || 90,
            endedAt: sEnd || undefined,
          });
        }
      }
    } catch (err) {
      console.error("[Visualize] S3 sessions listing error:", err);
    }
  }

  // Count guest logs
  let guestLogCount = 0;
  let guestLastActivity = 0;
  const guestDirs = [
    path.resolve(process.cwd(), "logs", "guests"),
    path.resolve(process.cwd(), "logs", "machines"),
  ];
  for (const gDir of guestDirs) {
    if (fs.existsSync(gDir)) {
      try {
        const gEntries = await fs.promises.readdir(gDir, {
          withFileTypes: true,
        });
        for (const g of gEntries) {
          if (
            g.isFile() &&
            (g.name.endsWith(".json") || g.name.endsWith(".log"))
          ) {
            guestLogCount++;
            const stat = await fs.promises.stat(path.join(gDir, g.name));
            if (stat.mtimeMs > guestLastActivity)
              guestLastActivity = stat.mtimeMs;
          }
        }
      } catch {}
    }
  }

  const caller = requireCaller(c) as any;
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();
  const filteredSessions = resultSessions.filter((s) => {
    if (callerRole === "admin") return true;
    const sessionObj = sessions.get(s.sessionCode);
    return (sessionObj?.createdBy || "admin").toLowerCase() === callerUser;
  });
  filteredSessions.sort((a, b) => b.lastActivity - a.lastActivity);

  return c.json({
    sessions: filteredSessions,
    guestSummary: {
      count: guestLogCount,
      lastActivity: guestLastActivity,
    },
  });
}
