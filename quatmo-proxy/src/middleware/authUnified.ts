import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { redis } from "../services/redis";
import { getJwtSecret } from "../services/jwtKey";
import {
  authMiddleware as normalAuthMiddleware,
  type UserSession,
} from "./auth";

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Unified authentication middleware routing requests:
//  - Session mode (JWT): Validates JWT signature, session expiration,
//    per-student AI validity limits, and token budgets from Redis/SQLite cache.
//  - Standard mode (API Key): Delegates to legacy API key auth middleware.
// ─────────────────────────────────────────────────────────────────────────────
export const unifiedAuthMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.substring(7).trim();
    const isJwt = token.startsWith("eyJ");

    if (isJwt) {
      const jwtSecret = getJwtSecret();
      let payload: any;
      try {
        payload = await verify(token, jwtSecret, "HS256" as any);
      } catch (err) {
        return c.json(
          {
            error: "Invalid or expired session token.",
          },
          403,
        );
      }

      const now = Math.floor(Date.now() / 1000);

      // Support global user tokens (persistent account login without active session)
      if (payload.type === "user" || (!payload.sessionCode && (payload.studentId || payload.userId))) {
        const uid = payload.studentId || payload.userId || "user";
        const userSession: UserSession = {
          keyId: `user-${uid}`,
          userId: uid,
          monthlyTokenLimit: 999_999_999,
          tokensConsumed: 0,
        };
        c.set("authMode", "normal");
        c.set("user", userSession);
        c.set("token", token);
        return await next();
      }

      if (payload.sessionEndTime && now > payload.sessionEndTime) {
        return c.json(
          { error: "Session has ended. AI access is locked." },
          403,
        );
      }

      // isTokenAIHasTime
      const aiExpirationTime = payload.aiValidityMinutes === -1
        ? payload.loginTime + 24 * 60 * 60
        : payload.loginTime + payload.aiValidityMinutes * 60;
      if (now > aiExpirationTime) {
        return c.json(
          {
            error:
              "Your allowed AI access duration for this session has expired.",
          },
          403,
        );
      }

      // isStudentTokenAvailable (Redis)
      const sessionKey = `session:user:${payload.sessionCode}:${payload.studentId}`;
      let budget = 0;
      let consumed = 0;

      if (redis && redis.status === "ready") {
        try {
          const sessionData = await redis.hgetall(sessionKey);
          if (sessionData && Object.keys(sessionData).length > 0) {
            budget = parseInt(sessionData.budget || "0", 10);
            consumed = parseInt(sessionData.consumed || "0", 10);
          } else {
            // RAM cache miss after Redis restart or flush.
            // Verify JWT against SQLite persistent state and lazily re-hydrate Redis key to prevent session disruption.
            const { sessionStates, sessions } = await import("../services/sessionStore");
            const stateKey = `${payload.sessionCode}:${payload.studentId}`;
            const state = sessionStates.get(stateKey);
            const sessionObj = sessions.get(payload.sessionCode);

            if (!state || !sessionObj || !state.hasLoggedIn || state.reassigned) {
              return c.json(
                {
                  error:
                    "Session does not exist or has been reset by administrator.",
                },
                403,
              );
            }

            budget = sessionObj.defaultTokenBudget;
            consumed = state.tokensConsumed;

            try {
              const remainingSec = Math.max(60, (payload.sessionEndTime || (now + 3600)) - now);
              await redis.hset(sessionKey, {
                studentId: payload.studentId,
                sessionCode: payload.sessionCode,
                hasLoggedIn: "true",
                tokensConsumed: String(consumed),
                budget: String(budget),
                latestClassification: state.latestClassification || "none",
              });
              await redis.expire(sessionKey, remainingSec);
            } catch (healErr) {
              console.error(`[AuthUnified] Auto-heal Redis error for ${sessionKey}:`, healErr);
            }
          }
        } catch (err) {
          console.error(
            `[AuthUnified] Redis session fetch error for ${sessionKey}:`,
            err,
          );
          return c.json({ error: "Session database connection error." }, 500);
        }
      } else {
        const { sessionStates, sessions } =
          await import("../services/sessionStore");
        const stateKey = `${payload.sessionCode}:${payload.studentId}`;
        const state = sessionStates.get(stateKey);
        const sessionObj = sessions.get(payload.sessionCode);
        if (!state || !sessionObj) {
          return c.json({ error: "Session information not found." }, 403);
        }
        budget = sessionObj.defaultTokenBudget;
        consumed = state.tokensConsumed;
      }

      if (consumed >= budget) {
        return c.json(
          {
            error:
              "Your account has exceeded the token budget for this session.",
          },
          402,
        );
      }

      c.set("authMode", "session");
      c.set("sessionContext", payload);
      c.set("sessionKey", sessionKey);

      const userSession: UserSession = {
        keyId: `session-${payload.sessionCode}`,
        userId: payload.studentId,
        monthlyTokenLimit: budget,
        tokensConsumed: consumed,
      };
      c.set("user", userSession);
      c.set("token", token);

      return await next();
    } else {
      c.set("authMode", "normal");
      const originalAuth = normalAuthMiddleware();
      return originalAuth(c, next);
    }
  };
};
