import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts, sessions, sessionStates, studentGroups } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: session roster preserves joined students, ownership and usage on reassign`, async () => {
    const owner = `session-fixture-${index}`;
    const other = `${owner}-other`;
    const groupName = `Session Group ${index}`;
    let code = "";
    for (const username of [owner, other]) lecturerAccounts.set(username, {
      username, name: username, passwordHash: "fixture-only", status: "active",
      createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
    });
    studentGroups.set(`${groupName}:${owner}`, { name: groupName, userIds: ["SESTAY", "SELEAVE"], createdBy: owner });
    const request = async (username: string, suffix: string, method = "GET", body?: any) => app.request(`${prefix}${suffix}`, {
      method, headers: { Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    const stateRow = (id: string) => db.query("SELECT * FROM session_states WHERE session_code = ? AND student_id = ?").get(code, id) as any;
    try {
      expect((await request(owner, "/sessions", "POST", {})).status).toBe(400);
      const config = { enabled: true, runtimeType: "python", runtimeVersion: "3.11", packages: ["pytest"] };
      const created = await request(owner, "/sessions", "POST", { durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000, assignedGroups: [groupName], promptMode: "socratic_tutor", runtimeConfig: config });
      expect(created.status).toBe(200);
      const createdBody = await created.json();
      code = createdBody.sessionCode;
      expect(createdBody.session.allowedStudentIds).toEqual(["SESTAY", "SELEAVE"]);
      expect(createdBody.session.runtimeConfig).toEqual(config);
      expect(stateRow("SESTAY").has_logged_in).toBe(0);
      const stored = db.query("SELECT * FROM sessions WHERE session_code = ?").get(code) as any;
      expect(stored.created_by).toBe(owner);
      expect(stored.prompt_mode).toBe("socratic_tutor");
      expect(JSON.parse(stored.runtime_config)).toEqual(config);
      const joined = { ...sessionStates.get(`${code}:SESTAY`)!, hasLoggedIn: true, loginTimestamp: Date.now() - 2000, tokensConsumed: 123, latestClassification: "mixed" };
      sessionStates.set(`${code}:SESTAY`, joined);
      for (const [method, suffix, body] of [
        ["PATCH", `/sessions/${code}`, { allowedStudentIds: [] }], ["DELETE", `/sessions/${code}`, undefined],
        ["POST", `/sessions/${code}/students`, { studentIds: ["FOREIGN"] }],
        ["DELETE", `/sessions/${code}/students/SESTAY`, undefined],
        ["POST", `/sessions/${code}/students/SESTAY/reassign`, undefined],
      ] as const) expect((await request(other, suffix, method, body)).status).toBe(403);
      expect(sessionStates.get(`${code}:SESTAY`)).toEqual(joined);
      const changed = await request(owner, `/sessions/${code.toLowerCase()}`, "PATCH", { assignedGroups: [], allowedStudentIds: [" senew "] });
      expect(changed.status).toBe(200);
      expect(sessions.get(code)!.allowedStudentIds.has("SESTAY")).toBe(true);
      expect(sessions.get(code)!.allowedStudentIds.has("SENEW")).toBe(true);
      expect(sessions.get(code)!.allowedStudentIds.has("SELEAVE")).toBe(false);
      expect(stateRow("SELEAVE")).toBeNull();
      expect(stateRow("SESTAY").tokens_consumed).toBe(123);
      expect(stateRow("SENEW").has_logged_in).toBe(0);
      const list = await (await request(owner, "/sessions")).json();
      expect(list.sessions.find((session: any) => session.sessionCode === code).students.find((student: any) => student.studentId === "SESTAY").tokensConsumed).toBe(123);
      const foreignList = await (await request(other, "/sessions")).json();
      expect(foreignList.sessions.some((session: any) => session.sessionCode === code)).toBe(false);
      expect((await request(owner, `/sessions/${code}/students/SESTAY`, "DELETE")).status).toBe(400);
      expect((await request(owner, `/sessions/${code}`, "DELETE")).status).toBe(400);
      expect((await request(owner, `/sessions/${code}/students`, "POST", {})).status).toBe(400);
      expect((await request(owner, `/sessions/${code}/students`, "POST", { studentIds: ["sextra"] })).status).toBe(200);
      expect(stateRow("SEXTRA").has_logged_in).toBe(0);
      expect((await request(owner, `/sessions/${code}/students/sextra`, "DELETE")).status).toBe(200);
      expect(stateRow("SEXTRA")).toBeNull();
      expect((await request(owner, `/sessions/${code}/students/MISSING/reassign`, "POST")).status).toBe(404);
      expect((await request(owner, `/sessions/${code}/students/SESTAY/reassign`, "POST")).status).toBe(200);
      expect(sessionStates.get(`${code}:SESTAY`)).toEqual({ ...joined, hasLoggedIn: false, reassigned: true });
    } finally {
      db.close();
      if (code) {
        sessions.delete(code);
        for (const id of ["SESTAY", "SELEAVE", "SENEW", "SEXTRA"]) sessionStates.delete(`${code}:${id}`);
      }
      studentGroups.delete(`${groupName}:${owner}`);
      for (const username of [owner, other]) lecturerAccounts.delete(username);
    }
  });

  test(`${prefix}: deleting an unjoined session cascades persisted states`, async () => {
    let code = "";
    const headers = { Authorization: `Bearer ${process.env.PROXY_API_KEY}`, "Content-Type": "application/json" };
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    try {
      const created = await app.request(`${prefix}/sessions`, { method: "POST", headers, body: JSON.stringify({ durationMinutes: 60, aiOption: "chatbot", aiValidityMinutes: 60, defaultTokenBudget: 1000 }) });
      expect(created.status).toBe(200);
      code = (await created.json()).sessionCode;
      expect((await app.request(`${prefix}/sessions/${code}/students`, { method: "POST", headers, body: JSON.stringify({ studentIds: ["SEUNJOINED"] }) })).status).toBe(200);
      expect(db.query("SELECT COUNT(*) AS count FROM session_states WHERE session_code = ?").get(code)).toEqual({ count: 1 });
      expect((await app.request(`${prefix}/sessions/${code}`, { method: "DELETE", headers })).status).toBe(200);
      expect(sessions.has(code)).toBe(false);
      expect(db.query("SELECT * FROM sessions WHERE session_code = ?").get(code)).toBeNull();
      expect(db.query("SELECT COUNT(*) AS count FROM session_states WHERE session_code = ?").get(code)).toEqual({ count: 0 });
      expect((await app.request(`${prefix}/sessions/${code}`, { method: "DELETE", headers })).status).toBe(404);
    } finally {
      db.close();
      if (code) { sessions.delete(code); sessionStates.delete(`${code}:SEUNJOINED`); }
    }
  });
}
