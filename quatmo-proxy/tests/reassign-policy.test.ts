import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { Database } from "bun:sqlite";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { unifiedAuthMiddleware } = await import("../src/middleware/authUnified");
const { sessions, sessionStates, studentAccounts, studentGroups } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/session", sessionAuthRouter);
app.get("/ai", unifiedAuthMiddleware(), (c) => c.json({ ok: true }));

test("reassign preserves participation and the existing versionless FVSCODE token contract", async () => {
  const code = "REASSIGN_POLICY_TEST";
  const id = "SE_POLICY";
  const group = "Reassign Policy Group";
  const now = Math.floor(Date.now() / 1000);
  sessions.set(code, { sessionCode: code, startTime: now - 60, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set([id]), assignedGroups: [group], createdAt: Date.now(), createdBy: "admin" });
  sessionStates.set(`${code}:${id}`, { sessionCode: code, studentId: id, hasLoggedIn: true, loginTimestamp: now - 30, tokensConsumed: 137, reassigned: false });
  studentAccounts.set(`${id}:admin`, { studentId: id, createdBy: "admin", passwordHash: await Bun.password.hash("fixture-password", "bcrypt") });
  studentGroups.set(`${group}:admin`, { name: group, userIds: [id], createdBy: "admin" });
  const adminHeaders = { Authorization: `Bearer ${process.env.PROXY_API_KEY}`, "Content-Type": "application/json" };
  const oldToken = await sign({ sessionCode: code, studentId: id, loginTime: now - 30, aiValidityMinutes: 60, sessionEndTime: now + 3500, exp: now + 3500 }, getJwtSecret(), "HS256");
  const access = (token: string, route = "/ai") => app.request(route, { headers: { Authorization: `Bearer ${token}` } });
  try {
    expect((await access(oldToken)).status).toBe(200);
    expect((await app.request(`/admin/sessions/${code}/students/${id}/reassign`, { method: "POST", headers: adminHeaders })).status).toBe(200);
    expect(sessionStates.get(`${code}:${id}`)).toMatchObject({ hasLoggedIn: false, reassigned: true, loginTimestamp: now - 30 });
    expect((await access(oldToken)).status).toBe(200);
    expect((await access(oldToken, "/session/status")).status).toBe(200);
    expect((await app.request(`/admin/sessions/${code}`, { method: "DELETE", headers: adminHeaders })).status).toBe(400);
    expect((await app.request(`/admin/sessions/${code}/students/${id}`, { method: "DELETE", headers: adminHeaders })).status).toBe(400);
    expect((await app.request(`/admin/sessions/${code}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ assignedGroups: [], allowedStudentIds: [] }) })).status).toBe(200);
    expect(sessions.get(code)!.allowedStudentIds.has(id)).toBe(true);
    expect(sessionStates.get(`${code}:${id}`)!.tokensConsumed).toBe(137);
    sessions.get(code)!.assignedGroups = [group];
    sessions.set(code, sessions.get(code)!);
    expect((await app.request(`/admin/groups/${encodeURIComponent(group)}/students/${id}`, { method: "DELETE", headers: adminHeaders })).status).toBe(200);
    expect(sessions.get(code)!.allowedStudentIds.has(id)).toBe(true);
    expect(sessionStates.get(`${code}:${id}`)!.tokensConsumed).toBe(137);
    const login = await app.request("/session/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionCode: code, studentId: id, password: "fixture-password" }) });
    expect(login.status).toBe(200);
    const data = await login.json();
    expect(data.isReassigned).toBe(true);
    const claims: any = await verify(data.token, getJwtSecret(), "HS256");
    expect(claims).not.toHaveProperty("tokenVersion");
    expect(claims.loginTime).toBe(now - 30);
    const persisted = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    try {
      expect(persisted.query("SELECT has_logged_in, reassigned, tokens_consumed FROM session_states WHERE session_code = ? AND student_id = ?").get(code, id))
        .toEqual({ has_logged_in: 1, reassigned: 0, tokens_consumed: 137 });
      expect((persisted.query("PRAGMA table_info(session_states)").all() as Array<{ name: string }>).some((column) => column.name === "token_version")).toBe(false);
    } finally { persisted.close(); }
    expect((await access(data.token)).status).toBe(200);
    expect((await access(data.token, "/session/status")).status).toBe(200);
    expect((await access(oldToken)).status).toBe(200);
    expect((await app.request(`/admin/sessions/${code}/students/${id}/reassign`, { method: "POST", headers: adminHeaders })).status).toBe(200);
    expect((await access(data.token)).status).toBe(200);
  } finally {
    sessions.delete(code); sessionStates.delete(`${code}:${id}`);
    studentAccounts.delete(`${id}:admin`); studentGroups.delete(`${group}:admin`);
  }
});
