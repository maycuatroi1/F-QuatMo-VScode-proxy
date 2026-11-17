import { expect, test } from "bun:test";
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
  test(`${prefix}: group ownership, membership and overlapping session rosters`, async () => {
    const owner = `group-fixture-owner-${index}`;
    const other = `group-fixture-other-${index}`;
    const name = `Fixture Group ${index}`;
    const overlap = `Overlap Group ${index}`;
    const code = `GROUP_FIXTURE_${index}`;
    const otherCode = `${code}_OTHER`;
    const groupPath = `/groups/${encodeURIComponent(name)}`;
    for (const username of [owner, other]) lecturerAccounts.set(username, {
      username, name: username, passwordHash: "unused-fixture", status: "active",
      createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
    });
    const jwt = async (username: string, role = "lecturer") => sign({ username, role, exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
    const request = async (username: string, suffix: string, method = "GET", body?: any, role = "lecturer") => app.request(`${prefix}${suffix}`, {
      method, headers: { Authorization: `Bearer ${await jwt(username, role)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      expect((await app.request(`${prefix}/groups`)).status).toBe(401);
      expect((await request(owner, "/groups", "POST", {})).status).toBe(400);
      expect((await request(owner, "/groups", "POST", { name, userIds: [] })).status).toBe(200);
      expect((await request(other, "/groups", "POST", { name, userIds: ["other-student"] })).status).toBe(200);
      const visible = await (await request(owner, "/groups")).json();
      expect(visible.groups.filter((group: any) => group.name === name).map((group: any) => group.createdBy)).toEqual([owner]);
      const all = await (await request("admin", "/groups", "GET", undefined, "admin")).json();
      expect(all.groups.filter((group: any) => group.name === name).length).toBe(2);
      expect((await request(owner, `${groupPath}/students`, "POST", {})).status).toBe(400);
      expect((await request(owner, "/groups/missing-group-fixture/students", "POST", { studentIds: ["X"] })).status).toBe(404);
      await request(owner, "/groups", "POST", { name: overlap, userIds: ["SEKEEP"] });
      const now = Math.floor(Date.now() / 1000);
      for (const [sessionCode, createdBy] of [[code, owner], [otherCode, other]]) sessions.set(sessionCode, {
        sessionCode, createdBy, startTime: now, durationMinutes: 60, aiOption: "chatbot",
        aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(),
        assignedGroups: [name, overlap], createdAt: Date.now(),
      });
      const added = await request(owner, `${groupPath}/students`, "POST", { studentIds: ["sekeep", "seonly", "seonly"] });
      expect(added.status).toBe(200);
      expect((await added.json()).group.userIds).toEqual(["SEKEEP", "SEONLY"]);
      expect([...sessions.get(code)!.allowedStudentIds]).toEqual(["SEKEEP", "SEONLY"]);
      expect(sessions.get(otherCode)!.allowedStudentIds.size).toBe(0);
      expect(sessionStates.get(`${code}:SEONLY`)!.hasLoggedIn).toBe(false);
      // Older clients send userIds rather than studentIds; preserve this alias.
      const alias = await (await request(owner, `${groupPath}/students`, "POST", { userIds: ["seonly"] })).json();
      expect(alias.group.userIds).toEqual(["SEKEEP", "SEONLY"]);
      const removed = await request(owner, `${groupPath}/students/sekeep`, "DELETE");
      expect(removed.status).toBe(200);
      expect(sessions.get(code)!.allowedStudentIds.has("SEKEEP")).toBe(true);
      expect(sessionStates.has(`${code}:SEKEEP`)).toBe(true);
      expect((await request(owner, groupPath, "DELETE")).status).toBe(200);
      expect(studentGroups.has(`${name}:${owner}`)).toBe(false);
      expect(studentGroups.has(`${name}:${other}`)).toBe(true);
      expect(sessions.get(code)!.allowedStudentIds.has("SEONLY")).toBe(false);
      expect(sessionStates.has(`${code}:SEONLY`)).toBe(false);
      expect(sessions.get(code)!.allowedStudentIds.has("SEKEEP")).toBe(true);
      expect((await request(owner, groupPath, "DELETE")).status).toBe(404);
    } finally {
      for (const username of [owner, other]) {
        lecturerAccounts.delete(username);
        studentGroups.delete(`${name}:${username}`);
        studentGroups.delete(`${overlap}:${username}`);
      }
      for (const sessionCode of [code, otherCode]) {
        sessions.delete(sessionCode);
        for (const studentId of ["SEKEEP", "SEONLY"]) sessionStates.delete(`${sessionCode}:${studentId}`);
      }
    }
  });
}
