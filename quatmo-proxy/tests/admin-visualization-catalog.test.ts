import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, lecturerAccounts } = await import("../src/services/sessionStore");
const { s3Storage } = await import("../src/services/s3Storage");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const time = 1700000000000;

async function lecturer(username: string) {
  lecturerAccounts.set(username, {
    username, name: username, passwordHash: "fixture-only", status: "active",
    createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin",
  });
  return { Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` };
}

function session(code: string, owner: string, createdAt = time) {
  sessions.set(code, {
    sessionCode: code, createdBy: owner, createdAt, startTime: time / 1000,
    endedAt: (time + 60000) / 1000, durationMinutes: 60, aiOption: "agent",
    aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEONE", "SETWO", "SETHREE"]),
  });
}

function write(area: string, name: string, content: string, modified = time) {
  const file = path.join(process.cwd(), "logs", area, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, modified / 1000, modified / 1000);
  return file;
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: visualization catalog preserves local counts, memory sessions and ownership`, async () => {
    const base = `VIS_CATALOG_${index}`;
    const owner = `catalog-owner-${index}`;
    const auth = await lecturer(owner);
    const codes = [`${base}_DISK`, `${base}_MEMORY`, `${base}_ORPHAN`];
    session(codes[0], owner);
    session(codes[1], owner, time + 100000);
    write(`sessions/${codes[0]}`, "SEONE.json", "[]");
    write(`sessions/${codes[0]}/SEONE`, "events.jsonl", "{}\n");
    write(`sessions/${codes[0]}/SETWO`, "events.jsonl", "{}\n");
    for (const name of ["session_manifest.json", "metadata.json", ".hidden.json", "package.json"]) write(`sessions/${codes[0]}`, name, "{}");
    write(`sessions/${codes[2]}`, "SEORPHAN.json", "[]");
    const dir = path.join(process.cwd(), "logs", "sessions", codes[0]);
    for (const name of ["SEONE", "SETWO"]) fs.utimesSync(path.join(dir, name), time / 1000, time / 1000);
    try {
      expect((await app.request(`${prefix}/visualize/sessions`)).status).toBe(401);
      const response = await app.request(`${prefix}/visualize/sessions`, { headers: auth });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sessions.map((row: any) => row.sessionCode)).toEqual([codes[1], codes[0]]);
      expect(data.sessions[0]).toMatchObject({ studentCount: 3, promptLogCount: 0, eventLogCount: 0, lastActivity: time + 100000 });
      expect(data.sessions[1]).toMatchObject({ sessionCode: codes[0], sessionName: codes[0], promptLogCount: 1, eventLogCount: 2, studentCount: 2, startTime: time, createdAt: time, endedAt: time + 60000, durationMinutes: 60, lastActivity: time });
      const all = await (await app.request(`${prefix}/visualize/sessions`, { headers: admin })).json();
      expect(all.sessions.filter((row: any) => row.sessionCode.startsWith(base))).toHaveLength(3);
      expect(all.sessions.find((row: any) => row.sessionCode === codes[2])).toMatchObject({ studentCount: 1, promptLogCount: 1, durationMinutes: 90 });
    } finally {
      lecturerAccounts.delete(owner);
      for (const code of codes) {
        sessions.delete(code);
        fs.rmSync(path.join(process.cwd(), "logs", "sessions", code), { recursive: true, force: true });
      }
    }
  });

  test(`${prefix}: S3-only catalog sessions are merged without duplicating local sessions`, async () => {
    const code = `VIS_REMOTE_${index}`;
    const local = `${code}_LOCAL`;
    session(local, "admin");
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const listing = spyOn(s3Storage, "listSessionsFromS3").mockResolvedValue([local, code, code]);
    const students = spyOn(s3Storage, "listStudentsInSessionFromS3").mockResolvedValue([
      { studentId: "SEONE", hasPromptLog: true, hasEventLog: false, lastActivity: time },
      { studentId: "SETWO", hasPromptLog: true, hasEventLog: true, lastActivity: time + 1 },
    ]);
    try {
      const response = await app.request(`${prefix}/visualize/sessions`, { headers: admin });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sessions.filter((row: any) => row.sessionCode === local)).toHaveLength(1);
      expect(data.sessions.filter((row: any) => row.sessionCode === code)).toHaveLength(1);
      expect(data.sessions.find((row: any) => row.sessionCode === code)).toMatchObject({ promptLogCount: 2, eventLogCount: 1, studentCount: 2, durationMinutes: 90 });
      expect(students.mock.calls).toEqual([[code]]);
    } finally { available.mockRestore(); listing.mockRestore(); students.mockRestore(); sessions.delete(local); }
  });

  test(`${prefix}: guest catalog and detail use the same newest file and preserve evidence`, async () => {
    const id = `VIS_GUEST_${index}`;
    const owner = `guest-catalog-owner-${index}`;
    const auth = await lecturer(owner);
    const oldTurns = [{ prompt: "old local guest" }];
    const newerTurns = [{ prompt: "newer machine" }, { error: "fixture failure" }];
    const files = [
      write("guests", `${id}.json`, JSON.stringify(oldTurns)),
      write("machines", `${id}.json`, JSON.stringify(newerTurns), time + 1000),
      write("guests", `${id}_LOG.log`, '{"prompt":"valid"}\ncorrupt\n\n'),
    ];
    try {
      expect((await app.request(`${prefix}/visualize/guests`, { headers: auth })).status).toBe(403);
      expect((await app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: auth })).status).toBe(403);
      const data = await (await app.request(`${prefix}/visualize/guests`, { headers: admin })).json();
      expect(data.guests.filter((row: any) => row.guestId === id)).toHaveLength(1);
      expect(data.guests.find((row: any) => row.guestId === id)).toEqual({ studentId: id, guestId: id, hasPromptLog: true, hasEventLog: false, promptTurnsCount: 2, eventCount: 0, lastActivity: time + 1000, hasErrors: true });
      expect(data.guests.find((row: any) => row.guestId === `${id}_LOG`).promptTurnsCount).toBe(2);
      expect(await (await app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: admin })).json()).toEqual({ guestId: id, turns: newerTurns });
      expect(fs.readFileSync(files[0], "utf8")).toBe(JSON.stringify(oldTurns));
      expect(fs.readFileSync(files[1], "utf8")).toBe(JSON.stringify(newerTurns));
      expect(await (await app.request(`${prefix}/visualize/guests/${id}_LOG/prompt-log`, { headers: admin })).json()).toEqual({ guestId: `${id}_LOG`, turns: [{ prompt: "valid" }] });
    } finally { lecturerAccounts.delete(owner); for (const file of files) fs.rmSync(file, { force: true }); }
  });

  test(`${prefix}: guest source ties prefer guests then JSON, and newer logs override JSON`, async () => {
    const id = `VIS_GUEST_TIE_${index}`;
    const json = [{ prompt: "guest JSON" }];
    const newer = [{ prompt: "machine log newer" }, { prompt: "second" }];
    const files = [
      write("guests", `${id}.json`, JSON.stringify(json)),
      write("guests", `${id}.log`, '{"prompt":"guest log"}\n'),
      write("machines", `${id}.json`, '[{"prompt":"machine JSON"}]'),
      write("machines", `${id}.log`, newer.map((turn) => JSON.stringify(turn)).join("\n")),
    ];
    const detail = () => app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: admin });
    try {
      expect(await (await detail()).json()).toEqual({ guestId: id, turns: json });
      fs.utimesSync(files[3], (time + 2000) / 1000, (time + 2000) / 1000);
      const data = await (await app.request(`${prefix}/visualize/guests`, { headers: admin })).json();
      expect(data.guests.find((row: any) => row.guestId === id)).toMatchObject({ promptTurnsCount: 2, lastActivity: time + 2000 });
      expect(await (await detail()).json()).toEqual({ guestId: id, turns: newer });
    } finally { for (const file of files) fs.rmSync(file, { force: true }); }
  });

  test(`${prefix}: guest prompt fallback preserves S3, malformed JSON and empty responses`, async () => {
    const id = `VIS_GUEST_FALLBACK_${index}`;
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const guests = spyOn(s3Storage, "listGuestsFromS3").mockResolvedValue([id, id]);
    const turns = [{ prompt: "S3 fixture", tokensConsumedTotal: 31 }];
    const prompt = spyOn(s3Storage, "getGuestPromptLog").mockResolvedValue(turns);
    let badFile = "";
    try {
      const data = await (await app.request(`${prefix}/visualize/guests`, { headers: admin })).json();
      expect(data.guests.filter((row: any) => row.guestId === id)).toHaveLength(1);
      expect(await (await app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: admin })).json()).toEqual({ guestId: id, turns });
      prompt.mockResolvedValue(null);
      expect(await (await app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: admin })).json()).toEqual({ guestId: id, turns: [] });
      badFile = write("guests", `${id}.json`, "{broken");
      const broken = await app.request(`${prefix}/visualize/guests/${id}/prompt-log`, { headers: admin });
      expect(broken.status).toBe(500);
      expect(await broken.json()).toEqual({ error: "Failed to parse log" });
    } finally {
      available.mockRestore(); guests.mockRestore(); prompt.mockRestore();
      if (badFile) fs.rmSync(badFile, { force: true });
    }
  });
}
