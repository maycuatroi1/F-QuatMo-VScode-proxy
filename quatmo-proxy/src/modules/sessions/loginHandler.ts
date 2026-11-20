import { sign, verify } from "hono/jwt";
import { sessionEndMs, toMs } from "../../shared/sessionTime";
import { redis } from "../../services/redis";
import { getJwtSecret } from "../../services/jwtKey";
import { studentAccounts, sessions, sessionStates, getStudentAccount, getStudentGroup, verifyPasswordSafely } from "../../services/sessionStore";
import { checkLockout, recordFailedAttempt, recordSuccessfulLogin } from "../../services/rateLimiter";
import { getClientIP } from "../../shared/http/clientIP";
import { evaluateClient, readClientIdentity } from "../../services/clientGate";

export async function loginSession(c: any) {
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
  let bearerCreatedBy: string | undefined;
  let bearerValidLecturers: string[] | undefined;
  let bearerIat: number | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    try {
      const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
      if (payload && payload.studentId) {
        bearerStudentId = payload.studentId;
        bearerCreatedBy = payload.createdBy;
        bearerIat = payload.iat;
        if (Array.isArray(payload.validLecturers)) {
          bearerValidLecturers = payload.validLecturers.map((l: string) =>
            String(l).toLowerCase(),
          );
        } else if (payload.createdBy) {
          bearerValidLecturers = [String(payload.createdBy).toLowerCase()];
        }
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
      {
        error:
          "Missing Student ID. Please log in with your FPT Student Account first.",
      },
      400,
    );
  }

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
      429,
    );
  }

  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const existingState = sessionStates.get(stateKey);

  const isDirectlyAllowed = session.allowedStudentIds.has(studentId);
  let isGroupAllowed = false;

  if (
    !isDirectlyAllowed &&
    Array.isArray(session.assignedGroups) &&
    session.assignedGroups.length > 0
  ) {
    for (const groupName of session.assignedGroups) {
      const g = getStudentGroup(groupName, session.createdBy);
      if (g && Array.isArray(g.userIds)) {
        if (g.userIds.some((uid) => uid.trim().toUpperCase() === studentId)) {
          isGroupAllowed = true;
          session.allowedStudentIds.add(studentId);
          sessions.set(sessionCode, session);
          break;
        }
      }
    }
  }

  if (!isDirectlyAllowed && !isGroupAllowed && !existingState) {
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

  const sessionCreator = (session.createdBy || "admin").toLowerCase();
  const mapKey = `${studentId}:${sessionCreator}`;
  const creatorAccount = studentAccounts.get(mapKey);
  const adminAccount = studentAccounts.get(`${studentId}:admin`);
  const account =
    creatorAccount ||
    (sessionCreator === "admin" ? adminAccount : undefined) ||
    getStudentAccount(studentId, sessionCreator);

  if (!account) {
    return c.json(
      {
        error: `Student account for ${studentId} does not exist under instructor @${session.createdBy || "admin"}.`,
      },
      403,
    );
  }

  if (account.isDeleted) {
    return c.json(
      {
        error: `Student account for ${studentId} has been deactivated.`,
      },
      403,
    );
  }

  let bearerAuthenticated = false;
  if (bearerStudentId && bearerStudentId.trim().toUpperCase() === studentId) {
    const isPasswordStillFresh =
      !account.updatedAt ||
      (bearerIat ? (bearerIat + 2) * 1000 >= account.updatedAt : true);

    if (isPasswordStillFresh) {
      if (bearerValidLecturers && Array.isArray(bearerValidLecturers)) {
        const isDirectMatch = bearerValidLecturers.includes(sessionCreator);
        const isSuperAdminSession = sessionCreator === "admin";
        const hasAdminAuth = bearerValidLecturers.includes("admin");
        if (
          isDirectMatch ||
          (isSuperAdminSession && hasAdminAuth) ||
          hasAdminAuth
        ) {
          bearerAuthenticated = true;
        }
      } else if (bearerCreatedBy) {
        if (
          bearerCreatedBy.toLowerCase() === sessionCreator ||
          bearerCreatedBy.toLowerCase() === "admin"
        ) {
          bearerAuthenticated = true;
        }
      }
    }
  }

  if (!bearerAuthenticated) {
    if (!password) {
      return c.json(
        {
          error: `This session was created by instructor @${session.createdBy || "admin"}. Please log in with the password provided by @${session.createdBy || "admin"}.`,
          requirePassword: true,
        },
        403,
      );
    }

    let isPasswordValid = false;
    if (creatorAccount) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        creatorAccount.passwordHash,
      );
    }
    if (!isPasswordValid && adminAccount) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        adminAccount.passwordHash,
      );
    }
    if (!isPasswordValid && account) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        account.passwordHash,
      );
    }

    if (!isPasswordValid) {
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
          429,
        );
      }
      return c.json(
        {
          error: `Password is incorrect for instructor @${session.createdBy || "admin"}. (Failed attempts: ${result.attemptsCount}/10)`,
          failedAttempts: result.attemptsCount,
          remainingAttempts: Math.max(0, 10 - result.attemptsCount),
        },
        403,
      );
    }
  }

  await recordSuccessfulLogin(ip, studentId);

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime = Math.floor((sessionEndMs(session) ?? 0) / 1000);
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

  const wasReassigned = Boolean(state.reassigned);
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
  sessionStates.set(stateKey, state);

  if (redis && redis.status === "ready") {
    try {
      const pattern = `session:user:*:${studentId}`;
      const oldKeys = await redis.keys(pattern);
      const keysToDelete = oldKeys.filter(
        (k) => !k.includes(`:${sessionCode}:${studentId}`),
      );
      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
    } catch (err) {
      console.warn(
        "[Auth] Failed to clean up stale Redis session keys on switch:",
        err,
      );
    }

    try {
      const redisKey = `session:user:${sessionCode}:${studentId}`;
      await redis.hset(redisKey, {
        budget: String(session.defaultTokenBudget),
        consumed: String(state.tokensConsumed),
        loginTime: String((toMs(state.loginTimestamp) ?? 0) / 1000),
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
    promptMode: session.promptMode || "scaffolded_code",
    aiValidityMinutes: session.aiValidityMinutes,
    loginTime: (toMs(state.loginTimestamp) ?? 0) / 1000,
    sessionEndTime,
    exp: sessionEndTime,
    // cgv = client-gate-verified: this token was issued to a client that passed
    // the version/checksum gate, so chat requests with it are not re-checked.
    ...(evaluateClient(readClientIdentity((n) => c.req.header(n))).status ===
    "ok"
      ? { cgv: 1 }
      : {}),
  };

  const token = await sign(payload, jwtSecret);

  return c.json({
    success: true,
    token,
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    promptMode: session.promptMode || "scaffolded_code",
    runtimeConfig: session.runtimeConfig,
    isReassigned: wasReassigned,
    reassigned: wasReassigned,
  });
}
