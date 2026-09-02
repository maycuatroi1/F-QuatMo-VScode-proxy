import { Hono } from "hono";
import {
  checkLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
  getLockedList,
  unlockTarget,
} from "../services/rateLimiter";

export function getClientIP(c: any): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "127.0.0.1";
}
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
  lecturerAccounts,
  studentAccounts,
  sessions,
  sessionStates,
  studentGroups,
  type Session,
  type StudentSessionState,
  type LecturerAccount,
  type Group,
  type StudentAccount,
} from "../services/sessionStore";

const adminRouter = new Hono();

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware protecting Admin data endpoints via PROXY_API_KEY or Admin/Lecturer JWT Token
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
  const authHeader = c.req.header("Authorization");

  let caller: { username: string; role: string; name: string } | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (token === masterKey) {
      caller = { username: "admin", role: "admin", name: "Super Admin" };
    } else {
      try {
        const decoded: any = await verify(token, getJwtSecret(), "HS256" as any);
        if (decoded && (decoded.role || decoded.username)) {
          caller = {
            username: decoded.username || "admin",
            role: decoded.role || "admin",
            name: decoded.name || decoded.username || "Admin",
          };
        }
      } catch {
        // Invalid JWT
      }
    }
  }

  // If no valid JWT token in Authorization header, check x-api-key
  if (!caller) {
    if (xApiKey && xApiKey.trim() === masterKey) {
      caller = { username: "admin", role: "admin", name: "Super Admin" };
    }
  }

  if (caller) {
    c.set("caller", caller);
    await next();
    return;
  }

  return c.json({ error: "Unauthorized. Invalid Proxy API Key" }, 401);
});

// Admin / Lecturer login endpoint validating credentials and returning signed JWT token
adminRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return c.json({ error: "Username and password are required." }, 400);
  }

  const inputUser = username.trim();
  const ip = getClientIP(c);

  // Rate limiter & lockout check
  const lockout = await checkLockout(ip, inputUser);
  if (lockout.isLocked) {
    c.header("Retry-After", String(lockout.remainingSeconds));
    c.header("X-RateLimit-Reset", String(lockout.lockedUntil));
    return c.json(
      {
        error: `Too many failed login attempts. Account/IP temporarily locked for security.`,
        retryAfterSeconds: lockout.remainingSeconds,
        lockedUntil: lockout.lockedUntil,
        reason: lockout.reason,
      },
      429
    );
  }

  const expectedUsername = getAdminUsername();
  const expectedPassword = getAdminPassword();

  // 1. Check Super Admin credentials
  if (inputUser === expectedUsername && password === expectedPassword) {
    await recordSuccessfulLogin(ip, inputUser);
    const jwtSecret = getJwtSecret();
    const payload = {
      username: "admin",
      role: "admin",
      name: "Super Admin",
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days expiration
    };
    const token = await sign(payload, jwtSecret, "HS256" as any);
    return c.json({
      success: true,
      token,
      username: "admin",
      role: "admin",
      name: "Super Admin",
    });
  }

  // 2. Check Lecturer accounts in SQLite
  const lecturer = lecturerAccounts.get(inputUser);
  if (lecturer) {
    if (lecturer.status === "inactive") {
      return c.json({ error: "Your lecturer account has been deactivated." }, 403);
    }

    const isValid = await Bun.password.verify(password, lecturer.passwordHash);
    if (isValid) {
      await recordSuccessfulLogin(ip, inputUser);
      const jwtSecret = getJwtSecret();
      const payload = {
        username: lecturer.username,
        role: "lecturer",
        name: lecturer.name,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days expiration
      };
      const token = await sign(payload, jwtSecret, "HS256" as any);
      return c.json({
        success: true,
        token,
        username: lecturer.username,
        role: "lecturer",
        name: lecturer.name,
      });
    }
  }

  // Failed login attempt
  const result = await recordFailedAttempt(ip, inputUser);
  if (result.isNowLocked && result.lockoutInfo) {
    c.header("Retry-After", String(result.lockoutInfo.remainingSeconds));
    c.header("X-RateLimit-Reset", String(result.lockoutInfo.lockedUntil));
    return c.json(
      {
        error: `Too many failed login attempts. Account/IP temporarily locked for 15 minutes.`,
        retryAfterSeconds: result.lockoutInfo.remainingSeconds,
        lockedUntil: result.lockoutInfo.lockedUntil,
        reason: result.lockoutInfo.reason,
      },
      429
    );
  }

  return c.json(
    {
      error: `Invalid username or password. (Failed attempts: ${result.attemptsCount}/5)`,
      failedAttempts: result.attemptsCount,
      remainingAttempts: Math.max(0, 5 - result.attemptsCount),
    },
    401
  );
});

// ─── SECURITY & AUDIT LOCKOUT ENDPOINTS (Super Admin Only) ───────────────────
adminRouter.get("/security/lockouts", async (c) => {
  const caller = c.get("caller") || { role: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const data = await getLockedList();
  return c.json({ success: true, ...data });
});

adminRouter.post("/security/unlock", async (c) => {
  const caller = c.get("caller") || { role: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const body = await c.req.json();
  const { type, target } = body as { type?: "ip" | "account"; target?: string };

  if (!type || !target) {
    return c.json({ error: "Fields 'type' and 'target' are required." }, 400);
  }

  await unlockTarget(type, target);
  return c.json({
    success: true,
    message: `Lockout cleared for ${type} '${target}'.`,
  });
});

// ─── LECTURER MANAGEMENT ENDPOINTS (Super Admin Only) ─────────────────────────
adminRouter.get("/lecturers", async (c) => {
  const caller = c.get("caller") || { role: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const list = Array.from(lecturerAccounts.values()).map((l) => ({
    username: l.username,
    name: l.name,
    status: l.status,
    createdAt: l.createdAt,
    createdBy: l.createdBy,
    updatedAt: l.updatedAt,
    updatedBy: l.updatedBy,
  }));

  return c.json({ success: true, lecturers: list });
});

adminRouter.get("/lecturers/:username/details", async (c) => {
  const caller = c.get("caller") || { role: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  const lecturerSessions = Array.from(sessions.values())
    .filter((s) => (s.createdBy || "admin").toLowerCase() === targetUser.toLowerCase())
    .map((s) => ({
      sessionCode: s.sessionCode,
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      aiOption: s.aiOption,
      allowedStudentCount: s.allowedStudentIds.size,
      assignedGroups: s.assignedGroups || [],
      createdAt: s.createdAt,
    }));

  const lecturerGroups = Array.from(studentGroups.values())
    .filter((g) => (g.createdBy || "admin").toLowerCase() === targetUser.toLowerCase())
    .map((g) => ({
      name: g.name,
      userCount: g.userIds.length,
      userIds: g.userIds,
      createdAt: g.createdAt,
    }));

  const lecturerStudents: any[] = [];
  for (const acc of studentAccounts.values()) {
    if ((acc.createdBy || "admin").toLowerCase() === targetUser.toLowerCase()) {
      lecturerStudents.push({
        studentId: acc.studentId,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      });
    }
  }

  return c.json({
    success: true,
    lecturer: {
      username: lecturer.username,
      name: lecturer.name,
      status: lecturer.status,
      createdAt: lecturer.createdAt,
      createdBy: lecturer.createdBy,
      updatedAt: lecturer.updatedAt,
      updatedBy: lecturer.updatedBy,
    },
    sessions: lecturerSessions,
    groups: lecturerGroups,
    students: lecturerStudents,
  });
});

adminRouter.post("/lecturers", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const body = await c.req.json();
  const { username, password, name } = body as {
    username?: string;
    password?: string;
    name?: string;
  };

  if (!username || !password || !name) {
    return c.json(
      { error: "Missing required fields: username, password, name" },
      400,
    );
  }

  const cleanUser = username.trim();
  if (lecturerAccounts.has(cleanUser) || cleanUser === getAdminUsername()) {
    return c.json({ error: `Account with username '${cleanUser}' already exists.` }, 400);
  }

  const passwordHash = await Bun.password.hash(password, "bcrypt");
  const now = Date.now();
  const newLecturer: LecturerAccount = {
    username: cleanUser,
    name: name.trim(),
    passwordHash,
    status: "active",
    createdAt: now,
    createdBy: caller.username,
    updatedAt: now,
    updatedBy: caller.username,
  };

  lecturerAccounts.set(cleanUser, newLecturer);

  return c.json({
    success: true,
    message: `Lecturer '${cleanUser}' created successfully.`,
    lecturer: {
      username: newLecturer.username,
      name: newLecturer.name,
      status: newLecturer.status,
      createdAt: newLecturer.createdAt,
      createdBy: newLecturer.createdBy,
      updatedAt: newLecturer.updatedAt,
      updatedBy: newLecturer.updatedBy,
    },
  });
});

adminRouter.patch("/lecturers/:username/status", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  const body = await c.req.json();
  const { status } = body as { status?: "active" | "inactive" };
  const newStatus = status || (lecturer.status === "active" ? "inactive" : "active");

  lecturer.status = newStatus;
  lecturer.updatedAt = Date.now();
  lecturer.updatedBy = caller.username;

  lecturerAccounts.set(targetUser, lecturer);

  return c.json({
    success: true,
    message: `Lecturer '${targetUser}' status updated to ${newStatus}.`,
    lecturer: {
      username: lecturer.username,
      name: lecturer.name,
      status: lecturer.status,
      createdAt: lecturer.createdAt,
      createdBy: lecturer.createdBy,
      updatedAt: lecturer.updatedAt,
      updatedBy: lecturer.updatedBy,
    },
  });
});

adminRouter.post("/lecturers/:username/reset-password", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {}

  const randomPassword = String(Math.floor(100000 + Math.random() * 900000));
  const newPassword = body?.newPassword?.trim() || randomPassword;

  const passwordHash = await Bun.password.hash(newPassword, "bcrypt");
  lecturer.passwordHash = passwordHash;
  lecturer.updatedAt = Date.now();
  lecturer.updatedBy = caller.username;

  lecturerAccounts.set(targetUser, lecturer);

  return c.json({
    success: true,
    message: `Password for lecturer '${targetUser}' reset successfully.`,
    newPassword,
  });
});

// Self-service change password for logged-in Lecturer / Admin
adminRouter.post("/change-password", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const body = await c.req.json();
  const { currentPassword, newPassword } = body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword || !newPassword.trim()) {
    return c.json(
      { error: "Fields 'currentPassword' and 'newPassword' are required." },
      400,
    );
  }

  if (caller.role === "admin") {
    const expectedPassword = getAdminPassword();
    if (currentPassword !== expectedPassword) {
      return c.json({ error: "Incorrect current password." }, 400);
    }
    process.env.ADMIN_PASSWORD = newPassword.trim();
    return c.json({
      success: true,
      message: "Super Admin password updated successfully.",
    });
  }

  if (caller.role === "lecturer") {
    const lecturer = lecturerAccounts.get(caller.username);
    if (!lecturer) {
      return c.json({ error: "Lecturer account not found." }, 404);
    }

    const isValid = await Bun.password.verify(currentPassword, lecturer.passwordHash);
    if (!isValid) {
      return c.json({ error: "Incorrect current password." }, 400);
    }

    const newHash = await Bun.password.hash(newPassword.trim(), "bcrypt");
    lecturer.passwordHash = newHash;
    lecturer.updatedAt = Date.now();
    lecturer.updatedBy = caller.username;

    lecturerAccounts.set(caller.username, lecturer);

    return c.json({
      success: true,
      message: "Password updated successfully.",
    });
  }

  return c.json({ error: "Unauthorized." }, 401);
});

// ─── STUDENT ACCOUNT ENDPOINTS ────────────────────────────────────────────────
adminRouter.post("/students/:studentId/reset-password", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const rawId = decodeURIComponent(c.req.param("studentId")).trim();
  if (!rawId) {
    return c.json({ error: "Student ID is required." }, 400);
  }

  const studentId = rawId.toUpperCase();
  const body = await c.req.json();
  const { newPassword } = body as { newPassword?: string };

  if (!newPassword || !newPassword.trim()) {
    return c.json({ error: "Field 'newPassword' is required." }, 400);
  }

  const passwordHash = await Bun.password.hash(newPassword.trim(), "bcrypt");
  const creator = caller.username || "admin";
  const now = Date.now();

  const mapKey = `${studentId}:${creator.toLowerCase()}`;
  const existing = studentAccounts.get(mapKey);

  studentAccounts.set(mapKey, {
    studentId,
    passwordHash,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || creator,
    updatedAt: now,
    updatedBy: caller.username,
  });

  return c.json({
    success: true,
    message: `Password for student ${studentId} updated successfully.`,
  });
});

const handleStudentImport = async (c: any) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
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
  const now = Date.now();
  const creator = caller.username || "admin";
  const promises = students.map(async (stu) => {
    if (!stu.studentId || !stu.password) return;
    const passwordHash = await Bun.password.hash(stu.password, "bcrypt");
    const stuId = stu.studentId.toUpperCase();
    const mapKey = `${stuId}:${creator.toLowerCase()}`;
    const existing = studentAccounts.get(mapKey);

    studentAccounts.set(mapKey, {
      studentId: stuId,
      passwordHash,
      createdAt: existing?.createdAt || now,
      createdBy: existing?.createdBy || creator,
      updatedAt: now,
      updatedBy: caller.username,
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
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const list: any[] = [];
  for (const account of studentAccounts.values()) {
    const creator = account.createdBy || "admin";
    if (creator !== caller.username) {
      continue;
    }
    list.push({
      studentId: account.studentId,
      createdAt: account.createdAt,
      createdBy: account.createdBy || "admin",
      updatedAt: account.updatedAt,
      updatedBy: account.updatedBy || "admin",
    });
  }
  return c.json({ success: true, students: list });
});

// ─── SESSION ENDPOINTS ───────────────────────────────────────────────────────
adminRouter.post("/sessions", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
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
          const upperId = uid.toUpperCase();
          const mapKey = `${upperId}:${caller.username.toLowerCase()}`;
          if (studentAccounts.has(mapKey)) {
            allowedStudentIds.add(upperId);
          }
        }
      }
    }
  }

  const now = Date.now();
  const newSession: Session = {
    sessionCode,
    startTime: Math.floor(now / 1000),
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    allowedStudentIds,
    assignedGroups: groupNames,
    createdAt: now,
    createdBy: caller.username,
    updatedAt: now,
    updatedBy: caller.username,
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
  const caller = c.get("caller") || { role: "admin", username: "admin" };
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
    const mapKey = `${id}:${caller.username.toLowerCase()}`;
    if (!studentAccounts.has(mapKey)) {
      continue;
    }
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

  session.updatedAt = Date.now();
  session.updatedBy = caller.username;
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
  const caller = c.get("caller") || { role: "admin", username: "admin" };

  const allSessions = Array.from(sessions.values());
  const scopedSessions = caller.role === "lecturer"
    ? allSessions.filter((s) => (s.createdBy || "admin") === caller.username)
    : allSessions;

  const sessionPromises = scopedSessions.map(async (session) => {
    const code = session.sessionCode;
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
          } catch (err) {
            // Redis error fallback to SQLite state
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
      createdBy: session.createdBy || "admin",
      updatedAt: session.updatedAt || session.createdAt || Date.now(),
      updatedBy: session.updatedBy || "admin",
      students: studentStates,
    };
  });

  const sessionList = await Promise.all(sessionPromises);
  return c.json({ success: true, sessions: sessionList });
});

// ─── LOG DOWNLOAD ENDPOINTS ──────────────────────────────────────────────────
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
    return c.json(
      { error: `No logs directory found for session ${sessionCode}.` },
      404,
    );
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
            const fileContent = await fs.promises.readFile(entryFullPath, "utf-8");

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

            const zipPath = entryRelativePath.replace(/\\/g, "/");
            zip.addFile(`${zipPath}.enc`, encryptedBuffer);
            addedFilesCount++;
          }
        }
      }
    }

    await walkAndEncrypt(sessionLogDir);

    if (addedFilesCount === 0) {
      return c.json(
        { error: `No log files found for session ${sessionCode}.` },
        404,
      );
    }

    const zipBuffer = zip.toBuffer();

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename=session-${sessionCode}-logs.zip`,
    );
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(`[Admin] Failed to zip logs for session ${sessionCode}:`, err);
    return c.json({ error: `Failed to create ZIP: ${err.message}` }, 500);
  }
});

adminRouter.get("/sessions/:sessionCode/logs", async (c) => {
  return adminRouter.fetch(
    new Request(
      c.req.url.replace(
        `/sessions/${c.req.param("sessionCode")}/logs`,
        `/sessions/${c.req.param("sessionCode")}/logs/zip`,
      ),
      c.req.raw,
    ),
  );
});

adminRouter.get("/logs/download-machine-logs", async (c) => {
  const machineLogDir = path.resolve(process.cwd(), "logs", "machines");
  if (!fs.existsSync(machineLogDir)) {
    return c.json({ error: "No machine logs found." }, 404);
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
            const fileContent = await fs.promises.readFile(entryFullPath, "utf-8");

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

            const zipPath = entryRelativePath.replace(/\\/g, "/");
            zip.addFile(`${zipPath}.enc`, encryptedBuffer);
            addedFilesCount++;
          }
        }
      }
    }

    await walkAndEncrypt(machineLogDir);

    if (addedFilesCount === 0) {
      return c.json({ error: "No machine log files found." }, 404);
    }

    const zipBuffer = zip.toBuffer();

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename=machine-logs.zip`,
    );
    return c.body(zipBuffer);
  } catch (err: any) {
    console.error(`[Admin] Failed to zip logs for machines:`, err);
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

// ─── GROUP ENDPOINTS ─────────────────────────────────────────────────────────
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
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const groupsList = Array.from(studentGroups.values()).filter((g) => {
    return (g.createdBy || "admin") === caller.username;
  });

  return c.json({ success: true, groups: groupsList });
});

adminRouter.post("/groups", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const body = await c.req.json();
  const { name, userIds } = body as { name?: string; userIds?: string[] };

  if (!name) {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const groupName = name.trim();
  const members = Array.isArray(userIds)
    ? userIds.map((uid) => uid.toUpperCase())
    : [];

  const now = Date.now();
  const existing = studentGroups.get(groupName);

  const updatedGroup: Group = {
    name: groupName,
    userIds: members,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || caller.username,
    updatedAt: now,
    updatedBy: caller.username,
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

adminRouter.post("/groups/:name/students", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
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

  const now = Date.now();
  const updatedGroup: Group = {
    ...group,
    userIds: Array.from(newMembersSet),
    updatedAt: now,
    updatedBy: caller.username,
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

adminRouter.delete("/groups/:name/students/:studentId", async (c) => {
  const caller = c.get("caller") || { role: "admin", username: "admin" };
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const studentId = decodeURIComponent(c.req.param("studentId")).trim().toUpperCase();

  const group = studentGroups.get(groupName);
  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const updatedUserIds = group.userIds.filter((id) => id.toUpperCase() !== studentId);
  const now = Date.now();
  const updatedGroup: Group = {
    ...group,
    userIds: updatedUserIds,
    updatedAt: now,
    updatedBy: caller.username,
  };

  studentGroups.set(groupName, updatedGroup);
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
