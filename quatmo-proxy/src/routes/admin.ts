import { Hono } from "hono";
import { getProxyApiKey } from "../services/proxyKey";
import { redis } from "../services/redis";

declare const Bun: any;
import {
  studentAccounts,
  sessions,
  sessionStates,
  type Session,
  type StudentSessionState,
} from "../services/sessionStore";

const adminRouter = new Hono();

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware bảo vệ các API của Admin bằng PROXY_API_KEY
// ─────────────────────────────────────────────────────────────────────────────
adminRouter.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Admin API Key" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const masterKey = getProxyApiKey();

  if (token !== masterKey) {
    return c.json({ error: "Unauthorized. Invalid Admin API Key" }, 401);
  }

  await next();
});

// 1. Khởi tạo danh mục tài khoản học viên toàn cục
adminRouter.post("/students", async (c) => {
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
});

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
  const { durationMinutes, aiOption, aiValidityMinutes, defaultTokenBudget } =
    body as {
      durationMinutes?: number;
      aiOption?: "chatbot" | "agent" | "none";
      aiValidityMinutes?: number;
      defaultTokenBudget?: number;
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

  const newSession: Session = {
    sessionCode,
    startTime: Math.floor(Date.now() / 1000),
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    allowedStudentIds: new Set<string>(),
    createdAt: Date.now(),
  };

  sessions.set(sessionCode, newSession);

  return c.json({
    success: true,
    session: { ...newSession, allowedStudentIds: [] },
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

    // Xóa session trên Redis để lập tức vô hiệu hóa token JWT cũ đang hoạt động
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
      const studentStatesPromises = Array.from(session.allowedStudentIds).map(
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
        createdAt: session.createdAt || session.startTime * 1000,
        students: studentStates,
      };
    },
  );

  const sessionList = await Promise.all(sessionPromises);
  return c.json({ success: true, sessions: sessionList });
});

export { adminRouter };
