import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { redis } from "../services/redis";
import { getJwtSecret } from "../services/jwtKey";

declare const Bun: any;
import {
  studentAccounts,
  exams,
  examStates,
  type StudentExamState,
} from "../services/examStore";

const examAuthRouter = new Hono();

examAuthRouter.get("/status", async (c) => {
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

  const { studentId, examCode } = payload;
  const exam = exams.get(examCode);
  if (!exam) {
    return c.json({ error: "Phòng thi không tồn tại." }, 404);
  }

  const stateKey = `${examCode}:${studentId}`;
  const state = examStates.get(stateKey);
  if (!state) {
    return c.json({ error: "Không tìm thấy thông tin trạng thái học viên." }, 404);
  }

  // Lấy lượng token đã dùng từ Redis (nếu có) hoặc RAM fallback
  let consumed = state.tokensConsumed;
  if (redis && redis.status === "ready") {
    try {
      const val = await redis.hget(`exam:session:${examCode}:${studentId}`, "consumed");
      if (val !== null) {
        consumed = parseInt(val, 10);
      }
    } catch {
      // fallback
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const examEndTime = exam.startTime + exam.durationMinutes * 60;
  const aiExpirationTime = payload.loginTime + exam.aiValidityMinutes * 60;
  const examRemainingSeconds = Math.max(0, examEndTime - now);
  const aiRemainingSeconds = Math.max(0, aiExpirationTime - now);

  return c.json({
    success: true,
    studentId,
    examCode,
    aiOption: exam.aiOption,
    tokenBudget: exam.defaultTokenBudget,
    tokensConsumed: consumed,
    tokensRemaining: Math.max(0, exam.defaultTokenBudget - consumed),
    examRemainingMinutes: Math.ceil(examRemainingSeconds / 60),
    aiRemainingMinutes: Math.ceil(aiRemainingSeconds / 60),
  });
});

examAuthRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const {
    examCode: rawExamCode,
    studentId: rawStudentId,
    password,
  } = body as {
    examCode?: string;
    studentId?: string;
    password?: string;
  };

  if (!rawExamCode || !rawStudentId || !password) {
    return c.json(
      { error: "Missing required fields: examCode, studentId, password" },
      400,
    );
  }

  const examCode = rawExamCode.trim().toUpperCase();
  const studentId = rawStudentId.trim().toUpperCase();

  // isExamExisted
  const exam = exams.get(examCode);
  if (!exam) {
    return c.json({ error: "Phòng thi không tồn tại." }, 404);
  }

  // isAllowedStudent
  if (!exam.allowedStudentIds.has(studentId)) {
    return c.json(
      { error: "Sinh viên không nằm trong danh sách được phép thi phòng này." },
      403,
    );
  }

  // isStudentExist
  const account = studentAccounts.get(studentId);
  if (!account) {
    return c.json(
      { error: "Tài khoản sinh viên không tồn tại trên hệ thống." },
      403,
    );
  }

  // Check password valid
  const isPasswordValid = await Bun.password.verify(
    password,
    account.passwordHash,
  );
  if (!isPasswordValid) {
    return c.json({ error: "Mật khẩu tài khoản không chính xác." }, 403);
  }

  // isExamHasTime
  const now = Math.floor(Date.now() / 1000);
  const examEndTime = exam.startTime + exam.durationMinutes * 60;
  const remainingSeconds = examEndTime - now;

  if (remainingSeconds <= 0) {
    return c.json({ error: "Kỳ thi này đã kết thúc." }, 403);
  }

  // isAccountLoginDuplicate
  const stateKey = `${examCode}:${studentId}`;
  let state = examStates.get(stateKey);
  if (!state) {
    state = {
      examCode,
      studentId,
      hasLoggedIn: false,
      loginTimestamp: 0,
      tokensConsumed: 0,
      reassigned: false,
    };
    examStates.set(stateKey, state);
  }

  if (state.hasLoggedIn && !state.reassigned) {
    return c.json(
      {
        error:
          "Tài khoản đang đăng nhập trên thiết bị khác. Vui lòng liên hệ giám thị để reset.",
      },
      403,
    );
  }

  // updateLoginState
  state.hasLoggedIn = true;
  if (!state.loginTimestamp || state.loginTimestamp === 0) {
    state.loginTimestamp = now;
  }
  state.reassigned = false;

  // set session redis
  if (redis && redis.status === "ready") {
    try {
      const redisKey = `exam:session:${examCode}:${studentId}`;
      await redis.hset(redisKey, {
        budget: String(exam.defaultTokenBudget),
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
    // If redis is offline, use RAM map
    console.warn(
      "[Auth] Redis is offline. Running exam session check from RAM only.",
    );
  }

  // sinh JWT
  const jwtSecret = getJwtSecret();
  const payload = {
    studentId,
    examCode,
    aiOption: exam.aiOption,
    aiValidityMinutes: exam.aiValidityMinutes,
    loginTime: state.loginTimestamp,
    examEndTime,
    exp: examEndTime,
  };

  const token = await sign(payload, jwtSecret);

  return c.json({
    success: true,
    token,
    studentId,
    examCode,
  });
});

export { examAuthRouter };
