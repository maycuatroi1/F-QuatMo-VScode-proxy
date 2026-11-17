import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, sessionStates, lecturerAccounts } = await import("../src/services/sessionStore");
const { s3Storage } = await import("../src/services/s3Storage");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const time = 1700000000000;
const event = (offset: number, type = "edit") => ({ timestamp: time + offset, type });
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

function fixture(code: string, owner = "admin") {
  const directory = path.join(process.cwd(), "logs", "sessions", code);
  sessions.set(code, { sessionCode: code, createdBy: owner, createdAt: time, startTime: time / 1000,
    endedAt: (time + 60000) / 1000, durationMinutes: 1, aiOption: "agent", aiValidityMinutes: 1,
    defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEEVENT"]),
  });
  sessionStates.set(`${code}:SEEVENT`, { sessionCode: code, studentId: "SEEVENT", loginTimestamp: time / 1000, hasLoggedIn: true, reassigned: false, tokensConsumed: 137 });
  return {
    directory,
    write(name: string, content: string | Buffer) {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    cleanup() { sessions.delete(code); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function snapshot(content: string) {
  const zip = new AdmZip();
  zip.addFile("src/main.py", Buffer.from(content));
  return zip.toBuffer();
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  const url = (code: string, query = "", student = "SEEVENT") => `${prefix}/visualize/sessions/${code}/accounts/${student}/event-log${query}`;
  const read = async (code: string, query = "", student = "SEEVENT") => {
    const response = await app.request(url(code, query, student), { headers: admin });
    expect(response.status).toBe(200);
    return response.json();
  };

  test(`${prefix}: event log preserves validity boundaries, grace, raw modes and source bytes`, async () => {
    const code = `EVENT_WINDOW_${index}`;
    const data = fixture(code);
    const records = [event(120001), event(2000), event(-1), event(120000), event(60000)];
    const raw = lines(records) + "\ninvalid JSON\n";
    data.write("SEEVENT/exam_records/R1/events.jsonl", raw);
    data.write("SEEVENT/exam_records/R1/ai_interactions.jsonl", lines([event(1000, "query"), event(120001, "response")]));
    data.write("SEEVENT/exam_records/R1/snapshot_start.zip", snapshot("print('fixture')\n"));
    data.write("SEEVENT/exam_records/R1/metadata.json", JSON.stringify({ examSessionId: "metadata-id", retained: true }));
    data.write("SEEVENT/upload_info.json", JSON.stringify({ uploadTimestamp: (time + 180000) / 1000, validityWindow: { signinTimestamp: time / 1000, expireTimestamp: (time + 60000) / 1000 } }));
    try {
      const body = await read(code);
      expect(body.coreRecords).toEqual([event(2000), event(60000), event(120000)]);
      expect(body.aiRecords).toEqual([event(1000, "query")]);
      expect(body.activeRecordDir).toBe("R1");
      expect(body.availableRecords).toEqual(["R1"]);
      expect(body.validityWindow).toMatchObject({ signinTimestamp: time, expireTimestamp: time + 60000, graceSeconds: 60, durationMinutes: 1 });
      expect(body.rangeApplied).toEqual({ from: time, to: time + 120000, mode: "session_validity" });
      expect(body.stats).toMatchObject({ totalRawEvents: 5, inWindowEvents: 3, preSessionEvents: 1, postSessionEvents: 1 });
      expect(body.metadata).toMatchObject({ examSessionId: "metadata-id", retained: true, examStartAt: time, examEndAt: time + 60000 });
      expect(body.initialFiles).toEqual({ "src/main.py": "print('fixture')\n" });
      expect(body.isClamped).toBe(true);
      for (const query of ["?unclamped=true", "?mode=full_raw"]) {
        const full = await read(code, query);
        expect(full.coreRecords).toEqual(records);
        expect(full.isClamped).toBe(false);
        expect(full.rangeApplied.mode).toBe("full_raw");
      }
      expect(fs.readFileSync(path.join(data.directory, "SEEVENT/exam_records/R1/events.jsonl"), "utf8")).toBe(raw);
      expect(sessionStates.get(`${code}:SEEVENT`)!.tokensConsumed).toBe(137);
    } finally { data.cleanup(); }
  });

  test(`${prefix}: local event records merge deterministically and explicit selection stays isolated`, async () => {
    const code = `EVENT_MERGE_${index}`;
    const data = fixture(code);
    data.write("SEEVENT/exam_records/R1/events.jsonl", lines([event(3000, "save"), event(1000)]));
    data.write("SEEVENT/exam_records/R2/events.jsonl", lines([event(1000), event(2000)]));
    data.write("SEEVENT/exam_records/R1/ai_interactions.jsonl", lines([event(1000, "query")]));
    data.write("SEEVENT/exam_records/R2/ai_interactions.jsonl", lines([event(1000, "query"), event(2000, "response")]));
    data.write("SEEVENT/exam_records/R1/snapshot_start.zip", snapshot("first snapshot"));
    data.write("SEEVENT/exam_records/R2/snapshot_start.zip", snapshot("second snapshot"));
    try {
      const merged = await read(code);
      expect(merged.activeRecordDir).toBe("all_merged");
      expect(merged.availableRecords).toEqual(["all_merged", "R1", "R2"]);
      expect(merged.coreRecords).toEqual([event(1000), event(2000), event(3000, "save")]);
      expect(merged.aiRecords).toEqual([event(1000, "query"), event(2000, "response")]);
      expect(merged.initialFiles).toEqual({ "src/main.py": "first snapshot" });
      const selected = await read(code, "?recordId=R2");
      expect(selected.activeRecordDir).toBe("R2");
      expect(selected.coreRecords).toEqual([event(1000), event(2000)]);
      expect(selected.initialFiles).toEqual({ "src/main.py": "second snapshot" });
      expect((await read(code, "?recordId=all_merged")).coreRecords).toEqual(merged.coreRecords);
    } finally { data.cleanup(); }
  });

  test(`${prefix}: S3 event sources preserve record selection, merged snapshots and empty fallback`, async () => {
    const code = `EVENT_REMOTE_${index}`;
    const data = fixture(code);
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const records = spyOn(s3Storage, "listStudentExamRecords").mockResolvedValue(["R1", "R2"]);
    const artifacts = spyOn(s3Storage, "getExamRecordArtifact").mockImplementation(async (_code, _student, record, name) => {
      if (name === "events.jsonl") return lines(record === "R1" ? [event(3000), event(1000)] : [event(1000), event(2000)]);
      if (name === "ai_interactions.jsonl") return lines([event(1000, "query")]);
      if (name === "snapshot_start.zip") return snapshot(record);
      if (name === "metadata.json") return JSON.stringify({ examSessionId: record });
      return null;
    });
    const upload = spyOn(s3Storage, "getStudentFile").mockResolvedValue(JSON.stringify({ validityWindow: { signinTimestamp: time, expireTimestamp: time + 60000 } }));
    try {
      const merged = await read(code);
      expect(merged.coreRecords).toEqual([event(1000), event(2000), event(3000)]);
      expect(merged.activeRecordDir).toBe("all_merged");
      expect(merged.initialFiles).toEqual({ "src/main.py": "R1" });
      const selected = await read(code, "?recordId=R2");
      expect(selected.activeRecordDir).toBe("R2");
      expect(selected.coreRecords).toEqual([event(1000), event(2000)]);
      expect(artifacts.mock.calls).toContainEqual([code, "SEEVENT", "R2", "snapshot_start.zip"]);
      records.mockResolvedValue([]);
      expect(await read(code)).toEqual({ sessionCode: code, studentId: "SEEVENT", metadata: null, coreRecords: [], aiRecords: [], availableRecords: [], initialFiles: {} });
    } finally { available.mockRestore(); records.mockRestore(); artifacts.mockRestore(); upload.mockRestore(); data.cleanup(); }
  });

  test(`${prefix}: event access preserves owner guards and case-insensitive local directory lookup`, async () => {
    const code = `EVENT_OWNER_${index}`;
    const owner = `event-owner-${index}`;
    const other = `${owner}-other`;
    const data = fixture(code, owner);
    for (const username of [owner, other]) lecturerAccounts.set(username, { username, name: username, passwordHash: "fixture-only", status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin" });
    const auth = async (username: string) => ({ Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` });
    data.write("SEEVENT/exam_records/R1/events.jsonl", lines([event(1000)]));
    try {
      expect((await app.request(url(code))).status).toBe(401);
      expect((await app.request(url(code), { headers: await auth(other) })).status).toBe(403);
      const response = await app.request(url(code, "", "seevent"), { headers: await auth(owner) });
      expect(response.status).toBe(200);
      expect((await response.json()).coreRecords).toEqual([event(1000)]);
      expect((await read(code, "", "MISSING")).coreRecords).toEqual([]);
    } finally { data.cleanup(); for (const username of [owner, other]) lecturerAccounts.delete(username); }
  });

  test(`${prefix}: existing pre-sign-in fail-safe keeps same-day evidence without rewriting it`, async () => {
    const code = `EVENT_ANONYMOUS_${index}`;
    const data = fixture(code);
    const records = [event(-10000), event(-5000)];
    data.write("SEEVENT/exam_records/R1/events.jsonl", lines(records));
    try {
      const body = await read(code);
      expect(body.coreRecords).toEqual(records);
      expect(body.stats).toMatchObject({ totalRawEvents: 2, inWindowEvents: 2, preSessionEvents: 2 });
      expect(fs.readFileSync(path.join(data.directory, "SEEVENT/exam_records/R1/events.jsonl"), "utf8")).toBe(lines(records));
    } finally { data.cleanup(); }
  });
}
