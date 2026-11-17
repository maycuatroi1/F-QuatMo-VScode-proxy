import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  studentAccounts,
  sessions,
  sessionStates,
  type Session,
} from "../src/services/sessionStore";
import { adminRouter } from "../src/routes/admin";
import { sessionAuthRouter } from "../src/routes/sessionAuth";
import { authRouter } from "../src/routes/auth";
import { getProxyApiKey } from "../src/services/proxyKey";

const app = new Hono();
app.route("/admin", adminRouter);
app.route("/session", sessionAuthRouter);
app.route("/auth", authRouter);

describe("Prompt Mode Configuration & Safe Session Switching", () => {
  const masterKey = getProxyApiKey();

  it("should create session with custom promptMode and default to scaffolded_code when omitted", async () => {
    // 1. Create session with explicit socratic_tutor mode
    const resSocratic = await app.request("/admin/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        durationMinutes: 120,
        aiOption: "chatbot",
        aiValidityMinutes: 120,
        defaultTokenBudget: 60000,
        promptMode: "socratic_tutor",
        sessionPrompt: "Solve recursion questions without code",
      }),
    });
    expect(resSocratic.status).toBe(200);
    const dataSocratic = (await resSocratic.json()) as any;
    expect(dataSocratic.session.promptMode).toBe("socratic_tutor");

    const sessionSocratic = sessions.get(dataSocratic.sessionCode);
    expect(sessionSocratic?.promptMode).toBe("socratic_tutor");

    // 2. Create session without promptMode -> defaults to scaffolded_code
    const resDefault = await app.request("/admin/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        durationMinutes: 120,
        aiOption: "chatbot",
        aiValidityMinutes: 120,
        defaultTokenBudget: 60000,
      }),
    });
    expect(resDefault.status).toBe(200);
    const dataDefault = (await resDefault.json()) as any;
    expect(dataDefault.session.promptMode).toBe("scaffolded_code");

    const sessionDefault = sessions.get(dataDefault.sessionCode);
    expect(sessionDefault?.promptMode).toBe("scaffolded_code");

    // 3. Patch session to standard mode
    const resPatch = await app.request(`/admin/sessions/${dataDefault.sessionCode}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        promptMode: "standard",
      }),
    });
    expect(resPatch.status).toBe(200);
    const updated = sessions.get(dataDefault.sessionCode);
    expect(updated?.promptMode).toBe("standard");
  });

  it("should allow student to switch between sessions of the same lecturer but block cross-lecturer unauthorized access", async () => {
    const now = Date.now();
    const studentId = "SE190099";

    // Lecturer A setup
    const passA = "pass_teacher_a";
    const hashA = await Bun.password.hash(passA, "bcrypt");
    studentAccounts.set(`${studentId}:teacher_a`, {
      studentId,
      createdBy: "teacher_a",
      passwordHash: hashA,
      createdAt: now,
      updatedAt: now,
    });

    // Lecturer B setup (different password)
    const passB = "pass_teacher_b";
    const hashB = await Bun.password.hash(passB, "bcrypt");
    studentAccounts.set(`${studentId}:teacher_b`, {
      studentId,
      createdBy: "teacher_b",
      passwordHash: hashB,
      createdAt: now,
      updatedAt: now,
    });

    // Student logs in via /auth/login with Teacher A's password
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId,
        password: passA,
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as any;
    const tokenTeacherA = loginData.token;
    expect(tokenTeacherA).toBeDefined();

    // Create 2 sessions for Teacher A
    const codeA1 = "TEST-A1";
    const codeA2 = "TEST-A2";
    sessions.set(codeA1, {
      sessionCode: codeA1,
      startTime: Math.floor(now / 1000),
      durationMinutes: 120,
      aiOption: "chatbot",
      aiValidityMinutes: 120,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
      createdBy: "teacher_a",
      promptMode: "scaffolded_code",
    });

    sessions.set(codeA2, {
      sessionCode: codeA2,
      startTime: Math.floor(now / 1000),
      durationMinutes: 120,
      aiOption: "chatbot",
      aiValidityMinutes: 120,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
      createdBy: "teacher_a",
      promptMode: "socratic_tutor",
    });

    // Create 1 session for Teacher B
    const codeB1 = "TEST-B1";
    sessions.set(codeB1, {
      sessionCode: codeB1,
      startTime: Math.floor(now / 1000),
      durationMinutes: 120,
      aiOption: "chatbot",
      aiValidityMinutes: 120,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
      createdBy: "teacher_b",
      promptMode: "standard",
    });

    // Step 1: Join Session A1 using tokenTeacherA -> MUST SUCCEED
    const joinA1 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenTeacherA}`,
      },
      body: JSON.stringify({
        sessionCode: codeA1,
        studentId,
      }),
    });
    expect(joinA1.status).toBe(200);
    const dataA1 = (await joinA1.json()) as any;
    expect(dataA1.sessionCode).toBe(codeA1);
    expect(dataA1.promptMode).toBe("scaffolded_code");

    // Step 2: Re-join Session A1 without reassign -> MUST BE BLOCKED (Single Active Device / Reassign policy)
    const rejoinA1 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenTeacherA}`,
      },
      body: JSON.stringify({
        sessionCode: codeA1,
        studentId,
      }),
    });
    expect(rejoinA1.status).toBe(403);
    const rejoinA1Data = (await rejoinA1.json()) as any;
    expect(rejoinA1Data.error).toContain("logged in on another device");

    // Step 3: Switch to Session A2 under the SAME teacher -> MUST SUCCEED (not blocked by Session A1!)
    const joinA2 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenTeacherA}`,
      },
      body: JSON.stringify({
        sessionCode: codeA2,
        studentId,
      }),
    });
    expect(joinA2.status).toBe(200);
    const dataA2 = (await joinA2.json()) as any;
    expect(dataA2.sessionCode).toBe(codeA2);
    expect(dataA2.promptMode).toBe("socratic_tutor");

    // Step 4: Attempt to join Session B1 (Teacher B) with Teacher A's token -> MUST BE REJECTED (require Teacher B password)
    const joinB1NoPass = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenTeacherA}`,
      },
      body: JSON.stringify({
        sessionCode: codeB1,
        studentId,
      }),
    });
    expect(joinB1NoPass.status).toBe(403);
    const dataB1NoPass = (await joinB1NoPass.json()) as any;
    expect(dataB1NoPass.requirePassword).toBe(true);

    // Step 5: Join Session B1 by supplying Teacher B's password -> MUST SUCCEED
    const joinB1WithPass = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenTeacherA}`,
      },
      body: JSON.stringify({
        sessionCode: codeB1,
        studentId,
        password: passB,
      }),
    });
    expect(joinB1WithPass.status).toBe(200);
    const dataB1 = (await joinB1WithPass.json()) as any;
    expect(dataB1.sessionCode).toBe(codeB1);
    expect(dataB1.promptMode).toBe("standard");
  });
});
