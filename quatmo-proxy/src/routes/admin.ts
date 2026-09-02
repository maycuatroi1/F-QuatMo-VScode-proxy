import { Hono } from "hono";
import { getProxyApiKey } from "../services/proxyKey";
import { getAdminUsername, getAdminPassword } from "../services/adminCredentials";
import { redis } from "../services/redis";
import { sign, verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import crypto from "crypto";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, "");
}

declare const Bun: any;
import {
  studentAccounts,
  sessions,
  sessionStates,
  studentGroups,
  type Session,
  type StudentSessionState,
} from "../services/sessionStore";

const adminRouter = new Hono();

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware protecting Admin data endpoints via PROXY_API_KEY or Admin JWT Token
// ─────────────────────────────────────────────────────────────────────────────
adminRouter.use("*", async (c, next) => {
  const path = c.req.path;
  const url = c.req.url;
  if (c.req.method === "OPTIONS" || path.includes("/login") || url.includes("/login")) {
    await next();
    return;
  }

  const masterKey = getProxyApiKey();
  const xApiKey = c.req.header("x-api-key") || c.req.header("X-API-Key");

  if (xApiKey && xApiKey.trim() === masterKey) {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (token === masterKey) {
      await next();
      return;
    }

    try {
      const decoded = await verify(token, getJwtSecret());
      if (decoded && (decoded.role === "admin" || decoded.username)) {
        await next();
        return;
      }
    } catch {
      // Invalid JWT
    }
  }

  return c.json({ error: "Unauthorized. Invalid Proxy API Key" }, 401);
});

// Admin login endpoint validating environment credentials and returning signed JWT token
adminRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return c.json({ error: "Username and password are required." }, 400);
  }

  const expectedUsername = getAdminUsername();
  const expectedPassword = getAdminPassword();

  if (username === expectedUsername && password === expectedPassword) {
    const jwtSecret = getJwtSecret();
    const payload = {
      role: "admin",
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // Maximum 24-hour expiration
    };
    const token = await sign(payload, jwtSecret);
    return c.json({ success: true, token });
  }

  return c.json({ error: "Invalid username or password." }, 401);
});

// 1. Initialize global student account repository
const handleStudentImport = async (c: any) => {
  const body = await c.req.json();
  const { students } = body as {
    students?: Array<{ studentId: string; password?: string }>;
  };

  if (!students || !Array.isArray(students)) {
    return c.json(
      { error: "Invalid payload. 'students' array is required." },
      400,
    );
  }

  let importedCount = 0;
  const promises = students.map(async (stu) => {
    if (!stu.studentId || !stu.password) return;
    const passwordHash = await Bun.password.hash(stu.password, "bcrypt");
    studentAccounts.set(stu.studentId.toUpperCase(), {
      studentId: stu.studentId.toUpperCase(),
      passwordHash,
    });
    importedCount++;
  });
  await Promise.all(promises);

  return c.json({
    success: true,
    message: `Imported ${importedCount} student accounts.`,
  });
};

adminRouter.post("/students", handleStudentImport);
adminRouter.post("/students/import", handleStudentImport);

adminRouter.get("/students", async (c) => {
  const list: any[] = [];
  for (const account of studentAccounts.values()) {
    list.push({
      studentId: account.studentId,
    });
  }
  return c.json({ success: true, students: list });
});

adminRouter.post("/sessions", async (c) => {
  const body = await c.req.json();
  const {
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    assignedGroups,
  } = body as {
    durationMinutes?: number;
    aiOption?: "chatbot" | "agent" | "none";
    aiValidityMinutes?: number;
    defaultTokenBudget?: number;
    assignedGroups?: string[];
  };

  if (
    !durationMinutes ||
    !aiOption ||
    aiValidityMinutes === undefined ||
    !defaultTokenBudget
  ) {
    return c.json(
      {
        error:
          "Missing required fields: durationMinutes, aiOption, aiValidityMinutes, defaultTokenBudget",
      },
      400,
    );
  }

  let sessionCode = "";
  do {
    const chars = "ABCDEFGHJKLMNOPQRSTUVWXYZ23456789";
    let code = "SS-";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!sessions.has(code)) {
      sessionCode = code;
    }
  } while (!sessionCode);

  const allowedStudentIds = new Set<string>();
  const groupNames: string[] = [];

  // Resolve student IDs from assigned groups
  if (Array.isArray(assignedGroups) && assignedGroups.length > 0) {
    for (const rawName of assignedGroups) {
      const groupName = String(rawName).trim();
      if (!groupName) continue;
      groupNames.push(groupName);

      const group = studentGroups.get(groupName);
      if (group && Array.isArray(group.userIds)) {
        for (const uid of group.userIds) {
          allowedStudentIds.add(uid.toUpperCase());
        }
      }
    }
  }

  const newSession: Session = {
    sessionCode,
    startTime: Math.floor(Date.now() / 1000),
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    allowedStudentIds,
    assignedGroups: groupNames,
    createdAt: Date.now(),
  };

  // Initialize sessionStates for all resolved group member students
  for (const studentId of allowedStudentIds) {
    const stateKey = `${sessionCode}:${studentId}`;
    if (!sessionStates.has(stateKey)) {
      const initialState: StudentSessionState = {
        sessionCode,
        studentId,
        hasLoggedIn: false,
        loginTimestamp: 0,
        tokensConsumed: 0,
        reassigned: false,
      };
      sessionStates.set(stateKey, initialState);
    }
  }

  sessions.set(sessionCode, newSession);

  return c.json({
    success: true,
    sessionCode,
    session: {
      ...newSession,
      allowedStudentIds: Array.from(allowedStudentIds),
      assignedGroups: groupNames,
    },
  });
});

adminRouter.post("/sessions/:sessionCode/students", async (c) => {
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  const body = await c.req.json();
  const { studentIds } = body as { studentIds?: string[] };

  if (!studentIds || !Array.isArray(studentIds)) {
    return c.json(
      { error: "Invalid payload. 'studentIds' array is required." },
      400,
    );
  }

  let addedCount = 0;
  for (const rawId of studentIds) {
    const id = rawId.toUpperCase();
    session.allowedStudentIds.add(id);

    const stateKey = `${sessionCode}:${id}`;
    if (!sessionStates.has(stateKey)) {
      const initialState: StudentSessionState = {
        sessionCode,
        studentId: id,
        hasLoggedIn: false,
        loginTimestamp: 0,
        tokensConsumed: 0,
        reassigned: false,
      };
      sessionStates.set(stateKey, initialState);
    }
    addedCount++;
  }
  sessions.set(sessionCode, session);

  return c.json({
    success: true,
    message: `Added ${addedCount} students to session ${sessionCode}.`,
    totalStudents: session.allowedStudentIds.size,
  });
});

adminRouter.post(
  "/sessions/:sessionCode/students/:studentId/reassign",
  async (c) => {
    const sessionCode = c.req.param("sessionCode").toUpperCase();
    const studentId = c.req.param("studentId").toUpperCase();
    const stateKey = `${sessionCode}:${studentId}`;

    const state = sessionStates.get(stateKey);
    if (!state) {
      return c.json({ error: "Student session state not found." }, 404);
    }

    state.reassigned = true;
    state.hasLoggedIn = false;

    // Revoke active Redis session cache to immediately invalidate existing JWT token
    if (redis && redis.status === "ready") {
      try {
        const redisKey = `session:user:${sessionCode}:${studentId}`;
        await redis.del(redisKey);
      } catch (err) {
        console.error(
          `[Admin] Failed to delete Redis session for ${stateKey}:`,
          err,
        );
      }
    }

    return c.json({
      success: true,
      message: `Student ${studentId} reassigned successfully in session ${sessionCode}.`,
    });
  },
);

adminRouter.get("/sessions", async (c) => {
  const sessionPromises = Array.from(sessions.entries()).map(
    async ([code, session]) => {
      const studentIds = new Set(session.allowedStudentIds);
      for (const state of sessionStates.values()) {
        if (state.sessionCode === code) {
          studentIds.add(state.studentId);
        }
      }

      const studentStatesPromises = Array.from(studentIds).map(
        async (studentId) => {
          const stateKey = `${code}:${studentId}`;
          const state = sessionStates.get(stateKey);

          let consumed = state?.tokensConsumed ?? 0;
          if (redis && redis.status === "ready") {
            try {
              const val = await redis.hget(
                `session:user:${code}:${studentId}`,
                "consumed",
              );
              if (val !== null) {
                consumed = parseInt(val, 10);
              }
            } catch {
              // fallback
            }
          }

          return {
            studentId,
            hasLoggedIn: state?.hasLoggedIn ?? false,
            loginTimestamp: state?.loginTimestamp ?? 0,
            tokensConsumed: consumed,
            reassigned: state?.reassigned ?? false,
            latestClassification: state?.latestClassification ?? "none",
            instrumentalCount: state?.instrumentalCount ?? 0,
            executiveCount: state?.executiveCount ?? 0,
            mixedCount: state?.mixedCount ?? 0,
            promptCount: state?.promptCount ?? 0,
          };
        },
      );

      const studentStates = await Promise.all(studentStatesPromises);

      return {
        sessionCode: session.sessionCode,
        startTime: session.startTime,
        durationMinutes: session.durationMinutes,
        aiOption: session.aiOption,
        aiValidityMinutes: session.aiValidityMinutes,
        defaultTokenBudget: session.defaultTokenBudget,
        assignedGroups: session.assignedGroups || [],
        createdAt: session.createdAt || session.startTime * 1000,
        students: studentStates,
      };
    },
  );

  const sessionList = await Promise.all(sessionPromises);
  return c.json({ success: true, sessions: sessionList });
});

adminRouter.get("/sessions/:sessionCode/logs/zip", async (c) => {
  const sessionCode = sanitizeFilename(c.req.param("sessionCode")).toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  const sessionLogDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode,
  );
  if (!fs.existsSync(sessionLogDir)) {
    return c.json({ error: `No logs found for session ${sessionCode}.` }, 404);
  }

  try {
    const zip = new AdmZip();
    let addedFilesCount = 0;

    // Get encryption key from environment or use a secure fallback
    const secret = (
      process.env.LOG_ENCRYPT_KEY || "quatmo-logs-default-passphrase"
    ).trim();

    async function addDirectoryFiles(dirPath: string, zipPrefix: string = "") {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relZipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await addDirectoryFiles(fullPath, relZipPath);
        } else if (entry.name.endsWith(".json") || entry.name.endsWith(".log")) {
          const fileContent = await fs.promises.readFile(fullPath, "utf-8");
          const key = crypto.createHash("sha256").update(secret).digest();
          const iv = crypto
            .createHash("sha256")
            .update(key)
            .digest()
            .subarray(0, 16);
          const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
          const encryptedBuffer = Buffer.concat([
            cipher.update(fileContent, "utf-8"),
            cipher.final(),
          ]);

          zip.addFile(`${relZipPath}.enc`, encryptedBuffer);
          addedFilesCount++;
        }
      }
    }

    await addDirectoryFiles(sessionLogDir);

    if (addedFilesCount === 0) {
      return c.json({ error: `No log files found in session directory.` }, 404);
    }

    const zipBuffer = zip.toBuffer();

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename=session-${sessionCode}-logs.zip`,
    );
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(
      `[Admin] Failed to zip logs for session ${sessionCode}:`,
      err,
    );
    return c.json({ error: `Failed to create ZIP: ${err.message}` }, 500);
  }
});

adminRouter.get("/machines/logs/zip", async (c) => {
  const machineLogDir = path.resolve(
    process.cwd(),
    "logs",
    "machines",
  );
  if (!fs.existsSync(machineLogDir)) {
    return c.json({ error: `No machine logs found.` }, 404);
  }

  try {
    const zip = new AdmZip();
    const files = await fs.promises.readdir(machineLogDir);
    let addedFilesCount = 0;

    // Get encryption key from environment or use a secure fallback
    const secret = (
      process.env.LOG_ENCRYPT_KEY || "quatmo-logs-default-passphrase"
    ).trim();

    for (const file of files) {
      if (file.endsWith(".json") || file.endsWith(".log")) {
        const filePath = path.join(machineLogDir, file);
        const fileContent = await fs.promises.readFile(filePath, "utf-8");

        // Encrypt log file content using AES-256-CBC
        const key = crypto.createHash("sha256").update(secret).digest();
        const iv = crypto
          .createHash("sha256")
          .update(key)
          .digest()
          .subarray(0, 16);
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
        const encryptedBuffer = Buffer.concat([
          cipher.update(fileContent, "utf-8"),
          cipher.final(),
        ]);

        // Add encrypted buffer as <filename>.enc to ZIP
        zip.addFile(`${file}.enc`, encryptedBuffer);
        addedFilesCount++;
      }
    }

    if (addedFilesCount === 0) {
      return c.json({ error: `No log files found in machines directory.` }, 404);
    }

    const zipBuffer = zip.toBuffer();

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename=machine-logs.zip`,
    );
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(
      `[Admin] Failed to zip logs for machines:`,
      err,
    );
    return c.json({ error: `Failed to create ZIP: ${err.message}` }, 500);
  }
});

adminRouter.get("/logs/zip", async (c) => {
  const logDir = path.resolve(process.cwd(), "logs");
  if (!fs.existsSync(logDir)) {
    return c.json({ error: "No logs found." }, 404);
  }

  try {
    const zip = new AdmZip();
    let addedFilesCount = 0;

    const secret = (
      process.env.LOG_ENCRYPT_KEY || "quatmo-logs-default-passphrase"
    ).trim();

    async function walkAndEncrypt(currentDir: string, relativePath: string = "") {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryRelativePath = relativePath
          ? path.join(relativePath, entry.name)
          : entry.name;
        const entryFullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walkAndEncrypt(entryFullPath, entryRelativePath);
        } else if (entry.isFile()) {
          if (entry.name.endsWith(".json") || entry.name.endsWith(".log")) {
            const isTargetLog = entryRelativePath.startsWith("sessions" + path.sep) ||
                                entryRelativePath.startsWith("machines" + path.sep) ||
                                entryRelativePath.startsWith("sessions/") ||
                                entryRelativePath.startsWith("machines/");

            if (isTargetLog) {
              const fileContent = await fs.promises.readFile(entryFullPath, "utf-8");

              // Encrypt log file content using AES-256-CBC
              const key = crypto.createHash("sha256").update(secret).digest();
              const iv = crypto
                .createHash("sha256")
                .update(key)
                .digest()
                .subarray(0, 16);
              const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
              const encryptedBuffer = Buffer.concat([
                cipher.update(fileContent, "utf-8"),
                cipher.final(),
              ]);

              // Standardize path separator to '/' for ZIP compatibility
              const zipPath = `${entryRelativePath}.enc`.replace(/\\/g, "/");
              zip.addFile(zipPath, encryptedBuffer);
              addedFilesCount++;
            }
          }
        }
      }
    }

    await walkAndEncrypt(logDir);

    if (addedFilesCount === 0) {
      return c.json({ error: "No log files found." }, 404);
    }

    const zipBuffer = zip.toBuffer();

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename=all-logs.zip`,
    );
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(`[Admin] Failed to zip all logs:`, err);
    return c.json({ error: `Failed to create ZIP: ${err.message}` }, 500);
  }
});

// Real-time synchronization of group member changes (ADD or REMOVE) with all active sessions
async function syncGroupWithActiveSessions(groupName: string, addedUserIds: string[] = [], removedUserIds: string[] = []) {
  const upperAddedIds = addedUserIds.map((id) => id.toUpperCase());
  const upperRemovedIds = removedUserIds.map((id) => id.toUpperCase());
  const nowSec = Math.floor(Date.now() / 1000);

  for (const session of sessions.values()) {
    if (!session.assignedGroups || !session.assignedGroups.includes(groupName)) {
      continue;
    }

    const startSec = session.startTime || Math.floor((session.createdAt || Date.now()) / 1000);
    const durationSec = session.durationMinutes === -1 ? 86400 * 30 : (session.durationMinutes || 60) * 60;
    const endSec = startSec + durationSec;
    const isActive = nowSec < endSec;

    // 1. Process ADDED students in real-time
    for (const uid of upperAddedIds) {
      session.allowedStudentIds.add(uid);

      const stateKey = `${session.sessionCode}:${uid}`;
      let state = sessionStates.get(stateKey);
      if (!state) {
        state = {
          sessionCode: session.sessionCode,
          studentId: uid,
          hasLoggedIn: false,
          loginTimestamp: 0,
          tokensConsumed: 0,
          reassigned: false,
        };
        sessionStates.set(stateKey, state);
      }

      if (isActive && state.hasLoggedIn && !state.reassigned) {
        if (redis && redis.status === "ready") {
          const redisKey = `session:user:${session.sessionCode}:${uid}`;
          const remainingSec = Math.max(60, endSec - nowSec);
          await redis.hset(redisKey, {
            studentId: uid,
            sessionCode: session.sessionCode,
            hasLoggedIn: "true",
            tokensConsumed: String(state.tokensConsumed || 0),
            budget: String(session.defaultTokenBudget || 100000000),
            latestClassification: state.latestClassification || "none",
          }).catch(() => {});
          await redis.expire(redisKey, remainingSec).catch(() => {});
        }
      }
    }

    // 2. Process REMOVED / KICKED students in real-time
    for (const uid of upperRemovedIds) {
      let stillBelongsToOtherGroup = false;
      for (const otherGroupName of session.assignedGroups) {
        if (otherGroupName === groupName) continue;
        const otherGroup = studentGroups.get(otherGroupName);
        if (otherGroup && Array.isArray(otherGroup.userIds)) {
          if (otherGroup.userIds.some((id) => id.toUpperCase() === uid)) {
            stillBelongsToOtherGroup = true;
            break;
          }
        }
      }

      if (!stillBelongsToOtherGroup) {
        session.allowedStudentIds.delete(uid);
        const stateKey = `${session.sessionCode}:${uid}`;
        sessionStates.delete(stateKey);

        if (redis && redis.status === "ready") {
          const redisKey = `session:user:${session.sessionCode}:${uid}`;
          await redis.del(redisKey).catch(() => {});
        }
      }
    }

    sessions.set(session.sessionCode, session);
  }
}

adminRouter.get("/groups", async (c) => {
  const groupsList = Array.from(studentGroups.values());
  return c.json({ success: true, groups: groupsList });
});

adminRouter.post("/groups", async (c) => {
  const body = await c.req.json();
  const { name, userIds } = body as { name?: string; userIds?: string[] };

  if (!name) {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const groupName = name.trim();
  const members = Array.isArray(userIds)
    ? userIds.map((uid) => uid.toUpperCase())
    : [];

  const updatedGroup: Group = {
    name: groupName,
    userIds: members,
  };

  studentGroups.set(groupName, updatedGroup);

  if (members.length > 0) {
    await syncGroupWithActiveSessions(groupName, members, []);
  }

  return c.json({
    success: true,
    message: `Group '${groupName}' saved.`,
    group: updatedGroup,
  });
});

// Add students to an existing group
adminRouter.post("/groups/:name/students", async (c) => {
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const group = studentGroups.get(groupName);

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const body = await c.req.json();
  const { studentIds, userIds } = body as { studentIds?: string[]; userIds?: string[] };
  const rawIds = Array.isArray(studentIds) ? studentIds : Array.isArray(userIds) ? userIds : [];

  if (rawIds.length === 0) {
    return c.json({ error: "No student IDs provided." }, 400);
  }

  const newMembersSet = new Set(group.userIds.map((id) => id.toUpperCase()));
  const addedUserIds: string[] = [];

  for (const rawId of rawIds) {
    const upperId = String(rawId).trim().toUpperCase();
    if (upperId && !newMembersSet.has(upperId)) {
      newMembersSet.add(upperId);
      addedUserIds.push(upperId);
    }
  }

  const updatedGroup: Group = {
    name: groupName,
    userIds: Array.from(newMembersSet),
  };

  studentGroups.set(groupName, updatedGroup);

  if (addedUserIds.length > 0) {
    await syncGroupWithActiveSessions(groupName, addedUserIds, []);
  }

  return c.json({
    success: true,
    message: `Added ${addedUserIds.length} student(s) to group '${groupName}'.`,
    group: updatedGroup,
  });
});

// Remove / Kick student from an existing group in real-time
adminRouter.delete("/groups/:name/students/:studentId", async (c) => {
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const studentId = decodeURIComponent(c.req.param("studentId")).trim().toUpperCase();

  const group = studentGroups.get(groupName);
  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const updatedUserIds = group.userIds.filter((id) => id.toUpperCase() !== studentId);
  const updatedGroup: Group = {
    name: groupName,
    userIds: updatedUserIds,
  };

  studentGroups.set(groupName, updatedGroup);

  // Real-time revoke & sync with active sessions
  await syncGroupWithActiveSessions(groupName, [], [studentId]);

  return c.json({
    success: true,
    message: `Removed student ${studentId} from group '${groupName}'.`,
    group: updatedGroup,
  });
});

adminRouter.delete("/groups/:name", async (c) => {
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const group = studentGroups.get(groupName);
  const existed = studentGroups.delete(groupName);

  if (!existed) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  if (group && Array.isArray(group.userIds)) {
    await syncGroupWithActiveSessions(groupName, [], group.userIds);
  }

  return c.json({ success: true, message: `Group '${groupName}' deleted.` });
});

export { adminRouter };
