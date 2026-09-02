import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import {
  studentAccounts,
  getStudentAccount,
  findValidStudentAccount,
} from "../services/sessionStore";
import {
  checkLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
} from "../services/rateLimiter";
import { getClientIP } from "./admin";

declare const Bun: any;

const authRouter = new Hono();

// POST /auth/login — Global account login (studentId + password only, no session required)
authRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const { studentId: rawStudentId, password } = body as {
    studentId?: string;
    password?: string;
  };

  if (!rawStudentId || !password) {
    return c.json(
      { error: "Missing required fields: studentId, password" },
      400,
    );
  }

  const studentId = rawStudentId.trim().toUpperCase();
  const ip = getClientIP(c);

  const lockout = await checkLockout(ip, studentId);
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

  const validAccount = await findValidStudentAccount(studentId, password);

  if (!validAccount) {
    const hasAnyAccount = Array.from(studentAccounts.values()).some(
      (a) => a.studentId.toUpperCase() === studentId,
    );
    if (hasAnyAccount) {
      const result = await recordFailedAttempt(ip, studentId);
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
          error: `Incorrect password. (Failed attempts: ${result.attemptsCount}/10)`,
          failedAttempts: result.attemptsCount,
          remainingAttempts: Math.max(0, 10 - result.attemptsCount),
        },
        403
      );
    }
    return c.json({ error: "Student account does not exist." }, 403);
  }

  await recordSuccessfulLogin(ip, studentId);

  const jwtSecret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);

  // User token: valid for 7 days (persistent login)
  const exp = now + 7 * 24 * 60 * 60;
  const payload = {
    studentId: validAccount.studentId,
    createdBy: validAccount.createdBy || "admin",
    type: "user",
    iat: now,
    exp,
  };

  const token = await sign(payload, jwtSecret, "HS256" as any);

  return c.json({
    success: true,
    token,
    studentId: validAccount.studentId,
  });
});

// GET /auth/me — Verify user token and return account info
authRouter.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const jwtSecret = getJwtSecret();

  let payload: any;
  try {
    payload = await verify(token, jwtSecret, "HS256" as any);
  } catch {
    return c.json({ error: "Invalid or expired token." }, 401);
  }

  if (payload.type !== "user") {
    return c.json({ error: "Token is not a valid user token." }, 401);
  }

  const account = getStudentAccount(payload.studentId);
  if (!account) {
    return c.json({ error: "Account no longer exists." }, 404);
  }

  return c.json({
    success: true,
    studentId: account.studentId,
  });
});

export { authRouter };
