import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  studentAccounts,
  sessions,
  sessionStates,
  studentGroups,
  getStudentGroup,
  findAllValidStudentAccounts,
} from "../src/services/sessionStore";
import { adminRouter } from "../src/routes/admin";
import { sessionAuthRouter } from "../src/routes/sessionAuth";
import { authRouter } from "../src/routes/auth";
import { getProxyApiKey } from "../src/services/proxyKey";

const app = new Hono();
app.route("/admin", adminRouter);
app.route("/session", sessionAuthRouter);
app.route("/auth", authRouter);

describe("Multi-Lecturer Shared Student Conflict Resolution & Password Freshness", () => {
  const masterKey = getProxyApiKey();

  it("should allow Lecturer 1 and Lecturer 2 to create groups with the same name without overwrite", async () => {
    studentGroups.set("SE1801:lecturer1", {
      name: "SE1801",
      userIds: ["HE180001", "HE180002"],
      createdBy: "lecturer1",
    });

    studentGroups.set("SE1801:lecturer2", {
      name: "SE1801",
      userIds: ["HE180001", "HE180003"],
      createdBy: "lecturer2",
    });

    const g1 = getStudentGroup("SE1801", "lecturer1");
    const g2 = getStudentGroup("SE1801", "lecturer2");

    expect(g1).toBeDefined();
    expect(g2).toBeDefined();
    expect(g1?.userIds).toContain("HE180002");
    expect(g2?.userIds).toContain("HE180003");
  });

  it("should check all accounts and allow session join only when password matches lecturer", async () => {
    const now = Date.now();

    // Lecturer 1 adds HE189999 (pass: shared123)
    const hash1 = await Bun.password.hash("shared123", "bcrypt");
    studentAccounts.set("HE189999:lecturer1", {
      studentId: "HE189999",
      createdBy: "lecturer1",
      passwordHash: hash1,
      createdAt: now,
      updatedAt: now,
    });

    // Lecturer 2 adds HE189999 (pass: shared123) - same password
    const hash2 = await Bun.password.hash("shared123", "bcrypt");
    studentAccounts.set("HE189999:lecturer2", {
      studentId: "HE189999",
      createdBy: "lecturer2",
      passwordHash: hash2,
      createdAt: now,
      updatedAt: now,
    });

    // Lecturer 3 adds HE189999 (pass: diff999) - DIFFERENT password
    const hash3 = await Bun.password.hash("diff999", "bcrypt");
    studentAccounts.set("HE189999:lecturer3", {
      studentId: "HE189999",
      createdBy: "lecturer3",
      passwordHash: hash3,
      createdAt: now,
      updatedAt: now,
    });

    // Lecturer 1 creates Session 1
    sessions.set("SS-LEC1", {
      sessionCode: "SS-LEC1",
      startTime: Math.floor(now / 1000),
      durationMinutes: 60,
      aiOption: "chatbot",
      aiValidityMinutes: 60,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set(["HE189999"]),
      createdAt: now,
      createdBy: "lecturer1",
    });

    // Lecturer 2 creates Session 2
    sessions.set("SS-LEC2", {
      sessionCode: "SS-LEC2",
      startTime: Math.floor(now / 1000),
      durationMinutes: 60,
      aiOption: "chatbot",
      aiValidityMinutes: 60,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set(["HE189999"]),
      createdAt: now,
      createdBy: "lecturer2",
    });

    // Lecturer 3 creates Session 3
    sessions.set("SS-LEC3", {
      sessionCode: "SS-LEC3",
      startTime: Math.floor(now / 1000),
      durationMinutes: 60,
      aiOption: "chatbot",
      aiValidityMinutes: 60,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set(["HE189999"]),
      createdAt: now,
      createdBy: "lecturer3",
    });

    // Student logs into IDE using password 'shared123'
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: "HE189999",
        password: "shared123",
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    const userToken = loginData.token;

    // 1. Join Session 1 (Lecturer 1) with userToken -> MUST SUCCEED
    const joinLec1 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        sessionCode: "SS-LEC1",
        studentId: "HE189999",
      }),
    });
    expect(joinLec1.status).toBe(200);

    // 2. Join Session 2 (Lecturer 2) with userToken -> MUST SUCCEED (same password)
    const joinLec2 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        sessionCode: "SS-LEC2",
        studentId: "HE189999",
      }),
    });
    expect(joinLec2.status).toBe(200);

    // 3. Join Session 3 (Lecturer 3) with userToken -> MUST BE REJECTED because Lecturer 3 set 'diff999'
    const joinLec3 = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        sessionCode: "SS-LEC3",
        studentId: "HE189999",
      }),
    });
    expect(joinLec3.status).toBe(403);
    const joinLec3Data = await joinLec3.json();
    expect(joinLec3Data.requirePassword).toBe(true);

    // 4. Joining Session 3 with correct password 'diff999' -> MUST SUCCEED
    const joinLec3WithPass = await app.request("/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "SS-LEC3",
        studentId: "HE189999",
        password: "diff999",
      }),
    });
    expect(joinLec3WithPass.status).toBe(200);

    // 5. Lecturer 2 CHANGES password to 'newpass888'
    const hash2New = await Bun.password.hash("newpass888", "bcrypt");
    const updateTime = Date.now() + 5000; // 5 seconds in future
    studentAccounts.set("HE189999:lecturer2", {
      studentId: "HE189999",
      createdBy: "lecturer2",
      passwordHash: hash2New,
      createdAt: now,
      updatedAt: updateTime,
    });

    // Create a new session for Lecturer 2
    sessions.set("SS-LEC2-NEW", {
      sessionCode: "SS-LEC2-NEW",
      startTime: Math.floor(now / 1000),
      durationMinutes: 60,
      aiOption: "chatbot",
      aiValidityMinutes: 60,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set(["HE189999"]),
      createdAt: now,
      createdBy: "lecturer2",
    });

    // Old token should NO LONGER be accepted for Lecturer 2 because password was changed
    const joinLec2Stale = await app.request("/session/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        sessionCode: "SS-LEC2-NEW",
        studentId: "HE189999",
      }),
    });
    expect(joinLec2Stale.status).toBe(403);

    // Re-auth with new password 'newpass888' -> MUST SUCCEED
    const joinLec2WithNewPass = await app.request("/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "SS-LEC2-NEW",
        studentId: "HE189999",
        password: "newpass888",
      }),
    });
    expect(joinLec2WithNewPass.status).toBe(200);
  });

  it("should skip duplicate student IDs when importing students under the same lecturer", async () => {
    studentAccounts.delete("HE190001:gv_test_dup");
    studentAccounts.delete("HE190002:gv_test_dup");
    studentAccounts.delete("HE190003:gv_test_dup");

    // Generate lecturer JWT token for gv_test_dup
    const { sign } = await import("hono/jwt");
    const { getJwtSecret } = await import("../src/services/jwtKey");
    // Lecturer JWTs are only honoured for existing, active lecturer accounts.
    const { lecturerAccounts } = await import("../src/services/sessionStore");
    lecturerAccounts.set("gv_test_dup", {
      username: "gv_test_dup",
      name: "gv_test_dup",
      passwordHash: "",
      status: "active",
      createdAt: Date.now(),
      createdBy: "admin",
      updatedAt: Date.now(),
      updatedBy: "admin",
    });
    const token = await sign(
      { username: "gv_test_dup", role: "lecturer", exp: Math.floor(Date.now() / 1000) + 3600 },
      getJwtSecret(),
      "HS256" as any,
    );

    // Initial import of 2 students
    const res1 = await app.request("/admin/students", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        students: [
          { studentId: "HE190001", password: "pw1" },
          { studentId: "HE190002", password: "pw2" },
        ],
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.importedCount).toBe(2);
    expect(body1.skippedCount).toBe(0);

    // Re-importing same students + 1 new student + duplicate in same payload
    const res2 = await app.request("/admin/students", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        students: [
          { studentId: "HE190001", password: "new_pw_should_not_overwrite" },
          { studentId: "HE190003", password: "pw3" },
          { studentId: "HE190003", password: "pw3_repeat" },
        ],
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.importedCount).toBe(1); // Only HE190003
    expect(body2.skippedCount).toBe(2); // HE190001 existing, HE190003 duplicate in batch

    // Verify original password for HE190001 was NOT overwritten
    const acc = studentAccounts.get("HE190001:gv_test_dup");
    expect(acc).toBeDefined();
    const isValidOldPw = await Bun.password.verify("pw1", acc!.passwordHash);
    expect(isValidOldPw).toBe(true);
    lecturerAccounts.delete("gv_test_dup");
  });
});

