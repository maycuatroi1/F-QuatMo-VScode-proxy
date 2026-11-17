import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts, studentAccounts, studentGroups } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);

for (const [alias, prefix] of ["/admin", "/v1/admin"].entries()) {
  for (const bulk of [false, true]) {
    for (const scenario of ["lecturer", "super-admin", "legacy-admin"]) {
      test(`${prefix}: ${bulk ? "bulk" : "single"} hard-delete isolates groups (${scenario})`, async () => {
        const suffix = `${alias}-${bulk}-${scenario}`;
        const owner = scenario === "legacy-admin" ? "admin" : `Deletion-Owner-${suffix}`;
        const other = `other-owner-${suffix}`;
        const caller = scenario === "lecturer" ? owner : "admin";
        const id = `SHARED_DELETE_${suffix}`.toUpperCase();
        const ownGroup = `own-${suffix}`;
        const otherGroup = `other-${suffix}`;
        const adminGroup = `admin-${suffix}`;
        if (caller !== "admin") lecturerAccounts.set(caller, {
          username: caller, name: caller, passwordHash: "fixture", status: "active",
          createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
        });
        // Super admin's existing selection behavior chooses the first matching account.
        studentAccounts.set(`${id}:${owner.toLowerCase()}`, {
          studentId: id, passwordHash: "target-fixture", ...(scenario === "legacy-admin" ? {} : { createdBy: owner }),
        });
        studentAccounts.set(`${id}:${other}`, { studentId: id, passwordHash: "other-fixture", createdBy: other });
        studentGroups.set(`${ownGroup}:${owner.toLowerCase()}`, {
          name: ownGroup, userIds: [id.toLowerCase(), "KEEP"],
          ...(scenario === "legacy-admin" ? {} : { createdBy: owner.toUpperCase() }),
        });
        studentGroups.set(`${otherGroup}:${other}`, { name: otherGroup, userIds: [id, "KEEP"], createdBy: other, updatedAt: 123, updatedBy: other });
        if (owner !== "admin") studentGroups.set(`${adminGroup}:admin`, { name: adminGroup, userIds: [id], updatedAt: 123 });
        const otherAccount = structuredClone(studentAccounts.get(`${id}:${other}`));
        const otherBefore = structuredClone(studentGroups.get(`${otherGroup}:${other}`));
        const adminBefore = structuredClone(studentGroups.get(`${adminGroup}:admin`));
        const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
        const groupRow = (name: string) => db.query("SELECT * FROM student_groups WHERE name = ?").get(name);
        const otherPersisted = groupRow(otherGroup);
        const adminPersisted = groupRow(adminGroup);
        try {
          const jwt = await sign({ username: caller, role: scenario === "lecturer" ? "lecturer" : "admin", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
          const response = await app.request(bulk ? `${prefix}/students/bulk-delete` : `${prefix}/students/${id}`, {
            method: bulk ? "POST" : "DELETE",
            headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
            ...(bulk ? { body: JSON.stringify({ studentIds: [id] }) } : {}),
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject(bulk ? { hardDeletedCount: 1, softDeletedCount: 0 } : { action: "hard_deleted" });
          expect(studentAccounts.has(`${id}:${owner.toLowerCase()}`)).toBe(false);
          expect(studentGroups.get(`${ownGroup}:${owner.toLowerCase()}`)!.userIds).toEqual(["KEEP"]);
          expect(JSON.parse((groupRow(ownGroup) as any).user_ids)).toEqual(["KEEP"]);
          expect(studentAccounts.get(`${id}:${other}`)).toEqual(otherAccount);
          expect(studentGroups.get(`${otherGroup}:${other}`)).toEqual(otherBefore);
          expect(groupRow(otherGroup)).toEqual(otherPersisted);
          expect(studentGroups.get(`${adminGroup}:admin`)).toEqual(adminBefore);
          expect(groupRow(adminGroup)).toEqual(adminPersisted);
        } finally {
          db.close();
          if (caller !== "admin") lecturerAccounts.delete(caller);
          studentAccounts.delete(`${id}:${owner.toLowerCase()}`);
          studentAccounts.delete(`${id}:${other}`);
          studentGroups.delete(`${ownGroup}:${owner.toLowerCase()}`);
          studentGroups.delete(`${otherGroup}:${other}`);
          studentGroups.delete(`${adminGroup}:admin`);
        }
      });
    }
  }
}
