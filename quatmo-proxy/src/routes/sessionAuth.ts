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
    return c.json({ error: "Token không hợp lệ hoặc đã hết hạn" }, 401);
  }

  const { studentId, sessionCode } = payload;
  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session không tồn tại." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);
  if (!state) {
    return c.json(
      { error: "Không tìm thấy thông tin trạng thái học viên." },
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
  const sessionEndTime = session.startTime + session.durationMinutes * 60;
  const aiExpirationTime = payload.loginTime + session.aiValidityMinutes * 60;
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
    sessionRemainingMinutes: Math.ceil(sessionRemainingSeconds / 60),
    aiRemainingMinutes: Math.ceil(aiRemainingSeconds / 60),
  });
});

sessionAuthRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const {
    sessionCode: rawSessionCode,
    studentId: rawStudentId,
    password,
  } = body as {
    sessionCode?: string;
    studentId?: string;
    password?: string;
  };

  if (!rawSessionCode || !rawStudentId || !password) {
    return c.json(
      { error: "Missing required fields: sessionCode, studentId, password" },
      400,
    );
  }

  const sessionCode = rawSessionCode.trim().toUpperCase();
  const studentId = rawStudentId.trim().toUpperCase();

  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session không tồn tại." }, 404);
  }

  if (!session.allowedStudentIds.has(studentId)) {
    return c.json(
      {
        error:
          "Sinh viên không nằm trong danh sách được phép tham gia session này.",
      },
      403,
    );
  }

  const account = studentAccounts.get(studentId);
  if (!account) {
    return c.json(
      { error: "Tài khoản sinh viên không tồn tại trên hệ thống." },
      403,
    );
  }

  const isPasswordValid = await Bun.password.verify(
    password,
    account.passwordHash,
  );
  if (!isPasswordValid) {
    return c.json({ error: "Mật khẩu tài khoản không chính xác." }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime = session.startTime + session.durationMinutes * 60;
  const remainingSeconds = sessionEndTime - now;

  if (remainingSeconds <= 0) {
    return c.json({ error: "Session này đã kết thúc." }, 403);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  let state = sessionStates.get(stateKey);
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
          "Tài khoản đang đăng nhập trên thiết bị khác. Vui lòng liên hệ giám thị hoặc quản trị viên để reset.",
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
      return c.json({ error: "Lỗi kết nối cơ sở dữ liệu RAM (Redis)." }, 500);
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

export { sessionAuthRouter };
