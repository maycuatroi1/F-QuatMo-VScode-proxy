import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts } = await import("../src/services/sessionStore");
const { recordFailedAttempt, checkLockout, unlockTarget } = await import("../src/services/rateLimiter");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const username = "security-fixture-lecturer";
lecturerAccounts.set(username, {
  username, name: "Fixture Lecturer", passwordHash: "unused-test-hash", status: "active",
  createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
});
afterAll(() => lecturerAccounts.delete(username));
async function token(role: string, subject = "admin") {
  return sign({ role, username: subject, exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
}

for (const prefix of ["/admin", "/v1/admin"]) {
  test(`${prefix}: security rejects anonymous and lecturer requests`, async () => {
    for (const [method, suffix] of [["GET", "lockouts"], ["POST", "unlock"]]) {
      expect((await app.request(`${prefix}/security/${suffix}`, { method })).status).toBe(401);
      const denied = await app.request(`${prefix}/security/${suffix}`, {
        method, headers: { Authorization: `Bearer ${await token("lecturer", username)}` },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "Forbidden. Super Admin access required." });
    }
  });
  test(`${prefix}: invalid bearer cannot gain access through master API key`, async () => {
    const denied = await app.request(`${prefix}/security/lockouts`, {
      headers: { Authorization: "Bearer invalid", "x-api-key": process.env.PROXY_API_KEY! },
    });
    expect(denied.status).toBe(401);
  });
  test(`${prefix}: administrator lists and clears a real local lockout`, async () => {
    const ip = prefix === "/admin" ? "192.0.2.11" : "192.0.2.12";
    const account = `${username}-${prefix}`;
    const headers = { Authorization: `Bearer ${await token("admin")}`, "Content-Type": "application/json" };
    try {
      for (let i = 0; i < 10; i++) await recordFailedAttempt(ip, account);
      expect((await checkLockout(ip, account)).isLocked).toBe(true);
      const list = await app.request(`${prefix}/security/lockouts`, { headers });
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.success).toBe(true);
      expect(body.lockedIPs.some((item: any) => item.ip === ip)).toBe(true);
      const invalid = await app.request(`${prefix}/security/unlock`, { method: "POST", headers, body: "{}" });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "Fields 'type' and 'target' are required." });
      const unlocked = await app.request(`${prefix}/security/unlock`, {
        method: "POST", headers, body: JSON.stringify({ type: "ip", target: ip }),
      });
      expect(await unlocked.json()).toEqual({ success: true, message: `Lockout cleared for ip '${ip}'.` });
      expect((await checkLockout(ip, "other-unlocked-account")).isLocked).toBe(false);
    } finally {
      await unlockTarget("ip", ip);
      await unlockTarget("account", account);
    }
  });
}
