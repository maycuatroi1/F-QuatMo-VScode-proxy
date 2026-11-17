import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts, studentAccounts, sessions, sessionStates, studentGroups } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: scoped user import, password reset and SQLite persistence`, async () => {
    const owner = `users-fixture-${index}`;
    const other = `${owner}-other`;
    const id = `USER_FIXTURE_${index}`;
    for (const username of [owner, other]) lecturerAccounts.set(username, {
      username, name: username, passwordHash: "fixture-only", status: "active",
      createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
    });
    const request = async (username: string, suffix: string, method = "GET", body?: any, role = "lecturer") => app.request(`${prefix}${suffix}`, {
      method, headers: { Authorization: `Bearer ${await sign({ username, role, exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    const stored = () => db.query("SELECT password_hash, created_by FROM student_accounts WHERE student_id = ? AND created_by = ?").get(id, owner) as any;
    try {
      expect((await app.request(`${prefix}/students`)).status).toBe(401);
      expect((await request(owner, "/students", "POST", {})).status).toBe(400);
      const imported = await request(owner, "/students/import", "POST", { students: [
        { studentId: ` ${id.toLowerCase()} `, password: "initial-password" },
        { studentId: id, password: "must-not-overwrite" }, { studentId: "", password: "invalid" },
      ] });
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ importedCount: 1, skippedCount: 1 });
      expect(await Bun.password.verify("initial-password", stored().password_hash)).toBe(true);
      expect((await (await request(owner, "/students", "POST", { students: [{ studentId: id, password: "overwrite" }] })).json()).skippedCount).toBe(1);
      expect(await Bun.password.verify("initial-password", stored().password_hash)).toBe(true);
      await request(other, "/students", "POST", { students: [{ studentId: id, password: "other-password" }] });
      const list = await (await request(owner, "/students")).json();
      expect(list.students.filter((item: any) => item.studentId === id).map((item: any) => item.createdBy)).toEqual([owner]);
      expect(list.students.every((item: any) => item.passwordHash === undefined && item.password === undefined)).toBe(true);
      const all = await (await request("admin", "/students", "GET", undefined, "admin")).json();
      expect(all.students.filter((item: any) => item.studentId === id).length).toBe(2);
      expect((await request(owner, `/students/${id}/reset-password`, "POST", { newPassword: " " })).status).toBe(400);
      expect((await request(owner, `/students/${id.toLowerCase()}/reset-password`, "POST", { newPassword: " reset-password " })).status).toBe(200);
      expect(await Bun.password.verify("reset-password", stored().password_hash)).toBe(true);
      expect(await Bun.password.verify("other-password", studentAccounts.get(`${id}:${other}`)!.passwordHash)).toBe(true);
      expect(stored().created_by).toBe(owner);
    } finally {
      db.close();
      for (const username of [owner, other]) {
        lecturerAccounts.delete(username);
        studentAccounts.delete(`${id}:${username}`);
      }
    }
  });

  test(`${prefix}: user deletion retains linked evidence and removes only unlinked accounts`, async () => {
    const owner = `delete-fixture-${index}`;
    const foreignOwner = `${owner}-foreign`;
    const linked = `LINKED_FIXTURE_${index}`;
    const unlinked = `UNLINKED_FIXTURE_${index}`;
    const foreign = `FOREIGN_FIXTURE_${index}`;
    const stateOnly = `STATE_FIXTURE_${index}`;
    const code = `DELETE_FIXTURE_${index}`;
    const groupName = `Delete Fixture ${index}`;
    lecturerAccounts.set(owner, { username: owner, name: owner, passwordHash: "fixture", status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin" });
    const jwt = await sign({ username: owner, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
    const request = (suffix: string, method: string, body?: any) => app.request(`${prefix}${suffix}`, {
      method, headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const id of [linked, unlinked, stateOnly]) studentAccounts.set(`${id}:${owner}`, { studentId: id, passwordHash: "fixture", createdBy: owner });
    studentAccounts.set(`${foreign}:${foreignOwner}`, { studentId: foreign, passwordHash: "fixture", createdBy: foreignOwner });
    sessions.set(code, { sessionCode: code, startTime: Math.floor(Date.now() / 1000), durationMinutes: 60, aiOption: "chatbot", aiValidityMinutes: 60, defaultTokenBudget: 100, allowedStudentIds: new Set([linked]), createdAt: Date.now(), createdBy: owner });
    sessionStates.set(`${code}:${stateOnly}`, { sessionCode: code, studentId: stateOnly, hasLoggedIn: true, loginTimestamp: Date.now(), tokensConsumed: 17, reassigned: false });
    studentGroups.set(`${groupName}:${owner}`, { name: groupName, userIds: [linked, unlinked], createdBy: owner });
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    const row = (id: string) => db.query("SELECT is_deleted, deleted_at FROM student_accounts WHERE student_id = ? AND created_by = ?").get(id, owner) as any;
    try {
      expect((await request(`/students/${foreign}`, "DELETE")).status).toBe(404);
      expect((await request(`/students/${foreign}/restore`, "POST")).status).toBe(404);
      expect((await (await request(`/students/${linked}`, "DELETE")).json()).action).toBe("soft_deleted");
      expect(row(linked).is_deleted).toBe(1);
      expect(sessions.get(code)!.allowedStudentIds.has(linked)).toBe(true);
      expect((await request(`/students/${linked}/restore`, "POST")).status).toBe(200);
      expect(row(linked).is_deleted).toBe(0);
      expect(row(linked).deleted_at).toBeNull();
      expect((await (await request(`/students/${unlinked.toLowerCase()}`, "DELETE")).json()).action).toBe("hard_deleted");
      expect(row(unlinked)).toBeNull();
      expect(studentGroups.get(`${groupName}:${owner}`)!.userIds).toEqual([linked]);
      expect((await request("/students/bulk-delete", "POST", { studentIds: [] })).status).toBe(400);
      const bulk = await request("/students/bulk-delete", "POST", { studentIds: [linked.toLowerCase(), stateOnly, foreign, "MISSING_FIXTURE"] });
      expect(bulk.status).toBe(200);
      expect(await bulk.json()).toMatchObject({ softDeletedCount: 2, hardDeletedCount: 0 });
      expect(row(linked).is_deleted).toBe(1);
      expect(row(stateOnly).is_deleted).toBe(1);
      expect(sessionStates.get(`${code}:${stateOnly}`)!.tokensConsumed).toBe(17);
      expect(studentAccounts.get(`${foreign}:${foreignOwner}`)!.isDeleted).toBeUndefined();
    } finally {
      db.close();
      lecturerAccounts.delete(owner);
      for (const id of [linked, unlinked, stateOnly]) studentAccounts.delete(`${id}:${owner}`);
      studentAccounts.delete(`${foreign}:${foreignOwner}`);
      studentGroups.delete(`${groupName}:${owner}`);
      sessionStates.delete(`${code}:${stateOnly}`);
      sessions.delete(code);
    }
  });
}
