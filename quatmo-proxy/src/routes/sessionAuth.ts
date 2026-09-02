import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { redis } from "../services/redis";
import { getJwtSecret } from "../services/jwtKey";

declare const Bun: any;
import {
  studentAccounts,
  sessions,
  sessionStates,
  type StudentSessionState,
} from "../services/sessionStore";

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

const sessionAuthRouter = new Hono();

sessionAuthRouter.get("/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const jwtSecret = getJwtSecret();
  let payload: any;
  try {
    payload = await verify(token, jwtSecret, "HS256" as any);
  } catch (err) {
    return c.json({ error: "Invalid or expired token." }, 401);
  }

  const { studentId, sessionCode } = payload;
  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);
  if (!state) {
    return c.json(
      { error: "Student session state not found." },
      404,
    );
  }

  let consumed = state.tokensConsumed;
  if (redis && redis.status === "ready") {
    try {
      const val = await redis.hget(
        `session:user:${sessionCode}:${studentId}`,
        "consumed",
      );
      if (val !== null) {
        consumed = parseInt(val, 10);
      }
    } catch {
      // fallback
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime =
    session.durationMinutes === -1
      ? session.startTime + 24 * 60 * 60
      : session.startTime + session.durationMinutes * 60;
  const aiExpirationTime =
    session.aiValidityMinutes === -1
      ? payload.loginTime + 24 * 60 * 60
      : payload.loginTime + session.aiValidityMinutes * 60;
  const sessionRemainingSeconds = Math.max(0, sessionEndTime - now);
  const aiRemainingSeconds = Math.max(0, aiExpirationTime - now);

  return c.json({
    success: true,
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    tokenBudget: session.defaultTokenBudget,
    tokensConsumed: consumed,
    tokensRemaining: Math.max(0, session.defaultTokenBudget - consumed),
    sessionRemainingMinutes:
      session.durationMinutes === -1
        ? -1
        : Math.ceil(sessionRemainingSeconds / 60),
    aiRemainingMinutes:
      session.aiValidityMinutes === -1
        ? -1
        : Math.ceil(aiRemainingSeconds / 60),
  });
});

sessionAuthRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let {
    sessionCode: rawSessionCode,
    studentId: rawStudentId,
    password,
  } = body as {
    sessionCode?: string;
    studentId?: string;
    password?: string;
  };

  const authHeader = c.req.header("Authorization");
  let bearerStudentId: string | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    try {
      const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
      if (payload && payload.studentId) {
        bearerStudentId = payload.studentId;
      }
    } catch {
      // Invalid Bearer token
    }
  }

  const studentId = (rawStudentId || bearerStudentId || "")
    .trim()
    .toUpperCase();
  const sessionCode = (rawSessionCode || "").trim().toUpperCase();

  if (!sessionCode) {
    return c.json({ error: "Missing required field: sessionCode" }, 400);
  }

  if (!studentId) {
    return c.json(
      { error: "Missing Student ID. Please log in with your FPT Student Account first." },
      400,
    );
  }

  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const existingState = sessionStates.get(stateKey);

  if (!session.allowedStudentIds.has(studentId) && !existingState) {
    return c.json(
      {
        error:
          "You are not allowed to join this session. Please contact your instructor for assistance.",
      },
      403,
    );
  }

  if (!session.allowedStudentIds.has(studentId) && existingState) {
    session.allowedStudentIds.add(studentId);
    sessions.set(sessionCode, session);
  }

  const account = studentAccounts.get(studentId);
  if (!account) {
    return c.json(
      { error: "Your student account does not exist on the system." },
      403,
    );
  }

  if (!bearerStudentId) {
    if (!password) {
      return c.json({ error: "Missing required fields: password" }, 400);
    }
    const isPasswordValid = await Bun.password.verify(
      password,
      account.passwordHash,
    );
    if (!isPasswordValid) {
      return c.json({ error: "Password is incorrect." }, 403);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime =
    session.durationMinutes === -1
      ? session.startTime + 24 * 60 * 60
      : session.startTime + session.durationMinutes * 60;
  const remainingSeconds = sessionEndTime - now;

  if (remainingSeconds <= 0) {
    return c.json({ error: "Session has ended." }, 403);
  }

  let state = existingState;
  if (!state) {
    state = {
      sessionCode,
      studentId,
      hasLoggedIn: false,
      loginTimestamp: 0,
      tokensConsumed: 0,
      reassigned: false,
    };
    sessionStates.set(stateKey, state);
  }

  if (state.hasLoggedIn && !state.reassigned) {
    return c.json(
      {
        error:
          "Your account is currently logged in on another device. Please contact your instructor or system administrator to reset.",
      },
      403,
    );
  }

  state.hasLoggedIn = true;
  if (!state.loginTimestamp || state.loginTimestamp === 0) {
    state.loginTimestamp = now;
  }
  state.reassigned = false;

  if (redis && redis.status === "ready") {
    try {
      const redisKey = `session:user:${sessionCode}:${studentId}`;
      await redis.hset(redisKey, {
        budget: String(session.defaultTokenBudget),
        consumed: String(state.tokensConsumed),
        loginTime: String(state.loginTimestamp),
      });
      await redis.expire(redisKey, remainingSeconds);
    } catch (err) {
      console.error(
        `[Auth] Failed to set Redis session for student ${studentId}:`,
        err,
      );
      return c.json(
        { error: "Failed to connect to RAM database (Redis)." },
        500,
      );
    }
  } else {
    console.warn(
      "[Auth] Redis is offline. Running session check from RAM only.",
    );
  }

  const jwtSecret = getJwtSecret();
  const payload = {
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    aiValidityMinutes: session.aiValidityMinutes,
    loginTime: state.loginTimestamp,
    sessionEndTime,
    exp: sessionEndTime,
  };

  const token = await sign(payload, jwtSecret);

  return c.json({
    success: true,
    token,
    studentId,
    sessionCode,
  });
});

sessionAuthRouter.post("/upload-logs", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  let tokenPayload: any;
  try {
    tokenPayload = await verify(token, getJwtSecret(), "HS256" as any);
  } catch {
    return c.json({ error: "Token expired or invalid" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const sessionCode = (body.sessionCode || tokenPayload.sessionCode || "").trim().toUpperCase();
  const studentId = (body.studentId || tokenPayload.studentId || "").trim().toUpperCase();
  const files: Array<{ relativePath: string; content: string; encoding?: string }> = body.files || [];

  if (!sessionCode || !studentId) {
    return c.json({ error: "Missing required sessionCode or studentId" }, 400);
  }

  const targetDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sanitizeFilename(sessionCode),
    sanitizeFilename(studentId),
  );

  // Overwrite existing folder if it exists
  if (fs.existsSync(targetDir)) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* ignore removal error if locked */
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });

  let savedCount = 0;
  for (const file of files) {
    if (!file.relativePath || file.content === undefined) {
      continue;
    }
    const safeRelPath = path.normalize(file.relativePath).replace(/^(\.\.[\/\\])+/, "");
    const destPath = path.join(targetDir, safeRelPath);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (file.encoding === "base64") {
      const buffer = Buffer.from(file.content, "base64");
      fs.writeFileSync(destPath, buffer);
    } else {
      fs.writeFileSync(destPath, file.content, "utf-8");
    }
    savedCount++;
  }

  const metaPath = path.join(targetDir, "upload_info.json");
  const metaData = {
    studentId,
    sessionCode,
    uploadTimestamp: Math.floor(Date.now() / 1000),
    uploadTimeISO: new Date().toISOString(),
    filesUploaded: savedCount,
    ip: c.req.header("x-forwarded-for") || "local",
  };
  fs.writeFileSync(metaPath, JSON.stringify(metaData, null, 2), "utf-8");

  console.log(`[Logs] Uploaded ${savedCount} monitoring log file(s) for student ${studentId} in session ${sessionCode}`);

  return c.json({
    success: true,
    message: `Successfully uploaded ${savedCount} monitoring log file(s).`,
    sessionCode,
    studentId,
    savedCount,
  });
});

export { sessionAuthRouter };
