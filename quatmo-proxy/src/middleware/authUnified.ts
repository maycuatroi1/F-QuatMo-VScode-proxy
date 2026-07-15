import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { redis } from "../services/redis";
import { getJwtSecret } from "../services/jwtKey";
import {
  authMiddleware as normalAuthMiddleware,
  type UserSession,
} from "./auth";

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware hợp nhất tự động định tuyến các request xác thực:
//  - Chế độ session (JWT): Xác thực JWT, kiểm tra thời gian hết hạn session,
//    kiểm tra thời hạn AI dựa trên giờ login của SV và kiểm tra budget từ Redis.
//  - Chế độ thường (API Key): Chuyển tiếp cho authMiddleware cũ.
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
            error: "Token session không hợp lệ hoặc đã hết thời gian sử dụng.",
          },
          403,
        );
      }

      const now = Math.floor(Date.now() / 1000);

      if (now > payload.sessionEndTime) {
        return c.json(
          { error: "Session đã kết thúc. Quyền truy cập AI đã bị khóa." },
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
              "Đã hết thời gian sử dụng AI được phép của bạn trong session này.",
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
          if (!sessionData || Object.keys(sessionData).length === 0) {
            return c.json(
              {
                error:
                  "Phiên làm việc không tồn tại hoặc đã bị quản trị viên reset.",
              },
              403,
            );
          }
          budget = parseInt(sessionData.budget || "0", 10);
          consumed = parseInt(sessionData.consumed || "0", 10);
        } catch (err) {
          console.error(
            `[AuthUnified] Redis session fetch error for ${sessionKey}:`,
            err,
          );
          return c.json({ error: "Lỗi kết nối cơ sở dữ liệu session." }, 500);
        }
      } else {
        const { sessionStates, sessions } =
          await import("../services/sessionStore");
        const stateKey = `${payload.sessionCode}:${payload.studentId}`;
        const state = sessionStates.get(stateKey);
        const sessionObj = sessions.get(payload.sessionCode);
        if (!state || !sessionObj) {
          return c.json({ error: "Không tìm thấy thông tin session." }, 403);
        }
        budget = sessionObj.defaultTokenBudget;
        consumed = state.tokensConsumed;
      }

      if (consumed >= budget) {
        return c.json(
          {
            error:
              "Tài khoản của bạn đã vượt quá giới hạn token được cấp cho session này.",
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
