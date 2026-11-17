import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { verify } from "hono/jwt";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { sessions, sessionStates, studentAccounts } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);

for (const [index, prefix] of ["/session", "/v1/session"].entries()) {
  test(`${prefix}: login retains validation, duplicate-device rejection and persisted reassignment`, async () => {
    const code = `LOGIN_CONTRACT_${index}`;
    const id = `SELOGIN${index}`;
    const now = Math.floor(Date.now() / 1000);
    sessions.set(code, { sessionCode: code, startTime: now, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 30, promptMode: "socratic_tutor",
      defaultTokenBudget: 1000, allowedStudentIds: new Set([id]), createdAt: Date.now(), createdBy: "admin" });
    studentAccounts.set(`${id}:admin`, { studentId: id, createdBy: "admin", passwordHash: await Bun.password.hash("fixture-password", "bcrypt") });
    const login = (body: object) => app.request(`${prefix}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const body = { sessionCode: code.toLowerCase(), studentId: id.toLowerCase(), password: "fixture-password" };
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    try {
      expect((await login({})).status).toBe(400);
      expect((await login({ ...body, sessionCode: "MISSING" })).status).toBe(404);
      expect((await login({ ...body, studentId: "NOT_ALLOWED" })).status).toBe(403);
      const response = await login(body);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({ success: true, studentId: id, sessionCode: code, promptMode: "socratic_tutor", isReassigned: false });
      const claims = await verify(data.token, getJwtSecret(), "HS256");
      expect(claims).toMatchObject({ studentId: id, sessionCode: code, promptMode: "socratic_tutor", aiValidityMinutes: 30, sessionEndTime: now + 3600, exp: now + 3600 });
      expect(claims).not.toHaveProperty("tokenVersion");
      expect((await login(body)).status).toBe(403);
      const state = sessionStates.get(`${code}:${id}`)!;
      const originalTime = state.loginTimestamp;
      sessionStates.set(`${code}:${id}`, { ...state, hasLoggedIn: false, reassigned: true, tokensConsumed: 137 });
      const rejoined = await login(body);
      expect(rejoined.status).toBe(200);
      expect(await rejoined.json()).toMatchObject({ isReassigned: true, reassigned: true });
      expect(db.query("SELECT has_logged_in, login_timestamp, tokens_consumed, reassigned FROM session_states WHERE session_code = ? AND student_id = ?").get(code, id))
        .toEqual({ has_logged_in: 1, login_timestamp: originalTime, tokens_consumed: 137, reassigned: 0 });
    } finally { db.close(); sessions.delete(code); studentAccounts.delete(`${id}:admin`); }
  });
}
