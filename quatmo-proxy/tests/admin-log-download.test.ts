import { expect, test } from "bun:test";
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
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const sensitiveNames = [".env", ".env.production", "server.key", "server.pem", "quatmo.db", "quatmo.db-wal", "data.db", "data.db-shm", "data.sqlite", "client_gate_state.json"];

function fixture(code: string) {
  const owner = `download-owner-${code.toLowerCase()}`;
  sessions.set(code, {
    sessionCode: code, startTime: 123, durationMinutes: 60, aiOption: "agent",
    aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEDOWNLOAD"]),
    createdAt: 123456, endedAt: 234567, createdBy: owner,
  });
  sessionStates.set(`${code}:SEDOWNLOAD`, {
    sessionCode: code, studentId: "SEDOWNLOAD", hasLoggedIn: true,
    loginTimestamp: 123, tokensConsumed: 137, reassigned: false, latestClassification: "mixed",
  });
  lecturerAccounts.set(owner, {
    username: owner, name: owner, passwordHash: "fixture-only", status: "active",
    createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
  });
  const directory = path.join(process.cwd(), "logs", "sessions", code);
  return {
    directory, owner,
    write(name: string, content: string | Buffer) {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    async auth() { return { Authorization: `Bearer ${await sign({ username: owner, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` }; },
    cleanup() {
      sessions.delete(code);
      lecturerAccounts.delete(owner);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function readZip(response: Response, name: string | RegExp) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/zip");
  const disposition = response.headers.get("Content-Disposition")!;
  if (typeof name === "string") expect(disposition).toBe(`attachment; filename=${name}`);
  else expect(disposition).toMatch(name);
  expect(response.headers.get("Access-Control-Expose-Headers")).toBe("Content-Disposition");
  return new AdmZip(Buffer.from(await response.arrayBuffer()));
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: session ZIP aliases retain evidence, manifest and secret exclusions with owner isolation`, async () => {
    const code = `DOWNLOAD_SESSION_${index}`;
    const data = fixture(code);
    const other = fixture(`${code}_OTHER`);
    const events = '{"event":"edit"}\n{"event":"save"}\n';
    const binary = Buffer.from([0, 1, 255, 10]);
    data.write("SEDOWNLOAD/events.jsonl", events);
    data.write("SEDOWNLOAD.json", '[{"prompt":"fixture"}]');
    data.write("SEDOWNLOAD/record.bin", binary);
    for (const name of sensitiveNames) data.write(`SEDOWNLOAD/${name}`, "fixture-secret");
    try {
      expect((await app.request(`${prefix}/sessions/${code}/logs`)).status).toBe(401);
      expect((await app.request(`${prefix}/sessions/${code}/logs`, { headers: await other.auth() })).status).toBe(403);
      expect(fs.existsSync(path.join(data.directory, "session_manifest.json"))).toBe(false);
      for (const suffix of ["logs", "logs/zip", "download-logs"]) {
        const zip = await readZip(await app.request(`${prefix}/sessions/${code}/${suffix}`, { headers: await data.auth() }), `session-${code}-logs.zip`);
        expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual(["SEDOWNLOAD.json", "SEDOWNLOAD/events.jsonl", "SEDOWNLOAD/record.bin", "session_manifest.json"].sort());
        expect(zip.readAsText("SEDOWNLOAD/events.jsonl")).toBe(events);
        expect(zip.readFile("SEDOWNLOAD/record.bin")).toEqual(binary);
        const manifest = JSON.parse(zip.readAsText("session_manifest.json"));
        expect(manifest).toMatchObject({ sessionCode: code, createdAt: 123456, endedAt: 234567, durationMinutes: 60, students: [{ studentId: "SEDOWNLOAD", loginTimestamp: 123, tokensConsumed: 137, latestClassification: "mixed" }] });
        expect(manifest.exportedAt).toBeGreaterThan(0);
      }
      const missing = await app.request(`${prefix}/sessions/${code}_MISSING/logs`, { headers: admin });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: `No logs found for session ${code}_MISSING.` });
    } finally { data.cleanup(); other.cleanup(); }
  });

  test(`${prefix}: student download preserves JSON bytes and switches to ZIP when event directory exists`, async () => {
    const code = `DOWNLOAD_STUDENT_${index}`;
    const data = fixture(code);
    const prompt = '\uFEFF[\n  {"prompt":"Tiếng Việt", "tokensConsumedTotal":137}\n]\n';
    data.write("SEDOWNLOAD.json", prompt);
    try {
      const url = `${prefix}/sessions/${code}/accounts/SEDOWNLOAD/download`;
      const response = await app.request(url, { headers: await data.auth() });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename=${code}_SEDOWNLOAD_prompts.json`);
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe("Content-Disposition");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(prompt));
      data.write("SEDOWNLOAD/events.jsonl", '{"event":"edit"}\n');
      const zip = await readZip(await app.request(url, { headers: admin }), `${code}_SEDOWNLOAD_logs.zip`);
      expect(zip.readFile("SEDOWNLOAD.json")).toEqual(Buffer.from(prompt));
      expect(zip.readAsText("SEDOWNLOAD/events.jsonl")).toBe('{"event":"edit"}\n');
      expect((await app.request(`${prefix}/sessions/${code}/accounts/MISSING/download`, { headers: admin })).status).toBe(404);
    } finally { data.cleanup(); }
  });

  test(`${prefix}: guest JSON and all archive aliases preserve admin-only access`, async () => {
    const code = `DOWNLOAD_ARCHIVES_${index}`;
    const data = fixture(code);
    const guestId = `GUEST_DOWNLOAD_${index}`;
    const guestFile = path.join(process.cwd(), "logs", "guests", `${guestId}.json`);
    const secret = path.join(process.cwd(), "logs", "guests", `${guestId}.key`);
    const prompt = '[{"prompt":"guest evidence"}]\n';
    fs.mkdirSync(path.dirname(guestFile), { recursive: true });
    fs.writeFileSync(guestFile, prompt);
    fs.writeFileSync(secret, "fixture-secret");
    try {
      const url = `${prefix}/guests/${guestId}/download`;
      expect((await app.request(url, { headers: await data.auth() })).status).toBe(403);
      const guest = await app.request(url, { headers: admin });
      expect(guest.status).toBe(200);
      expect(guest.headers.get("Content-Type")).toBe("application/json");
      expect(guest.headers.get("Content-Disposition")).toBe(`attachment; filename=guest_${guestId}_prompts.json`);
      expect(await guest.text()).toBe(prompt);
      expect((await app.request(`${prefix}/guests/${guestId}_MISSING/download`, { headers: admin })).status).toBe(404);
      for (const suffix of ["/logs/download-guest-logs", "/guests/logs/zip", "/guests/logs"]) {
        expect((await app.request(`${prefix}${suffix}`, { headers: await data.auth() })).status).toBe(403);
        const zip = await readZip(await app.request(`${prefix}${suffix}`, { headers: admin }), /^attachment; filename=guest-logs-\d+\.zip$/);
        expect(zip.readAsText(`${guestId}.json`)).toBe(prompt);
        expect(zip.getEntry(`${guestId}.key`)).toBeNull();
      }
      for (const suffix of ["/logs/download-all", "/logs/zip", "/logs/download"]) {
        expect((await app.request(`${prefix}${suffix}`, { headers: await data.auth() })).status).toBe(403);
        const zip = await readZip(await app.request(`${prefix}${suffix}`, { headers: admin }), /^attachment; filename=all-logs-\d+\.zip$/);
        expect(zip.readAsText(`guests/${guestId}.json`)).toBe(prompt);
        expect(zip.getEntry("quatmo.db")).toBeNull();
        expect(zip.getEntry(`guests/${guestId}.key`)).toBeNull();
      }
    } finally {
      data.cleanup();
      for (const file of [guestFile, secret]) fs.rmSync(file, { force: true });
    }
  });
}
