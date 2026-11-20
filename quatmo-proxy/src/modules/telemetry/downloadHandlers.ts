import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import { sessions, sessionStates } from "../../services/sessionStore";
import { sanitizeFilename } from "./logFiles";
import { readSessionDefinition } from "../visualization/sessionWindow";

/** Secrets / databases that must never leave the server through log exports. */
function isSensitiveLogFile(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.endsWith(".key") ||
    n.endsWith(".pem") ||
    n.startsWith("quatmo.db") ||
    n.endsWith(".db") ||
    n.endsWith(".db-wal") ||
    n.endsWith(".db-shm") ||
    n.endsWith(".sqlite") ||
    n === ".env" ||
    n.startsWith(".env.") ||
    n === "client_gate_state.json"
  );
}

async function sendDirectoryZip(
  dirPath: string,
  zipFileName: string,
  c: any,
  fallbackMsg: string = "No log files found.",
  manifest?: object,
) {
  if (!fs.existsSync(dirPath)) {
    return c.json({ error: fallbackMsg }, 404);
  }

  try {
    const zip = new AdmZip();
    let addedFilesCount = 0;

    async function walkAndAdd(currentDir: string, relativePath: string = "") {
      const entries = await fs.promises.readdir(currentDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const entryRelativePath = relativePath
          ? path.join(relativePath, entry.name)
          : entry.name;
        const entryFullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walkAndAdd(entryFullPath, entryRelativePath);
        } else if (entry.isFile()) {
          if (isSensitiveLogFile(entry.name)) {
            continue;
          }
          try {
            const fileBuffer = await fs.promises.readFile(entryFullPath);
            const zipPath = entryRelativePath.replace(/\\/g, "/");
            zip.addFile(zipPath, fileBuffer);
            addedFilesCount++;
          } catch (readErr) {
            console.error(
              `[Admin Zip] Failed to read ${entryFullPath}:`,
              readErr,
            );
          }
        }
      }
    }

    await walkAndAdd(dirPath);

    if (addedFilesCount === 0) {
      return c.json({ error: fallbackMsg }, 404);
    }

    if (manifest && !zip.getEntry("session_manifest.json")) {
      zip.addFile("session_manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    }
    const zipBuffer = zip.toBuffer();
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename=${zipFileName}`);
    c.header("Access-Control-Expose-Headers", "Content-Disposition");
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(`[Admin] Failed to zip logs for ${dirPath}:`, err);
    return c.json({ error: `Failed to create ZIP` }, 500);
  }
}

export const handleSessionLogDownload = async (c: any) => {
  const sessionCode = sanitizeFilename(
    c.req.param("sessionCode") || "",
  ).toUpperCase();
  if (!sessionCode) {
    return c.json({ error: "Session code is required." }, 400);
  }

  const sessionLogDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode,
  );

  let exportManifest: object | undefined;
  try {
    const session = sessions.get(sessionCode);
    const manifestStudents: any[] = [];
    if (session) {
      for (const studentId of session.allowedStudentIds) {
        const stateKey = `${sessionCode}:${studentId}`;
        const state = sessionStates.get(stateKey);
        manifestStudents.push({
          studentId,
          loginTimestamp: state?.loginTimestamp || 0,
          tokensConsumed: state?.tokensConsumed || 0,
          latestClassification: state?.latestClassification,
        });
      }
    }
    if (session) exportManifest = {
          sessionCode,
          createdAt: session?.createdAt,
          endedAt: session?.endedAt,
          durationMinutes: session?.durationMinutes,
          exportedAt: Date.now(),
          students: manifestStudents,
        };
  } catch {}

  return await sendDirectoryZip(
    sessionLogDir,
    `session-${sessionCode}-logs.zip`,
    c,
    `No logs found for session ${sessionCode}.`,
    exportManifest,
  );
};

export const handleAllLogsDownload = async (c: any) => {
  const logDir = path.resolve(process.cwd(), "logs");
  return await sendDirectoryZip(
    logDir,
    `all-logs-${Date.now()}.zip`,
    c,
    "No server logs found.",
  );
};

export const handleGuestLogsDownload = async (c: any) => {
  const guestLogDir = path.resolve(process.cwd(), "logs", "guests");
  return await sendDirectoryZip(
    guestLogDir,
    `guest-logs-${Date.now()}.zip`,
    c,
    "No guest logs found.",
  );
};

export async function handleStudentLogDownload(c: any) {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
    const studentDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      studentId,
    );
    const studentJsonPath = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      `${studentId}.json`,
    );

    // If student has a record directory (exam events, etc.), zip it along with prompt log json
    if (fs.existsSync(studentDir)) {
      const zip = new AdmZip();
      if (fs.existsSync(studentJsonPath)) {
        zip.addLocalFile(studentJsonPath, "");
      }
      zip.addLocalFolder(studentDir, studentId);
      const manifestPath = path.join(path.dirname(studentDir), "session_manifest.json");
      if (fs.existsSync(manifestPath)) zip.addLocalFile(manifestPath, "");
      else {
        const definition = await readSessionDefinition(sessionCode);
        if (definition.createdAt || definition.startTime) zip.addFile("session_manifest.json", Buffer.from(JSON.stringify({
          ...definition, students: [{ studentId, loginTimestamp: sessionStates.get(`${sessionCode}:${studentId}`)?.loginTimestamp }],
        })));
      }
      const buffer = zip.toBuffer();
      c.header("Content-Type", "application/zip");
      c.header(
        "Content-Disposition",
        `attachment; filename=${sessionCode}_${studentId}_logs.zip`,
      );
      c.header("Access-Control-Expose-Headers", "Content-Disposition");
      return c.body(buffer);
    } else if (fs.existsSync(studentJsonPath)) {
      const content = await fs.promises.readFile(studentJsonPath, "utf-8");
      c.header("Content-Type", "application/json");
      c.header(
        "Content-Disposition",
        `attachment; filename=${sessionCode}_${studentId}_prompts.json`,
      );
      c.header("Access-Control-Expose-Headers", "Content-Disposition");
      return c.body(content);
    }

    return c.json(
      {
        error: `No logs found for student ${studentId} in session ${sessionCode}.`,
      },
      404,
    );
  }

export async function handleGuestLogDownload(c: any) {
  const guestId = sanitizeFilename(c.req.param("guestId")).toUpperCase();
  const guestJsonPath = path.resolve(
    process.cwd(),
    "logs",
    "guests",
    `${guestId}.json`,
  );

  if (fs.existsSync(guestJsonPath)) {
    const content = await fs.promises.readFile(guestJsonPath, "utf-8");
    c.header("Content-Type", "application/json");
    c.header(
      "Content-Disposition",
      `attachment; filename=guest_${guestId}_prompts.json`,
    );
    c.header("Access-Control-Expose-Headers", "Content-Disposition");
    return c.body(content);
  }

  return c.json({ error: `No logs found for guest ${guestId}.` }, 404);
}
