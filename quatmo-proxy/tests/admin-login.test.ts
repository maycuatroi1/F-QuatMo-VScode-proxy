import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const { unlockTarget } = await import("../src/services/rateLimiter");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function seedLecturer(username: string) {
  lecturerAccounts.set(username, {
    username, name: "Login Fixture", passwordHash: await Bun.password.hash("lecturer-password", "bcrypt"),
    status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
  });
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  const ip = `192.0.2.${100 + index}`;
  const login = (username: string, password: string) => app.request(`${prefix}/login`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ username, password }),
  });
  const change = (token: string, currentPassword: string, newPassword: string) => app.request(`${prefix}/change-password`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }),
  });

  test(`${prefix}: admin and lecturer login preserve validation, roles and seven-day JWTs`, async () => {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    const adminName = `login-admin-${index}`;
    const lecturer = `login-lecturer-${index}`;
    process.env.ADMIN_USERNAME = adminName;
    process.env.ADMIN_PASSWORD = "admin-fixture-password";
    await seedLecturer(lecturer);
    try {
      expect((await login("", "")).status).toBe(400);
      expect((await login(adminName, "wrong")).status).toBe(401);
      const start = Math.floor(Date.now() / 1000);
      const response = await login(` ${adminName} `, "admin-fixture-password");
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({ success: true, username: "admin", role: "admin", name: "Super Admin" });
      expect(Object.keys(data).sort()).toEqual(["name", "role", "success", "token", "username"]);
      const claims = await verify(data.token, getJwtSecret(), "HS256");
      expect(claims).toMatchObject({ username: "admin", role: "admin", name: "Super Admin" });
      expect(claims.exp!).toBeGreaterThanOrEqual(start + 7 * 24 * 60 * 60);
      expect(claims.exp!).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
      expect((await login(lecturer, "wrong")).status).toBe(401);
      const teacherResponse = await login(lecturer, "lecturer-password");
      expect(teacherResponse.status).toBe(200);
      const teacher = await teacherResponse.json();
      expect(await verify(teacher.token, getJwtSecret(), "HS256")).toMatchObject({ username: lecturer, role: "lecturer", name: "Login Fixture" });
      expect((await app.request(`${prefix}/security/lockouts`, { headers: { Authorization: `Bearer ${teacher.token}` } })).status).toBe(403);
      const account = lecturerAccounts.get(lecturer)!;
      lecturerAccounts.set(lecturer, { ...account, status: "inactive" });
      expect((await login(lecturer, "lecturer-password")).status).toBe(403);
      expect((await app.request(`${prefix}/sessions`, { headers: { Authorization: `Bearer ${teacher.token}` } })).status).toBe(401);
    } finally {
      restoreEnv("ADMIN_USERNAME", oldUsername); restoreEnv("ADMIN_PASSWORD", oldPassword);
      lecturerAccounts.delete(lecturer);
      await unlockTarget("ip", ip);
      for (const account of [adminName, lecturer]) await unlockTarget("account", account);
    }
  });

  test(`${prefix}: login retains the ten-attempt lockout and retry headers`, async () => {
    const account = `locked-login-fixture-${index}`;
    try {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const response = await login(account, "wrong");
        expect(response.status).toBe(attempt === 10 ? 429 : 401);
        if (attempt < 10) expect(await response.json()).toMatchObject({ failedAttempts: attempt, remainingAttempts: 10 - attempt });
      }
      const locked = await login(account, "wrong");
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(Number(locked.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now());
      expect(await locked.json()).toMatchObject({ reason: "ip" });
    } finally { await unlockTarget("ip", ip); await unlockTarget("account", account); }
  });

  test(`${prefix}: super-admin password change retains runtime-only behavior`, async () => {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    const username = `password-admin-${index}`;
    process.env.ADMIN_USERNAME = username;
    process.env.ADMIN_PASSWORD = "before-password";
    try {
      expect((await app.request(`${prefix}/change-password`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await change(process.env.PROXY_API_KEY!, "before-password", " ")).status).toBe(400);
      expect((await change(process.env.PROXY_API_KEY!, "wrong", "after-password")).status).toBe(400);
      expect(process.env.ADMIN_PASSWORD).toBe("before-password");
      expect((await change(process.env.PROXY_API_KEY!, "before-password", " after-password ")).status).toBe(200);
      expect(process.env.ADMIN_PASSWORD).toBe("after-password");
      expect((await login(username, "before-password")).status).toBe(401);
      expect((await login(username, "after-password")).status).toBe(200);
    } finally {
      restoreEnv("ADMIN_USERNAME", oldUsername); restoreEnv("ADMIN_PASSWORD", oldPassword);
      await unlockTarget("ip", ip); await unlockTarget("account", username);
    }
  });

  test(`${prefix}: lecturer password change persists the hash and retains existing JWT access`, async () => {
    const username = `password-lecturer-${index}`;
    await seedLecturer(username);
    const token = await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    try {
      const before = lecturerAccounts.get(username)!.passwordHash;
      expect((await change(token, "wrong", "new-password")).status).toBe(400);
      expect(lecturerAccounts.get(username)!.passwordHash).toBe(before);
      expect((await change(token, "lecturer-password", " new-password ")).status).toBe(200);
      const account = lecturerAccounts.get(username)!;
      expect(await Bun.password.verify("new-password", account.passwordHash)).toBe(true);
      expect(await Bun.password.verify("lecturer-password", account.passwordHash)).toBe(false);
      expect(account.updatedBy).toBe(username);
      const row = db.query("SELECT password_hash, updated_at, updated_by FROM lecturer_accounts WHERE username = ?").get(username);
      expect(row).toEqual({ password_hash: account.passwordHash, updated_at: account.updatedAt, updated_by: username });
      expect((await app.request(`${prefix}/sessions`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      expect((await login(username, "new-password")).status).toBe(200);
    } finally {
      db.close(); lecturerAccounts.delete(username);
      await unlockTarget("ip", ip); await unlockTarget("account", username);
    }
  });
}
