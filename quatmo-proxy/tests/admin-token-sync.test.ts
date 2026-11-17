import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { lecturerAccounts, sessions, sessionStates } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const headers = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };

function fixture(code: string, owner = "admin") {
  const directory = path.join(process.cwd(), "logs", "sessions", code);
  sessions.set(code, {
    sessionCode: code, startTime: Math.floor(Date.now() / 1000), durationMinutes: 60,
    aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000,
    allowedStudentIds: new Set(["SESYNC", "SEKEEP"]), createdAt: 1, createdBy: owner,
  });
  for (const studentId of ["SESYNC", "SEKEEP"]) sessionStates.set(`${code}:${studentId}`, {
    sessionCode: code, studentId, hasLoggedIn: true, loginTimestamp: 123,
    tokensConsumed: 99, reassigned: false, latestClassification: "mixed",
  });
  return {
    directory,
    write(name: string, content: string) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, name), content);
    },
    state() { return sessionStates.get(`${code}:SESYNC`)!; },
    persisted() {
      const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
      try { return db.query("SELECT tokens_consumed FROM session_states WHERE session_code = ? AND student_id = ?").get(code, "SESYNC"); }
      finally { db.close(); }
    },
    cleanup() {
      sessions.delete(code);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  const sync = (code: string, auth = headers) => app.request(`${prefix}/sessions/${code}/sync-tokens`, { method: "POST", headers: auth });

  test(`${prefix}: token sync preserves owner access and handles missing/corrupt sources`, async () => {
    const code = `SYNC_ACCESS_${index}`;
    const owner = `sync-owner-${index}`;
    const other = `${owner}-other`;
    const data = fixture(code, owner);
    for (const username of [owner, other]) lecturerAccounts.set(username, {
      username, name: username, passwordHash: "fixture-only", status: "active",
      createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
    });
    const auth = async (username: string) => ({ Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` });
    try {
      expect((await app.request(`${prefix}/sessions/${code}/sync-tokens`, { method: "POST" })).status).toBe(401);
      expect((await sync(code, await auth(other))).status).toBe(403);
      expect(data.state().tokensConsumed).toBe(99);
      expect(fs.existsSync(data.directory)).toBe(false);
      const missing = await sync(code, await auth(owner));
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual({ success: true, sessionCode: code, updatedCount: 0, students: [] });
      data.write("session_manifest.json", "{broken-json");
      expect(await (await sync(code)).json()).toEqual({ success: true, sessionCode: code, updatedCount: 0, students: [] });
      expect(data.persisted()).toEqual({ tokens_consumed: 99 });
    } finally {
      data.cleanup();
      for (const username of [owner, other]) lecturerAccounts.delete(username);
    }
  });

  test(`${prefix}: manifest token sync persists only matching students and is repeatable`, async () => {
    const code = `SYNC_MANIFEST_${index}`;
    const data = fixture(code);
    const other = fixture(`${code}_OTHER`);
    data.write("session_manifest.json", "\uFEFF" + JSON.stringify({ students: [
      { studentId: "sesync", tokensConsumed: 321, promptTurns: 4 },
      { studentId: "UNKNOWN", tokensConsumed: 888 },
      { studentId: "SEKEEP", tokensConsumed: "invalid" },
      { tokensConsumed: 12 },
    ] }));
    try {
      const response = await sync(code);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, sessionCode: code, updatedCount: 1, students: [{ studentId: "SESYNC", oldTokens: 99, newTokens: 321 }] });
      expect(data.state()).toMatchObject({ tokensConsumed: 321, promptCount: 4, loginTimestamp: 123, hasLoggedIn: true, latestClassification: "mixed" });
      expect(data.persisted()).toEqual({ tokens_consumed: 321 });
      expect(sessionStates.get(`${code}:SEKEEP`)!.tokensConsumed).toBe(99);
      expect(sessionStates.has(`${code}:UNKNOWN`)).toBe(false);
      expect(other.persisted()).toEqual({ tokens_consumed: 99 });
      expect(await (await sync(code)).json()).toEqual({ success: true, sessionCode: code, updatedCount: 0, students: [] });
    } finally { data.cleanup(); other.cleanup(); }
  });

  test(`${prefix}: corrupt manifest and ZIP fall through to the next ZIP source`, async () => {
    const code = `SYNC_ZIP_${index}`;
    const data = fixture(code);
    const corruptZip = path.join(process.cwd(), `logs_${code}.zip`);
    const validZip = path.join(process.cwd(), `session-${code}-logs.zip`);
    const zip = new AdmZip();
    zip.addFile("session_manifest.json", Buffer.from(JSON.stringify({ students: [{ studentId: "SESYNC", tokensConsumed: 456 }] })));
    data.write("session_manifest.json", "invalid");
    fs.writeFileSync(corruptZip, "invalid ZIP");
    fs.writeFileSync(validZip, zip.toBuffer());
    try {
      expect(await (await sync(code)).json()).toEqual({ success: true, sessionCode: code, updatedCount: 1, students: [{ studentId: "SESYNC", oldTokens: 99, newTokens: 456 }] });
      expect(data.persisted()).toEqual({ tokens_consumed: 456 });
      expect(fs.readFileSync(path.join(data.directory, "session_manifest.json"), "utf8")).toBe("invalid");
    } finally {
      data.cleanup();
      for (const file of [corruptZip, validZip]) fs.rmSync(file, { force: true });
    }
  });

  test(`${prefix}: real prompt reconciliation excludes ghost turns and preserves backup evidence`, async () => {
    const code = `SYNC_PROMPTS_${index}`;
    const data = fixture(code);
    const timestamp = "2026-11-17T00:00:00.000Z";
    const turn = { timestamp, createdAt: timestamp, completedAt: timestamp, responseDurationMs: 0 };
    const original = JSON.stringify([
      { ...turn, prompt: "Explain this function", tokensConsumedTotal: 40 },
      { ...turn, prompt: "Text before cursor: hidden completion", tokensConsumedTotal: 900 },
      { ...turn, prompt: "Review this loop", tokensConsumedTotal: 45 },
    ]);
    data.write("SESYNC.json", original);
    data.write("session_manifest.json", JSON.stringify({ students: [{ studentId: "SESYNC", tokensConsumed: 999 }] }));
    try {
      const response = await sync(code);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, sessionCode: code, updatedCount: 1, students: [{ studentId: "SESYNC", oldTokens: 99, newTokens: 85 }] });
      expect(data.state()).toMatchObject({ tokensConsumed: 85, promptCount: 2, loginTimestamp: 123 });
      expect(data.persisted()).toEqual({ tokens_consumed: 85 });
      expect(JSON.parse(fs.readFileSync(path.join(data.directory, "SESYNC.json"), "utf8"))).toHaveLength(2);
      expect(JSON.parse(fs.readFileSync(path.join(data.directory, "session_manifest.json"), "utf8")).students[0]).toMatchObject({ tokensConsumed: 85, promptTurns: 2 });
      const backups = fs.readdirSync(data.directory).filter((file) => file.startsWith("SESYNC.json.bak."));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(data.directory, backups[0]), "utf8")).toBe(original);
      expect((await (await sync(code)).json()).updatedCount).toBe(0);
    } finally { data.cleanup(); }
  });
}
