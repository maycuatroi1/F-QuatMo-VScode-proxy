import { Hono } from "hono";
import { getProxyApiKey } from "../services/proxyKey";
import { redis } from "../services/redis";

declare const Bun: any;
import {
  studentAccounts,
  exams,
  examStates,
  type Exam,
  type StudentExamState,
} from "../services/examStore";

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

// 2. Tạo phòng thi mới (Gen ngẫu nhiên examCode dài 6 ký tự)
adminRouter.post("/exams", async (c) => {
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

  // Tạo mã examCode ngẫu nhiên và đảm bảo duy nhất
  let examCode = "";
  do {
    const chars = "ABCDEFGHJKLMNOPQRSTUVWXYZ23456789";
    let code = "EX-";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!exams.has(code)) {
      examCode = code;
    }
  } while (!examCode);

  const newExam: Exam = {
    examCode,
    startTime: Math.floor(Date.now() / 1000),
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    allowedStudentIds: new Set<string>(),
    createdAt: Date.now(),
  };

  exams.set(examCode, newExam);

  return c.json({ success: true, exam: { ...newExam, allowedStudentIds: [] } });
});

// 3. Nạp danh sách mã sinh viên được phép vào phòng thi
adminRouter.post("/exams/:examCode/students", async (c) => {
  const examCode = c.req.param("examCode").toUpperCase();
  const exam = exams.get(examCode);

  if (!exam) {
    return c.json({ error: `Exam with code ${examCode} not found.` }, 404);
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
    exam.allowedStudentIds.add(id);

    // Khởi tạo trạng thái thi ban đầu cho học viên nếu chưa có
    const stateKey = `${examCode}:${id}`;
    if (!examStates.has(stateKey)) {
      const initialState: StudentExamState = {
        examCode,
        studentId: id,
        hasLoggedIn: false,
        loginTimestamp: 0,
        tokensConsumed: 0,
        reassigned: false,
      };
      examStates.set(stateKey, initialState);
    }
    addedCount++;
  }

  return c.json({
    success: true,
    message: `Added ${addedCount} students to exam ${examCode}.`,
    totalStudents: exam.allowedStudentIds.size,
  });
});

// 4. Reset trạng thái đăng nhập (Reassign) cho học viên vào thi lại
adminRouter.post("/exams/:examCode/students/:studentId/reassign", async (c) => {
  const examCode = c.req.param("examCode").toUpperCase();
  const studentId = c.req.param("studentId").toUpperCase();
  const stateKey = `${examCode}:${studentId}`;

  const state = examStates.get(stateKey);
  if (!state) {
    return c.json({ error: "Student exam state not found." }, 404);
  }

  state.reassigned = true;
  state.hasLoggedIn = false;

  // Xóa session trên Redis để lập tức vô hiệu hóa token JWT cũ đang hoạt động
  if (redis && redis.status === "ready") {
    try {
      const redisKey = `exam:session:${examCode}:${studentId}`;
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
    message: `Student ${studentId} reassigned successfully in exam ${examCode}.`,
  });
});

adminRouter.get("/exams", async (c) => {
  const examPromises = Array.from(exams.entries()).map(async ([code, exam]) => {
    const studentStatesPromises = Array.from(exam.allowedStudentIds).map(async (studentId) => {
      const stateKey = `${code}:${studentId}`;
      const state = examStates.get(stateKey);

      let consumed = state?.tokensConsumed ?? 0;
      if (redis && redis.status === "ready") {
        try {
          const val = await redis.hget(
            `exam:session:${code}:${studentId}`,
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
    });

    const studentStates = await Promise.all(studentStatesPromises);

    return {
      examCode: exam.examCode,
      startTime: exam.startTime,
      durationMinutes: exam.durationMinutes,
      aiOption: exam.aiOption,
      aiValidityMinutes: exam.aiValidityMinutes,
      defaultTokenBudget: exam.defaultTokenBudget,
      createdAt: exam.createdAt || exam.startTime * 1000,
      students: studentStates,
    };
  });

  const examList = await Promise.all(examPromises);
  return c.json({ success: true, exams: examList });
});

export { adminRouter };
