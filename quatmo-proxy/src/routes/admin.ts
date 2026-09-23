import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getTrustedClientIP, readZipTextEntriesSafely, safeEqual } from "../services/security";
import {
  checkLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
  getLockedList,
  unlockTarget,
} from "../services/rateLimiter";

export function getClientIP(c: any): string {
  return getTrustedClientIP((n) => c.req.header(n));
}
import { getProxyApiKey } from "../services/proxyKey";
import {
  getAdminUsername,
  getAdminPassword,
} from "../services/adminCredentials";
import { redis } from "../services/redis";
import { redisStore } from "../services/classifier/redisStore";
import { sign, verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { s3Storage } from "../services/s3Storage";

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
  type SessionRuntimeConfig,
  type SessionPromptMode,
} from "../services/sessionStore";

type AdminVariables = {
  caller?: { username: string; role: string; name: string };
};

const adminRouter = new Hono<{ Variables: AdminVariables }>();

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware protecting Admin data endpoints via PROXY_API_KEY or Admin/Lecturer JWT Token
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_LOGIN_PATHS = new Set(["/admin/login", "/v1/admin/login"]);

/** Returns the authenticated caller or aborts with 401 (never defaults to admin). */
function requireCaller(c: any): { username: string; role: string; name: string } {
  const caller = c.get("caller");
  if (!caller || !caller.role || !caller.username) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  return caller;
}

adminRouter.use("*", async (c, next) => {
  // Only the exact login routes are public. Never match on the raw URL/query string
  // (e.g. "/admin/lecturers?x=/login" used to bypass authentication).
  if (c.req.method === "OPTIONS" || ADMIN_LOGIN_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const masterKey = getProxyApiKey();
  const xApiKey = (c.req.header("x-api-key") || "").trim();
  const authHeader = c.req.header("Authorization");

  if (xApiKey && !safeEqual(xApiKey, masterKey)) {
    return c.json({ error: "Unauthorized. Invalid Proxy API Key" }, 401);
  }

  let caller: { username: string; role: string; name: string } | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (safeEqual(token, masterKey)) {
      caller = { username: "admin", role: "admin", name: "Super Admin" };
    } else {
      try {
        const decoded: any = await verify(
          token,
          getJwtSecret(),
          "HS256" as any,
        );
        // Only tokens minted by /admin/login are accepted: explicit role + username,
        // and never student/session tokens (which share the same signing secret).
        if (
          decoded &&
          (decoded.role === "admin" || decoded.role === "lecturer") &&
          typeof decoded.username === "string" &&
          decoded.username &&
          !decoded.studentId &&
          !decoded.sessionCode
        ) {
          if (decoded.role === "lecturer") {
            const lec = lecturerAccounts.get(decoded.username);
            if (!lec || lec.status === "inactive") {
              return c.json(
                { error: "Lecturer account is inactive or no longer exists." },
                401,
              );
            }
          }
          caller = {
            username: decoded.username,
            role: decoded.role,
            name: decoded.name || decoded.username,
          };
        }
      } catch {
        // JWT verification failed
      }

      // A Bearer token was present but invalid or expired.
      // NEVER fall back to admin identity via x-api-key when a token was provided —
      // this would silently promote a lecturer's expired session into admin and corrupt
      // data isolation (createdBy field gets stamped as "admin" instead of the lecturer).
      if (!caller) {
        return c.json(
          {
            error:
              "Unauthorized. Session expired or invalid token. Please sign in again.",
          },
          401,
        );
      }
    }
  } else if (xApiKey && safeEqual(xApiKey, masterKey)) {
    // Pure API-key-only access (no Bearer token): for server-to-server scripts or curl.
    caller = { username: "admin", role: "admin", name: "Super Admin" };
  }

  if (caller) {
    c.set("caller", caller);
    await next();
    return;
  }

  return c.json({ error: "Unauthorized. Invalid Token or Proxy API Key" }, 401);
});

// ─── Role / ownership guards ─────────────────────────────────────────────────
const requireSuperAdmin = async (c: any, next: any) => {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }
  await next();
};

/** Lecturers may only touch sessions they created; super admin may touch all. */
const requireSessionOwner = async (c: any, next: any) => {
  const caller = requireCaller(c);
  if (caller.role === "admin") {
    await next();
    return;
  }
  const code = String(c.req.param("sessionCode") || "").toUpperCase();
  const session = sessions.get(code);
  const owner = (session?.createdBy || "admin").toLowerCase();
  if (!session || owner !== caller.username.toLowerCase()) {
    return c.json({ error: "Forbidden. You do not own this session." }, 403);
  }
  await next();
};

adminRouter.use("/sessions/:sessionCode", requireSessionOwner);
adminRouter.use("/sessions/:sessionCode/*", requireSessionOwner);
adminRouter.use("/visualize/sessions/:sessionCode/*", requireSessionOwner);
adminRouter.use("/logs/*", requireSuperAdmin);
adminRouter.use("/guests/*", requireSuperAdmin);
adminRouter.use("/visualize/guests", requireSuperAdmin);
adminRouter.use("/visualize/guests/*", requireSuperAdmin);
adminRouter.use("/s3/*", requireSuperAdmin);
adminRouter.use("/security/*", requireSuperAdmin);

// Admin / Lecturer login endpoint validating credentials and returning signed JWT token
adminRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body as {
    username?: string;
    password?: string;
  };

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
      429,
    );
  }

  const expectedUsername = getAdminUsername();
  const expectedPassword = getAdminPassword();

  // 1. Check Super Admin credentials
  if (safeEqual(inputUser, expectedUsername) && safeEqual(password, expectedPassword)) {
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
      return c.json(
        { error: "Your lecturer account has been deactivated." },
        403,
      );
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
      429,
    );
  }

  return c.json(
    {
      error: `Invalid username or password. (Failed attempts: ${result.attemptsCount}/10)`,
      failedAttempts: result.attemptsCount,
      remainingAttempts: Math.max(0, 10 - result.attemptsCount),
    },
    401,
  );
});

// ─── SECURITY & AUDIT LOCKOUT ENDPOINTS (Super Admin Only) ───────────────────
adminRouter.get("/security/lockouts", async (c) => {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const data = await getLockedList();
  return c.json({ success: true, ...data });
});

adminRouter.post("/security/unlock", async (c) => {
  const caller = requireCaller(c);
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
  const caller = requireCaller(c);
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
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  const lecturerSessions = Array.from(sessions.values())
    .filter(
      (s) =>
        (s.createdBy || "admin").toLowerCase() === targetUser.toLowerCase(),
    )
    .map((s) => ({
      sessionCode: s.sessionCode,
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      aiOption: s.aiOption,
      allowedStudentCount: s.allowedStudentIds.size,
      assignedGroups: s.assignedGroups || [],
      sessionType: s.sessionType || "basic",
      sessionPrompt: s.sessionPrompt || "",
      examQuestions: s.examQuestions || [],
      runtimeConfig: s.runtimeConfig,
      createdAt: s.createdAt,
    }));

  const lecturerGroups = Array.from(studentGroups.values())
    .filter(
      (g) =>
        (g.createdBy || "admin").toLowerCase() === targetUser.toLowerCase(),
    )
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
  const caller = requireCaller(c);
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
    return c.json(
      { error: `Account with username '${cleanUser}' already exists.` },
      400,
    );
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
  const caller = requireCaller(c);
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
  const newStatus =
    status || (lecturer.status === "active" ? "inactive" : "active");

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
  const caller = requireCaller(c);
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
  const caller = requireCaller(c);
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

    const isValid = await Bun.password.verify(
      currentPassword,
      lecturer.passwordHash,
    );
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
  const caller = requireCaller(c);
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
  const caller = requireCaller(c);
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
  let skippedCount = 0;
  const now = Date.now();
  const creator = (caller.username || "admin").trim();
  const creatorLower = creator.toLowerCase();
  const seenInBatch = new Set<string>();

  const promises = students.map(async (stu) => {
    if (!stu.studentId || !stu.password) return;
    const stuId = stu.studentId.trim().toUpperCase();
    if (!stuId) return;

    if (seenInBatch.has(stuId)) {
      skippedCount++;
      return;
    }
    seenInBatch.add(stuId);

    const mapKey = `${stuId}:${creatorLower}`;
    const existing = studentAccounts.get(mapKey);

    // Validate in isolated scope: if already exists for this lecturer, skip to prevent duplicates/overwriting
    if (existing) {
      skippedCount++;
      return;
    }

    const passwordHash = await Bun.password.hash(stu.password, "bcrypt");
    studentAccounts.set(mapKey, {
      studentId: stuId,
      passwordHash,
      createdAt: now,
      createdBy: creator,
      updatedAt: now,
      updatedBy: caller.username || creator,
    });
    importedCount++;
  });
  await Promise.all(promises);

  let message = `Imported ${importedCount} student account(s).`;
  if (skippedCount > 0) {
    message += ` (${skippedCount} already existed and were skipped)`;
  }

  return c.json({
    success: true,
    message,
    importedCount,
    skippedCount,
  });
};

adminRouter.post("/students", handleStudentImport);
adminRouter.post("/students/import", handleStudentImport);

adminRouter.get("/students", async (c) => {
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();
  const list: any[] = [];
  for (const account of studentAccounts.values()) {
    const creator = (account.createdBy || "admin").toLowerCase();
    if (callerRole !== "admin" && creator !== callerUser) {
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
  const caller = requireCaller(c);
  const body = await c.req.json();
  const {
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    assignedGroups,
    sessionType,
    sessionPrompt,
    promptMode,
    examQuestions,
    runtimeConfig,
  } = body as {
    durationMinutes?: number;
    aiOption?: "chatbot" | "agent" | "none";
    aiValidityMinutes?: number;
    defaultTokenBudget?: number;
    assignedGroups?: string[];
    sessionType?: "basic" | "exam";
    sessionPrompt?: string;
    promptMode?: SessionPromptMode;
    examQuestions?: any[];
    runtimeConfig?: SessionRuntimeConfig;
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

  const validPromptModes: SessionPromptMode[] = [
    "standard",
    "scaffolded_code",
    "socratic_tutor",
  ];
  const validatedPromptMode: SessionPromptMode =
    promptMode && validPromptModes.includes(promptMode)
      ? promptMode
      : "scaffolded_code";

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

      const groupKey = `${groupName}:${caller.username.toLowerCase()}`;
      let group = studentGroups.get(groupKey);
      if (!group) {
        group = studentGroups.get(`${groupName}:admin`);
      }
      if (!group) {
        for (const g of studentGroups.values()) {
          if (
            g.name.toLowerCase() === groupName.toLowerCase() &&
            (g.createdBy || "admin").toLowerCase() ===
              caller.username.toLowerCase()
          ) {
            group = g;
            break;
          }
        }
      }
      if (!group) {
        for (const g of studentGroups.values()) {
          if (g.name.toLowerCase() === groupName.toLowerCase()) {
            group = g;
            break;
          }
        }
      }

      if (group && Array.isArray(group.userIds)) {
        for (const uid of group.userIds) {
          const upperId = uid.toUpperCase();
          allowedStudentIds.add(upperId);
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
    sessionType: sessionType || "basic",
    sessionPrompt: sessionPrompt || "",
    promptMode: validatedPromptMode,
    examQuestions: Array.isArray(examQuestions) ? examQuestions : [],
    runtimeConfig:
      runtimeConfig && typeof runtimeConfig === "object"
        ? runtimeConfig
        : undefined,
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

adminRouter.patch("/sessions/:sessionCode", async (c) => {
  const caller = requireCaller(c);
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  const body = await c.req.json();
  const {
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    sessionType,
    sessionPrompt,
    promptMode,
    examQuestions,
    runtimeConfig,
    assignedGroups,
    createdBy,
  } = body as any;

  if (typeof durationMinutes === "number")
    session.durationMinutes = durationMinutes;
  if (
    typeof aiOption === "string" &&
    ["chatbot", "agent", "none"].includes(aiOption)
  )
    session.aiOption = aiOption as "chatbot" | "agent" | "none";
  if (typeof aiValidityMinutes === "number")
    session.aiValidityMinutes = aiValidityMinutes;
  if (typeof defaultTokenBudget === "number")
    session.defaultTokenBudget = defaultTokenBudget;
  if (sessionType === "basic" || sessionType === "exam")
    session.sessionType = sessionType;
  if (typeof sessionPrompt === "string") session.sessionPrompt = sessionPrompt;
  if (
    promptMode &&
    ["standard", "scaffolded_code", "socratic_tutor"].includes(promptMode)
  ) {
    session.promptMode = promptMode as SessionPromptMode;
  }
  if (Array.isArray(examQuestions)) session.examQuestions = examQuestions;
  if (Array.isArray(assignedGroups)) session.assignedGroups = assignedGroups;
  if (runtimeConfig && typeof runtimeConfig === "object")
    session.runtimeConfig = runtimeConfig;

  if (
    caller.role === "admin" &&
    typeof createdBy === "string" &&
    createdBy.trim()
  ) {
    session.createdBy = createdBy.trim();
  }

  session.updatedAt = Date.now();
  session.updatedBy = caller.username;
  sessions.set(sessionCode, session);

  return c.json({
    success: true,
    message: `Session ${sessionCode} updated successfully.`,
    session: {
      ...session,
      allowedStudentIds: Array.from(session.allowedStudentIds),
    },
  });
});

adminRouter.post("/sessions/:sessionCode/students", async (c) => {
  const caller = requireCaller(c);
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
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();

  const allSessions = Array.from(sessions.values());
  const scopedSessions = allSessions.filter((s) => {
    if (callerRole === "admin") return true;
    return (s.createdBy || "admin").toLowerCase() === callerUser;
  });

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
      sessionType: session.sessionType || "basic",
      sessionPrompt: session.sessionPrompt || "",
      promptMode: session.promptMode || "scaffolded_code",
      examQuestions: session.examQuestions || [],
      runtimeConfig: session.runtimeConfig,
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

// ─── LOG DOWNLOAD HELPER & ENDPOINTS ──────────────────────────────────────────

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

// 1. Session logs (supports multiple path aliases)
const handleSessionLogDownload = async (c: any) => {
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

  return await sendDirectoryZip(
    sessionLogDir,
    `session-${sessionCode}-logs.zip`,
    c,
    `No logs found for session ${sessionCode}.`,
  );
};

adminRouter.get("/sessions/:sessionCode/logs", handleSessionLogDownload);
adminRouter.get("/sessions/:sessionCode/logs/zip", handleSessionLogDownload);
adminRouter.get(
  "/sessions/:sessionCode/download-logs",
  handleSessionLogDownload,
);

// 2. All logs archive (supports /logs/download-all, /logs/zip, /logs/download)
const handleAllLogsDownload = async (c: any) => {
  const logDir = path.resolve(process.cwd(), "logs");
  return await sendDirectoryZip(
    logDir,
    `all-logs-${Date.now()}.zip`,
    c,
    "No server logs found.",
  );
};

adminRouter.get("/logs/download-all", handleAllLogsDownload);
adminRouter.get("/logs/zip", handleAllLogsDownload);
adminRouter.get("/logs/download", handleAllLogsDownload);

// 3. Guest logs archive
const handleGuestLogsDownload = async (c: any) => {
  const guestLogDir = path.resolve(process.cwd(), "logs", "guests");
  return await sendDirectoryZip(
    guestLogDir,
    `guest-logs-${Date.now()}.zip`,
    c,
    "No guest logs found.",
  );
};

adminRouter.get("/logs/download-guest-logs", handleGuestLogsDownload);
adminRouter.get("/guests/logs/zip", handleGuestLogsDownload);
adminRouter.get("/guests/logs", handleGuestLogsDownload);

// 4. Single student / account log download
adminRouter.get(
  "/sessions/:sessionCode/accounts/:studentId/download",
  async (c) => {
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
      return c.text(content);
    }

    return c.json(
      {
        error: `No logs found for student ${studentId} in session ${sessionCode}.`,
      },
      404,
    );
  },
);

adminRouter.get("/guests/:guestId/download", async (c) => {
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
    return c.text(content);
  }

  return c.json({ error: `No logs found for guest ${guestId}.` }, 404);
});

// ─── VISUALIZE LOGS ENDPOINTS ─────────────────────────────────────────────

// 1. List all sessions with log stats
adminRouter.get("/visualize/sessions", async (c) => {
  const sessionsLogDir = path.resolve(process.cwd(), "logs", "sessions");
  const resultSessions: Array<{
    sessionCode: string;
    sessionName: string;
    promptLogCount: number;
    eventLogCount: number;
    lastActivity: number;
    studentCount: number;
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

        resultSessions.push({
          sessionCode: code,
          sessionName: code,
          promptLogCount,
          eventLogCount,
          lastActivity:
            lastActivity ||
            (sessionObj?.createdAt ? sessionObj.createdAt : Date.now()),
          studentCount: studentIds.size,
        });
      }
    } catch {}
  }

  // Include in-memory sessions that haven't written to disk yet
  for (const [code, sessionObj] of sessions.entries()) {
    if (!scannedCodes.has(code)) {
      scannedCodes.add(code);
      resultSessions.push({
        sessionCode: code,
        sessionName: code,
        promptLogCount: 0,
        eventLogCount: 0,
        lastActivity: sessionObj.createdAt || Date.now(),
        studentCount: sessionObj.allowedStudentIds
          ? sessionObj.allowedStudentIds.size
          : 0,
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
          const lastActivity = Math.max(
            ...students.map((s) => s.lastActivity || 0),
            sessionObj?.createdAt || Date.now(),
          );
          resultSessions.push({
            sessionCode: code,
            sessionName: code,
            promptLogCount,
            eventLogCount,
            lastActivity,
            studentCount:
              students.length || sessionObj?.allowedStudentIds?.size || 0,
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
});

// 2. List accounts for a session
adminRouter.get("/visualize/sessions/:sessionCode/accounts", async (c) => {
  const sessionCode = sanitizeFilename(
    c.req.param("sessionCode"),
  ).toUpperCase();
  const sessionLogDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode,
  );

  const accountMap = new Map<
    string,
    {
      studentId: string;
      hasPromptLog: boolean;
      hasEventLog: boolean;
      promptTurnsCount: number;
      eventCount: number;
      lastActivity: number;
      hasErrors: boolean;
    }
  >();

  if (fs.existsSync(sessionLogDir)) {
    try {
      const entries = await fs.promises.readdir(sessionLogDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const entryPath = path.join(sessionLogDir, entry.name);
        const stat = await fs.promises.stat(entryPath);

        if (entry.isFile() && entry.name.endsWith(".json")) {
          const studentId = entry.name.slice(0, -5);
          let turnsCount = 0;
          let hasErrors = false;
          try {
            const raw = await fs.promises.readFile(entryPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              turnsCount = parsed.length;
              hasErrors = parsed.some((t: any) => !!t.error);
            }
          } catch {}

          const acc = accountMap.get(studentId) || {
            studentId,
            hasPromptLog: false,
            hasEventLog: false,
            promptTurnsCount: 0,
            eventCount: 0,
            lastActivity: stat.mtimeMs,
            hasErrors: false,
          };
          acc.hasPromptLog = true;
          acc.promptTurnsCount = turnsCount;
          acc.hasErrors = acc.hasErrors || hasErrors;
          if (stat.mtimeMs > acc.lastActivity) acc.lastActivity = stat.mtimeMs;
          accountMap.set(studentId, acc);
        } else if (entry.isDirectory()) {
          const studentId = entry.name;
          let totalEvents = 0;
          let foundEvents = false;

          async function findEvents(dir: string) {
            const sub = await fs.promises.readdir(dir, {
              withFileTypes: true,
            });
            for (const s of sub) {
              const full = path.join(dir, s.name);
              if (s.isDirectory()) {
                await findEvents(full);
              } else if (s.name === "events.jsonl") {
                foundEvents = true;
                try {
                  const content = await fs.promises.readFile(full, "utf-8");
                  const lines = content
                    .split("\n")
                    .filter((l) => l.trim().length > 0);
                  totalEvents += lines.length;
                } catch {}
              }
            }
          }
          await findEvents(entryPath);

          const acc = accountMap.get(studentId) || {
            studentId,
            hasPromptLog: false,
            hasEventLog: false,
            promptTurnsCount: 0,
            eventCount: 0,
            lastActivity: stat.mtimeMs,
            hasErrors: false,
          };
          acc.hasEventLog = foundEvents;
          acc.eventCount = totalEvents;
          if (stat.mtimeMs > acc.lastActivity) acc.lastActivity = stat.mtimeMs;
          accountMap.set(studentId, acc);
        }
      }
    } catch {}
  }

  // Include in-memory session students if allowed
  const sessionObj = sessions.get(sessionCode);
  if (sessionObj && sessionObj.allowedStudentIds) {
    for (const sid of sessionObj.allowedStudentIds) {
      if (!accountMap.has(sid)) {
        accountMap.set(sid, {
          studentId: sid,
          hasPromptLog: false,
          hasEventLog: false,
          promptTurnsCount: 0,
          eventCount: 0,
          lastActivity: sessionObj.createdAt || Date.now(),
          hasErrors: false,
        });
      }
    }
  }

  // Include S3 students for this session
  if (s3Storage.isAvailable()) {
    try {
      const s3Students =
        await s3Storage.listStudentsInSessionFromS3(sessionCode);
      for (const s of s3Students) {
        const existing = accountMap.get(s.studentId);
        if (!existing) {
          accountMap.set(s.studentId, {
            studentId: s.studentId,
            hasPromptLog: s.hasPromptLog,
            hasEventLog: s.hasEventLog,
            promptTurnsCount: s.hasPromptLog ? 1 : 0,
            eventCount: s.hasEventLog ? 1 : 0,
            lastActivity: s.lastActivity || Date.now(),
            hasErrors: false,
          });
        } else {
          existing.hasPromptLog = existing.hasPromptLog || s.hasPromptLog;
          existing.hasEventLog = existing.hasEventLog || s.hasEventLog;
          if (s.lastActivity && s.lastActivity > existing.lastActivity) {
            existing.lastActivity = s.lastActivity;
          }
        }
      }
    } catch (err) {
      console.error("[Visualize] S3 students listing error:", err);
    }
  }

  const accounts = Array.from(accountMap.values());
  accounts.sort((a, b) => {
    const aHas = a.hasPromptLog || a.hasEventLog ? 1 : 0;
    const bHas = b.hasPromptLog || b.hasEventLog ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.lastActivity - a.lastActivity;
  });

  return c.json({ sessionCode, accounts });
});

// 3. Get student prompt log
adminRouter.get(
  "/visualize/sessions/:sessionCode/accounts/:studentId/prompt-log",
  async (c) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId"));
    const jsonPath = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      `${studentId}.json`,
    );

    let turns: any[] = [];
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = await fs.promises.readFile(jsonPath, "utf-8");
        const parsed = JSON.parse(raw);
        turns = Array.isArray(parsed) ? parsed : [];
      } catch (err: any) {
        return c.json({ error: `Failed to parse log` }, 500);
      }
    } else {
      const altJsonPath = path.resolve(
        process.cwd(),
        "logs",
        "sessions",
        sessionCode,
        `${studentId.toUpperCase()}.json`,
      );
      if (fs.existsSync(altJsonPath)) {
        try {
          const raw = await fs.promises.readFile(altJsonPath, "utf-8");
          const parsed = JSON.parse(raw);
          turns = Array.isArray(parsed) ? parsed : [];
        } catch {}
      }
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

    // Check .log file
    const logPath = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      `${studentId}.log`,
    );
    if (fs.existsSync(logPath)) {
      try {
        const raw = await fs.promises.readFile(logPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const turns: any[] = [];
        for (const line of lines) {
          try {
            turns.push(JSON.parse(line));
          } catch {}
        }
        return c.json({ sessionCode, studentId, turns });
      } catch (err: any) {
        return c.json({ error: `Failed to read log` }, 500);
      }
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
  },
);

async function loadEventLogFromS3(
  sessionCode: string,
  studentId: string,
  reqRecordId?: string,
) {
  if (!s3Storage.isAvailable()) return null;
  try {
    const s3Records = await s3Storage.listStudentExamRecords(
      sessionCode,
      studentId,
    );
    if (!s3Records || s3Records.length === 0) return null;
    const targetRecordId =
      reqRecordId && s3Records.includes(reqRecordId)
        ? reqRecordId
        : s3Records[0];

    const [eventsRaw, aiRaw, metaRaw, zipBuffer] = await Promise.all([
      s3Storage.getExamRecordArtifact(
        sessionCode,
        studentId,
        targetRecordId,
        "events.jsonl",
      ),
      s3Storage.getExamRecordArtifact(
        sessionCode,
        studentId,
        targetRecordId,
        "ai_interactions.jsonl",
      ),
      s3Storage.getExamRecordArtifact(
        sessionCode,
        studentId,
        targetRecordId,
        "metadata.json",
      ),
      s3Storage.getExamRecordArtifact(
        sessionCode,
        studentId,
        targetRecordId,
        "snapshot_start.zip",
      ),
    ]);

    const coreRecords: any[] = [];
    const aiRecords: any[] = [];
    let metadata: any = null;
    const initialFiles: Record<string, string> = {};

    if (typeof metaRaw === "string") {
      try {
        metadata = JSON.parse(metaRaw);
      } catch {}
    }
    if (typeof eventsRaw === "string") {
      for (const line of eventsRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          coreRecords.push(JSON.parse(trimmed));
        } catch {}
      }
    }
    if (typeof aiRaw === "string") {
      for (const line of aiRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          aiRecords.push(JSON.parse(trimmed));
        } catch {}
      }
    }
    if (Buffer.isBuffer(zipBuffer)) {
      try {
        const zip = new AdmZip(zipBuffer);
        Object.assign(initialFiles, readZipTextEntriesSafely(zip));
      } catch {}
    }

    return {
      sessionCode,
      studentId,
      activeRecordDir: targetRecordId,
      availableRecords: s3Records,
      metadata: metadata || {
        examSessionId: targetRecordId,
        examStartAt: coreRecords[0]?.timestamp || Date.now(),
        examEndAt: coreRecords[coreRecords.length - 1]?.timestamp || Date.now(),
      },
      coreRecords,
      aiRecords,
      initialFiles,
    };
  } catch (err: any) {
    console.error("[Visualize] S3 event log fetch error:", err);
    return null;
  }
}

// 4. Get student event log
adminRouter.get(
  "/visualize/sessions/:sessionCode/accounts/:studentId/event-log",
  async (c) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId"));
    const studentDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      studentId,
    );

    if (!fs.existsSync(studentDir)) {
      // Check S3 if no local student directory
      const s3Result = await loadEventLogFromS3(
        sessionCode,
        studentId,
        c.req.query("recordId"),
      );
      if (s3Result) {
        return c.json(s3Result);
      }

      return c.json({
        sessionCode,
        studentId,
        metadata: null,
        coreRecords: [],
        aiRecords: [],
        availableRecords: [],
        initialFiles: {},
      });
    }

    try {
      const availableRecords: string[] = [];
      let activeRecordDir = studentDir;

      const examRecordsDir = path.join(studentDir, "exam_records");
      if (fs.existsSync(examRecordsDir)) {
        const recEntries = await fs.promises.readdir(examRecordsDir, {
          withFileTypes: true,
        });
        for (const r of recEntries) {
          if (r.isDirectory()) {
            availableRecords.push(r.name);
          }
        }
        if (availableRecords.length > 0) {
          availableRecords.sort().reverse();
          const reqRecordId = c.req.query("recordId");
          const targetRecordId =
            reqRecordId && availableRecords.includes(reqRecordId)
              ? reqRecordId
              : availableRecords[0];
          activeRecordDir = path.join(examRecordsDir, targetRecordId);
        }
      }

      const eventsPath = path.join(activeRecordDir, "events.jsonl");
      const aiPath = path.join(activeRecordDir, "ai_interactions.jsonl");
      const metadataPath = path.join(activeRecordDir, "metadata.json");
      const snapshotZipPath = path.join(activeRecordDir, "snapshot_start.zip");

      const coreRecords: any[] = [];
      const aiRecords: any[] = [];
      let metadata: any = null;
      const initialFiles: Record<string, string> = {};

      if (fs.existsSync(metadataPath)) {
        try {
          const raw = await fs.promises.readFile(metadataPath, "utf-8");
          metadata = JSON.parse(raw);
        } catch {}
      }

      if (fs.existsSync(eventsPath)) {
        try {
          const content = await fs.promises.readFile(eventsPath, "utf-8");
          const lines = content.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              coreRecords.push(JSON.parse(trimmed));
            } catch {}
          }
        } catch {}
      }

      if (fs.existsSync(aiPath)) {
        try {
          const content = await fs.promises.readFile(aiPath, "utf-8");
          const lines = content.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              aiRecords.push(JSON.parse(trimmed));
            } catch {}
          }
        } catch {}
      }

      if (fs.existsSync(snapshotZipPath)) {
        try {
          const zip = new AdmZip(snapshotZipPath);
          Object.assign(initialFiles, readZipTextEntriesSafely(zip));
        } catch {}
      }

      if (
        availableRecords.length === 0 &&
        coreRecords.length === 0 &&
        s3Storage.isAvailable()
      ) {
        const s3Result = await loadEventLogFromS3(
          sessionCode,
          studentId,
          c.req.query("recordId"),
        );
        if (s3Result) {
          return c.json(s3Result);
        }
      }

      return c.json({
        sessionCode,
        studentId,
        activeRecordDir: path.basename(activeRecordDir),
        availableRecords,
        metadata: metadata || {
          examSessionId: path.basename(activeRecordDir),
          examStartAt: coreRecords[0]?.timestamp || Date.now(),
          examEndAt:
            coreRecords[coreRecords.length - 1]?.timestamp || Date.now(),
        },
        coreRecords,
        aiRecords,
        initialFiles,
      });
    } catch (err: any) {
      return c.json({ error: `Failed to load event log` }, 500);
    }
  },
);

// 5. List guest accounts
adminRouter.get("/visualize/guests", async (c) => {
  const guestDirs = [
    path.resolve(process.cwd(), "logs", "guests"),
    path.resolve(process.cwd(), "logs", "machines"),
  ];

  const guestMap = new Map<
    string,
    {
      guestId: string;
      turnsCount: number;
      lastActivity: number;
      hasErrors: boolean;
      filePath: string;
    }
  >();

  for (const gDir of guestDirs) {
    if (!fs.existsSync(gDir)) continue;
    try {
      const entries = await fs.promises.readdir(gDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const entryPath = path.join(gDir, entry.name);
        const stat = await fs.promises.stat(entryPath);
        const isJson = entry.name.endsWith(".json");
        const isLog = entry.name.endsWith(".log");
        if (!isJson && !isLog) continue;

        const guestId = entry.name.replace(/\.(json|log)$/, "");
        let turnsCount = 0;
        let hasErrors = false;

        try {
          const raw = await fs.promises.readFile(entryPath, "utf-8");
          if (isJson) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              turnsCount = parsed.length;
              hasErrors = parsed.some((t: any) => !!t.error);
            }
          } else {
            const lines = raw.split("\n").filter((l) => l.trim().length > 0);
            turnsCount = lines.length;
          }
        } catch {}

        const existing = guestMap.get(guestId);
        if (!existing || stat.mtimeMs > existing.lastActivity) {
          guestMap.set(guestId, {
            guestId,
            turnsCount,
            lastActivity: stat.mtimeMs,
            hasErrors,
            filePath: entryPath,
          });
        }
      }
    } catch {}
  }

  if (s3Storage.isAvailable()) {
    try {
      const s3Guests = await s3Storage.listGuestsFromS3();
      for (const gid of s3Guests) {
        if (!guestMap.has(gid)) {
          guestMap.set(gid, {
            guestId: gid,
            turnsCount: 1,
            lastActivity: Date.now(),
            hasErrors: false,
            filePath: "",
          });
        }
      }
    } catch {}
  }

  const guests = Array.from(guestMap.values()).map((g) => ({
    studentId: g.guestId,
    guestId: g.guestId,
    hasPromptLog: true,
    hasEventLog: false,
    promptTurnsCount: g.turnsCount,
    eventCount: 0,
    lastActivity: g.lastActivity,
    hasErrors: g.hasErrors,
  }));

  guests.sort((a, b) => b.lastActivity - a.lastActivity);

  return c.json({ guests });
});

// 6. Get guest prompt log
adminRouter.get("/visualize/guests/:guestId/prompt-log", async (c) => {
  const guestId = sanitizeFilename(c.req.param("guestId"));
  const guestDirs = [
    path.resolve(process.cwd(), "logs", "guests"),
    path.resolve(process.cwd(), "logs", "machines"),
  ];

  for (const gDir of guestDirs) {
    const jsonPath = path.join(gDir, `${guestId}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = await fs.promises.readFile(jsonPath, "utf-8");
        const turns = JSON.parse(raw);
        return c.json({
          guestId,
          turns: Array.isArray(turns) ? turns : [],
        });
      } catch (err: any) {
        return c.json({ error: `Failed to parse log` }, 500);
      }
    }

    const logPath = path.join(gDir, `${guestId}.log`);
    if (fs.existsSync(logPath)) {
      try {
        const raw = await fs.promises.readFile(logPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const turns: any[] = [];
        for (const line of lines) {
          try {
            turns.push(JSON.parse(line));
          } catch {}
        }
        return c.json({ guestId, turns });
      } catch (err: any) {
        return c.json({ error: `Failed to read log` }, 500);
      }
    }
  }

  // Check S3 if not found locally
  if (s3Storage.isAvailable()) {
    try {
      const s3Turns = await s3Storage.getGuestPromptLog(guestId);
      if (s3Turns && s3Turns.length > 0) {
        return c.json({ guestId, turns: s3Turns });
      }
    } catch {}
  }

  return c.json({ guestId, turns: [] });
});

// 7. Upload full exam record for student / session
adminRouter.post(
  "/visualize/sessions/:sessionCode/accounts/:studentId/upload-record",
  async (c) => {
    const sessionCode = sanitizeFilename(
      c.req.param("sessionCode"),
    ).toUpperCase();
    const studentId = sanitizeFilename(c.req.param("studentId")).toUpperCase();
    const body = await c.req.json().catch(() => null);

    if (!body || !body.recordId) {
      return c.json({ error: "Missing recordId in request payload" }, 400);
    }

    const recordId = sanitizeFilename(body.recordId);
    const { metadata, events, aiInteractions, snapshotZipBase64 } = body;

    const targetDir = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sessionCode,
      studentId,
      "exam_records",
      recordId,
    );
    await fs.promises.mkdir(targetDir, { recursive: true });

    if (metadata) {
      await fs.promises.writeFile(
        path.join(targetDir, "metadata.json"),
        typeof metadata === "string"
          ? metadata
          : JSON.stringify(metadata, null, 2),
        "utf-8",
      );
    }
    if (events) {
      const content = Array.isArray(events)
        ? events.map((e) => JSON.stringify(e)).join("\n")
        : String(events);
      await fs.promises.writeFile(
        path.join(targetDir, "events.jsonl"),
        content,
        "utf-8",
      );
    }
    if (aiInteractions) {
      const content = Array.isArray(aiInteractions)
        ? aiInteractions.map((e) => JSON.stringify(e)).join("\n")
        : String(aiInteractions);
      await fs.promises.writeFile(
        path.join(targetDir, "ai_interactions.jsonl"),
        content,
        "utf-8",
      );
    }
    if (snapshotZipBase64) {
      const buf = Buffer.from(snapshotZipBase64, "base64");
      await fs.promises.writeFile(
        path.join(targetDir, "snapshot_start.zip"),
        buf,
      );
    }

    if (s3Storage.isAvailable()) {
      if (metadata) {
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "metadata.json",
          typeof metadata === "string"
            ? metadata
            : JSON.stringify(metadata, null, 2),
          "application/json",
        );
      }
      if (events) {
        const content = Array.isArray(events)
          ? events.map((e) => JSON.stringify(e)).join("\n")
          : String(events);
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "events.jsonl",
          content,
          "application/x-ndjson",
        );
      }
      if (aiInteractions) {
        const content = Array.isArray(aiInteractions)
          ? aiInteractions.map((e) => JSON.stringify(e)).join("\n")
          : String(aiInteractions);
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "ai_interactions.jsonl",
          content,
          "application/x-ndjson",
        );
      }
      if (snapshotZipBase64) {
        const buf = Buffer.from(snapshotZipBase64, "base64");
        void s3Storage.uploadExamRecordFile(
          sessionCode,
          studentId,
          recordId,
          "snapshot_start.zip",
          buf,
          "application/zip",
        );
      }
    }

    return c.json({ success: true, sessionCode, studentId, recordId });
  },
);

// 8. S3 Storage healthcheck & status
adminRouter.get("/s3/status", async (c) => {
  const isAvailable = s3Storage.isAvailable();
  if (!isAvailable) {
    return c.json({
      status: "unconfigured",
      available: false,
      message: "S3 credentials are not configured in .env",
      endpoint: process.env.S3_ENDPOINT || "https://s3-api.iahn.hanoi.vn",
      bucket: s3Storage.getBucketName(),
    });
  }

  try {
    const sessions = await s3Storage.listSessionsFromS3();
    const guests = await s3Storage.listGuestsFromS3();
    return c.json({
      status: "connected",
      available: true,
      endpoint: process.env.S3_ENDPOINT,
      bucket: s3Storage.getBucketName(),
      totalSessionsOnS3: sessions.length,
      sessions,
      totalGuestsOnS3: guests.length,
      guests,
    });
  } catch (err: any) {
    return c.json(
      {
        status: "error",
        available: false,
        error: err?.message || String(err),
      },
      500,
    );
  }
});

// ─── GROUP ENDPOINTS ─────────────────────────────────────────────────────────
async function syncGroupWithActiveSessions(
  groupName: string,
  createdBy: string,
  addedUserIds: string[] = [],
  removedUserIds: string[] = [],
) {
  const upperAddedIds = addedUserIds.map((id) => id.toUpperCase());
  const upperRemovedIds = removedUserIds.map((id) => id.toUpperCase());
  const nowSec = Math.floor(Date.now() / 1000);

  for (const session of sessions.values()) {
    if (
      !session.assignedGroups ||
      !session.assignedGroups.includes(groupName)
    ) {
      continue;
    }

    if (
      createdBy &&
      createdBy.toLowerCase() !== "admin" &&
      (session.createdBy || "admin").toLowerCase() !== createdBy.toLowerCase()
    ) {
      continue;
    }

    const startSec =
      session.startTime || Math.floor((session.createdAt || Date.now()) / 1000);
    const durationSec =
      session.durationMinutes === -1
        ? 86400 * 30
        : (session.durationMinutes || 60) * 60;
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
          await redis
            .hset(redisKey, {
              studentId: uid,
              sessionCode: session.sessionCode,
              hasLoggedIn: "true",
              tokensConsumed: String(state.tokensConsumed || 0),
              budget: String(session.defaultTokenBudget || 100000000),
              latestClassification: state.latestClassification || "none",
            })
            .catch(() => {});
          await redis.expire(redisKey, remainingSec).catch(() => {});
        }
      }
    }

    for (const uid of upperRemovedIds) {
      let stillBelongsToOtherGroup = false;
      for (const otherGroupName of session.assignedGroups) {
        if (otherGroupName === groupName) continue;
        const otherGroupKey = `${otherGroupName}:${(session.createdBy || "admin").toLowerCase()}`;
        const otherGroup =
          studentGroups.get(otherGroupKey) ||
          studentGroups.get(`${otherGroupName}:admin`);
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
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();
  const groupsList = Array.from(studentGroups.values()).filter((g) => {
    if (callerRole === "admin") return true;
    return (g.createdBy || "admin").toLowerCase() === callerUser;
  });

  return c.json({ success: true, groups: groupsList });
});

adminRouter.post("/groups", async (c) => {
  const caller = requireCaller(c);
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
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  const existing = studentGroups.get(mapKey);

  const updatedGroup: Group = {
    name: groupName,
    userIds: members,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || caller.username,
    updatedAt: now,
    updatedBy: caller.username,
  };

  studentGroups.set(mapKey, updatedGroup);

  if (members.length > 0) {
    await syncGroupWithActiveSessions(groupName, caller.username, members, []);
  }

  return c.json({
    success: true,
    message: `Group '${groupName}' saved.`,
    group: updatedGroup,
  });
});

adminRouter.post("/groups/:name/students", async (c) => {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const body = await c.req.json();
  const { studentIds, userIds } = body as {
    studentIds?: string[];
    userIds?: string[];
  };
  const rawIds = Array.isArray(studentIds)
    ? studentIds
    : Array.isArray(userIds)
      ? userIds
      : [];

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

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  studentGroups.set(targetKey, updatedGroup);

  if (addedUserIds.length > 0) {
    await syncGroupWithActiveSessions(
      group.name,
      group.createdBy || caller.username,
      addedUserIds,
      [],
    );
  }

  return c.json({
    success: true,
    message: `Added ${addedUserIds.length} student(s) to group '${groupName}'.`,
    group: updatedGroup,
  });
});

adminRouter.delete("/groups/:name/students/:studentId", async (c) => {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const studentId = decodeURIComponent(c.req.param("studentId"))
    .trim()
    .toUpperCase();

  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const updatedUserIds = group.userIds.filter(
    (id) => id.toUpperCase() !== studentId,
  );
  const now = Date.now();
  const updatedGroup: Group = {
    ...group,
    userIds: updatedUserIds,
    updatedAt: now,
    updatedBy: caller.username,
  };

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  studentGroups.set(targetKey, updatedGroup);
  await syncGroupWithActiveSessions(
    group.name,
    group.createdBy || caller.username,
    [],
    [studentId],
  );

  return c.json({
    success: true,
    message: `Removed student ${studentId} from group '${groupName}'.`,
    group: updatedGroup,
  });
});

adminRouter.delete("/groups/:name", async (c) => {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  const existed = studentGroups.delete(targetKey);

  if (!existed) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  if (group && Array.isArray(group.userIds)) {
    await syncGroupWithActiveSessions(
      group.name,
      group.createdBy || caller.username,
      [],
      group.userIds,
    );
  }

  return c.json({ success: true, message: `Group '${groupName}' deleted.` });
});

export { adminRouter };
