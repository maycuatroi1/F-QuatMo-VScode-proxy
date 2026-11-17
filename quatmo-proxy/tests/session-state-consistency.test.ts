import { expect, test } from "bun:test";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, sessionStates } = await import("../src/services/sessionStore");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const headers = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const storePath = fileURLToPath(new URL("../src/services/sessionStore.ts", import.meta.url));

function seed(code: string, joined: boolean) {
  sessions.set(code, {
    sessionCode: code, startTime: Math.floor(Date.now() / 1000), durationMinutes: 60,
    aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000,
    allowedStudentIds: new Set(["SECONSISTENCY"]), createdAt: Date.now(), createdBy: "admin",
  });
  sessionStates.set(`${code}:SECONSISTENCY`, {
    sessionCode: code, studentId: "SECONSISTENCY", hasLoggedIn: joined,
    loginTimestamp: joined ? Math.floor(Date.now() / 1000) - 20 : 0,
    tokensConsumed: joined ? 137 : 0, reassigned: false, latestClassification: "mixed",
  });
}

function persistedState(code: string) {
  // A separate process opens the same sandbox DB to exercise real hydration.
  const source = `const { sessionStates } = await import(${JSON.stringify(storePath)}); console.log("STATE:" + JSON.stringify(sessionStates.get(${JSON.stringify(`${code}:SECONSISTENCY`)}) ?? null));`;
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
    cwd: process.cwd(), env: process.env, timeout: 10000,
  });
  expect(child.exitCode).toBe(0);
  const line = child.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("STATE:"));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(6));
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: reassignment flags and usage survive process restart`, async () => {
    const code = `REASSIGN_PERSIST_${index}`;
    seed(code, true);
    const before = structuredClone(sessionStates.get(`${code}:SECONSISTENCY`)!);
    try {
      const response = await app.request(`${prefix}/sessions/${code}/students/SECONSISTENCY/reassign`, { method: "POST", headers });
      expect(response.status).toBe(200);
      const hydrated = persistedState(code);
      expect(hydrated.hasLoggedIn).toBe(false);
      expect(hydrated.reassigned).toBe(true);
      expect(hydrated.tokensConsumed).toBe(before.tokensConsumed);
      expect(hydrated.loginTimestamp).toBe(before.loginTimestamp);
      expect(hydrated.latestClassification).toBe(before.latestClassification);
    } finally { sessions.delete(code); sessionStates.delete(`${code}:SECONSISTENCY`); }
  });

  test(`${prefix}: deleting an unjoined session removes only its own cached states`, async () => {
    const code = `DELETE_CACHE_${index}`;
    const other = `${code}_OTHER`;
    seed(code, false);
    seed(other, false);
    const otherBefore = structuredClone(sessionStates.get(`${other}:SECONSISTENCY`));
    try {
      const response = await app.request(`${prefix}/sessions/${code}`, { method: "DELETE", headers });
      expect(response.status).toBe(200);
      expect(sessionStates.has(`${code}:SECONSISTENCY`)).toBe(false);
      expect(persistedState(code)).toBeNull();
      expect(sessionStates.get(`${other}:SECONSISTENCY`)).toEqual(otherBefore);
      expect(persistedState(other)).toMatchObject(otherBefore!);
    } finally {
      for (const key of [code, other]) { sessions.delete(key); sessionStates.delete(`${key}:SECONSISTENCY`); }
    }
  });
}
