import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);

for (const prefix of ["/admin", "/v1/admin"]) {
  test(`${prefix}: lecturer lifecycle preserves validation, persistence and secret redaction`, async () => {
    const username = prefix === "/admin" ? "fixture-lecturer-a" : "fixture-lecturer-b";
    const jwt = await sign({ role: "admin", username: "admin", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
    const headers = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
    const request = (suffix: string, method = "GET", body?: any) => app.request(`${prefix}${suffix}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      expect((await request("/lecturers", "POST", {})).status).toBe(400);
      const created = await request("/lecturers", "POST", { username, name: " Fixture ", password: "original-password" });
      expect(created.status).toBe(200);
      const createdBody = await created.json();
      expect(createdBody.lecturer.name).toBe("Fixture");
      expect(createdBody.lecturer.passwordHash).toBeUndefined();
      expect(await Bun.password.verify("original-password", lecturerAccounts.get(username)!.passwordHash)).toBe(true);
      expect((await request("/lecturers", "POST", { username, name: "Duplicate", password: "x" })).status).toBe(400);
      const list = await (await request("/lecturers")).json();
      expect(list.lecturers.some((item: any) => item.username === username)).toBe(true);
      expect(list.lecturers.every((item: any) => item.passwordHash === undefined)).toBe(true);
      const details = await request(`/lecturers/${username}/details`);
      expect(details.status).toBe(200);
      expect((await details.json()).lecturer.passwordHash).toBeUndefined();
      expect((await request("/lecturers/missing-fixture/details")).status).toBe(404);
      const disabled = await (await request(`/lecturers/${username}/status`, "PATCH", { status: "inactive" })).json();
      expect(disabled.lecturer.status).toBe("inactive");
      expect(lecturerAccounts.get(username)!.status).toBe("inactive");
      const enabled = await (await request(`/lecturers/${username}/status`, "PATCH", {})).json();
      expect(enabled.lecturer.status).toBe("active");
      const reset = await request(`/lecturers/${username}/reset-password`, "POST", { newPassword: " next-password " });
      expect(reset.status).toBe(200);
      expect((await reset.json()).newPassword).toBe("next-password");
      expect(await Bun.password.verify("next-password", lecturerAccounts.get(username)!.passwordHash)).toBe(true);
      const lecturerJwt = await sign({ role: "lecturer", username, exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
      for (const [method, suffix] of [
        ["GET", "/lecturers"], ["GET", `/lecturers/${username}/details`], ["POST", "/lecturers"],
        ["PATCH", `/lecturers/${username}/status`], ["POST", `/lecturers/${username}/reset-password`],
      ]) {
        const denied = await app.request(`${prefix}${suffix}`, { method, headers: { Authorization: `Bearer ${lecturerJwt}` } });
        expect(denied.status).toBe(403);
      }
    } finally {
      lecturerAccounts.delete(username);
    }
  });
}
