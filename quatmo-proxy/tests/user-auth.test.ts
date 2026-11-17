import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { authRouter } = await import("../src/routes/auth");
const { studentAccounts } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const { unlockTarget } = await import("../src/services/rateLimiter");
const app = new Hono();
app.route("/auth", authRouter);
app.route("/v1/auth", authRouter);

for (const [index, prefix] of ["/auth", "/v1/auth"].entries()) {
  const ip = `192.0.2.${170 + index}`;
  const login = (studentId: string, password: string) => app.request(`${prefix}/login`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ studentId, password }),
  });
  const me = (token?: string) => app.request(`${prefix}/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  test(`${prefix}: login preserves multi-owner identities and existing user JWT payload`, async () => {
    const id = `SEUSERLOGIN${index}`;
    const owners = [`user-a-${index}`, `user-b-${index}`, `user-c-${index}`];
    const hash = await Bun.password.hash("fixture-password", "bcrypt");
    for (const [i, owner] of owners.entries()) studentAccounts.set(`${id}:${owner}`, { studentId: id, createdBy: owner, passwordHash: i === 2 ? await Bun.password.hash("other-password", "bcrypt") : hash });
    try {
      expect((await login("", "")).status).toBe(400);
      expect((await login(`${id}_UNKNOWN`, "wrong")).status).toBe(403);
      expect((await login(id, "wrong")).status).toBe(403);
      const before = Math.floor(Date.now() / 1000);
      const response = await login(` ${id.toLowerCase()} `, "fixture-password");
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Object.keys(data).sort()).toEqual(["studentId", "success", "token"]);
      expect(data).toMatchObject({ success: true, studentId: id });
      const payload = await verify(data.token, getJwtSecret(), "HS256");
      expect(payload).toMatchObject({ type: "user", studentId: id, createdBy: owners[0], validLecturers: owners.slice(0, 2) });
      expect(payload.exp!).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60);
      expect(payload).not.toHaveProperty("tokenVersion");
      expect(await (await me(data.token)).json()).toEqual({ success: true, studentId: id });
    } finally {
      for (const owner of owners) studentAccounts.delete(`${id}:${owner}`);
      await unlockTarget("ip", ip); await unlockTarget("account", id);
    }
  });

  test(`${prefix}: me rejects missing, expired, wrong-type and removed-account tokens`, async () => {
    const id = `SEUSERME${index}`;
    studentAccounts.set(`${id}:admin`, { studentId: id, createdBy: "admin", passwordHash: "fixture-only" });
    const now = Math.floor(Date.now() / 1000);
    const token = (payload: object) => sign(payload, getJwtSecret(), "HS256");
    try {
      expect((await me()).status).toBe(401);
      expect((await me("invalid-token")).status).toBe(401);
      expect((await me(await token({ type: "user", studentId: id, exp: now - 1 }))).status).toBe(401);
      expect((await me(await token({ type: "session", studentId: id, exp: now + 600 }))).status).toBe(401);
      const valid = await token({ type: "user", studentId: id, exp: now + 600 });
      expect((await me(valid)).status).toBe(200);
      studentAccounts.delete(`${id}:admin`);
      const removed = await me(valid);
      expect(removed.status).toBe(404);
      expect(await removed.json()).toEqual({ error: "Account no longer exists." });
    } finally { studentAccounts.delete(`${id}:admin`); }
  });

  test(`${prefix}: known-account password failures retain lockout and retry headers`, async () => {
    const id = `SEUSERLOCK${index}`;
    studentAccounts.set(`${id}:admin`, { studentId: id, createdBy: "admin", passwordHash: await Bun.password.hash("fixture-password", "bcrypt") });
    try {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const response = await login(id, "wrong");
        expect(response.status).toBe(attempt === 10 ? 429 : 403);
        if (attempt < 10) expect(await response.json()).toMatchObject({ failedAttempts: attempt, remainingAttempts: 10 - attempt });
      }
      const locked = await login(id, "fixture-password");
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(Number(locked.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now());
    } finally {
      studentAccounts.delete(`${id}:admin`);
      await unlockTarget("ip", ip); await unlockTarget("account", id);
    }
  });
}
