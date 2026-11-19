import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, sessionStates } = await import("../src/services/sessionStore");
const { s3Storage } = await import("../src/services/s3Storage");
const { redisStore } = await import("../src/services/classifier/redisStore");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const headers = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const time = 1700000000000;

function fixture(code: string) {
  const directory = path.join(process.cwd(), "logs", "sessions", code);
  sessions.set(code, {
    sessionCode: code, createdBy: "admin", createdAt: time, startTime: time / 1000,
    durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000,
    allowedStudentIds: new Set(["SELOCAL", "SEMEMORY"]),
  });
  return {
    write(name: string, text: string) {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    },
    cleanup() { sessions.delete(code); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: account catalog merges prompts, upload metrics, sliced events and roster-only students`, async () => {
    const code = `VIS_ACCOUNTS_${index}`;
    const data = fixture(code);
    data.write("SELOCAL.json", JSON.stringify([{ prompt: "first" }, { prompt: "second", error: "fixture" }]));
    data.write("SELOCAL/upload_info.json", JSON.stringify({ metrics: { inWindowEvents: 7 } }));
    data.write("SELOCAL/events.jsonl", '{}\n{}\n');
    data.write("SEEVENTS/exam_records/record/events.jsonl", [time - 1000, time + 1000, time + 3600001].map((timestamp) => JSON.stringify({ timestamp })).join("\n") + "\ncorrupt\n");
    data.write("metadata.json", "{}");
    data.write("session_manifest.json", "{}");
    try {
      expect((await app.request(`${prefix}/visualize/sessions/${code}/accounts`)).status).toBe(401);
      const response = await app.request(`${prefix}/visualize/sessions/${code}/accounts`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sessionCode).toBe(code);
      expect(body.accounts).toHaveLength(3);
      expect(body.accounts.find((row: any) => row.studentId === "SELOCAL")).toMatchObject({ hasPromptLog: true, hasEventLog: true, promptTurnsCount: 2, eventCount: 7, hasErrors: true });
      expect(body.accounts.find((row: any) => row.studentId === "SEEVENTS")).toMatchObject({ hasPromptLog: false, hasEventLog: true, eventCount: 1 });
      expect(body.accounts.at(-1)).toEqual({ studentId: "SEMEMORY", hasPromptLog: false, hasEventLog: false, promptTurnsCount: 0, eventCount: 0, lastActivity: time, hasErrors: false });
    } finally { data.cleanup(); }
  });

  test(`${prefix}: account event counts ignore an upload metric with a different expiry`, async () => {
    const code = `VIS_SCHEDULE_${index}`;
    const data = fixture(code);
    data.write("SEWINDOW/upload_info.json", JSON.stringify({
      metrics: { inWindowEvents: 99 },
      validityWindow: { expireTimestamp: time + 2 * 60 * 60 * 1000 },
    }));
    data.write(
      "SEWINDOW/exam_records/R1/events.jsonl",
      [time + 1000, time + 60 * 60 * 1000 + 1]
        .map((timestamp) => JSON.stringify({ timestamp }))
        .join("\n"),
    );
    try {
      const response = await app.request(`${prefix}/visualize/sessions/${code}/accounts`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.accounts.find((row: any) => row.studentId === "SEWINDOW")).toMatchObject({ eventCount: 1 });
    } finally { data.cleanup(); }
  });

  test(`${prefix}: account catalog merges remote metrics and record fallback without duplicate students`, async () => {
    const code = `VIS_ACCOUNTS_REMOTE_${index}`;
    const data = fixture(code);
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const listing = spyOn(s3Storage, "listStudentsInSessionFromS3").mockResolvedValue([
      { studentId: "SELOCAL", hasPromptLog: true, hasEventLog: true, lastActivity: time + 1000 },
      { studentId: "SERECORD", hasPromptLog: false, hasEventLog: true },
      { studentId: "SENEW", hasPromptLog: true, hasEventLog: false },
    ]);
    const file = spyOn(s3Storage, "getStudentFile").mockImplementation(async (_code, student) => student === "SELOCAL" ? JSON.stringify({ metrics: { inWindowEvents: 9 } }) : null);
    const records = spyOn(s3Storage, "listStudentExamRecords").mockResolvedValue(["REC1"]);
    const artifact = spyOn(s3Storage, "getExamRecordArtifact").mockImplementation(async (_code, _student, _record, name) => name === "events.jsonl" ? '{}\ncorrupt\n{}\n\n' : null);
    try {
      const response = await app.request(`${prefix}/visualize/sessions/${code}/accounts`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.accounts).toHaveLength(4);
      expect(body.accounts.filter((row: any) => row.studentId === "SELOCAL")).toHaveLength(1);
      expect(body.accounts.find((row: any) => row.studentId === "SELOCAL")).toMatchObject({ hasPromptLog: true, hasEventLog: true, eventCount: 9, lastActivity: time + 1000 });
      expect(body.accounts.find((row: any) => row.studentId === "SERECORD")).toMatchObject({ hasEventLog: true, eventCount: 3 });
      expect(body.accounts.find((row: any) => row.studentId === "SENEW")).toMatchObject({ hasPromptLog: true, promptTurnsCount: 1, eventCount: 0 });
      expect(records.mock.calls).toEqual([[code, "SERECORD"]]);
      expect(artifact.mock.calls).toContainEqual([code, "SERECORD", "REC1", "events.jsonl"]);
    } finally {
      available.mockRestore(); listing.mockRestore(); file.mockRestore(); records.mockRestore(); artifact.mockRestore(); data.cleanup();
    }
  });

  test(`${prefix}: prompt logs reconcile usage and enrich missing classification without overwriting existing values`, async () => {
    const code = `VIS_PROMPTS_${index}`;
    const data = fixture(code);
    const timestamp = "2023-11-14T22:13:20.000Z";
    const turn = { timestamp, createdAt: timestamp, completedAt: timestamp, responseDurationMs: 0 };
    data.write("SELOCAL.json", JSON.stringify([
      { ...turn, prompt: "existing", tokensConsumedTotal: 10, classification: { features: { retained: 1 }, iScoreTurn: 0.2, eScoreTurn: 0.3 } },
      { ...turn, prompt: "missing", tokensConsumedTotal: 6 },
    ]));
    sessionStates.set(`${code}:SELOCAL`, { sessionCode: code, studentId: "SELOCAL", loginTimestamp: time / 1000, hasLoggedIn: true, reassigned: false, tokensConsumed: 99 });
    const cached = spyOn(redisStore, "getTurns").mockResolvedValue([
      { prompt: "existing", featureVector: { replacement: 1 }, I_score: 0.8, E_score: 0.9 },
      { prompt: "missing", featureVector: { added: 1 }, I_score: 0.6, E_score: 0.7 },
    ] as any);
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const remote = spyOn(s3Storage, "getStudentPromptLog").mockResolvedValue([{ prompt: "remote fixture" }]);
    const db = new Database(path.join(process.cwd(), "logs/quatmo.db"), { readonly: true });
    try {
      const url = `${prefix}/visualize/sessions/${code}/accounts/SELOCAL/prompt-log`;
      const response = await app.request(url, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ sessionCode: code, studentId: "SELOCAL" });
      expect(body.turns[0].classification).toEqual({ features: { retained: 1 }, iScoreTurn: 0.2, eScoreTurn: 0.3 });
      expect(body.turns[1].classification).toEqual({ features: { added: 1 }, iScoreTurn: 0.6, eScoreTurn: 0.7 });
      expect(remote).not.toHaveBeenCalled();
      expect(db.query("SELECT tokens_consumed FROM session_states WHERE session_code = ? AND student_id = ?").get(code, "SELOCAL")).toEqual({ tokens_consumed: 16 });
      const fallback = await app.request(`${prefix}/visualize/sessions/${code}/accounts/SEABSENT/prompt-log`, { headers });
      expect(await fallback.json()).toEqual({ sessionCode: code, studentId: "SEABSENT", turns: [{ prompt: "remote fixture" }] });
      remote.mockResolvedValue(null);
      expect(await (await app.request(`${prefix}/visualize/sessions/${code}/accounts/SEABSENT/prompt-log`, { headers })).json()).toEqual({ sessionCode: code, studentId: "SEABSENT", turns: [] });
    } finally { db.close(); cached.mockRestore(); available.mockRestore(); remote.mockRestore(); data.cleanup(); }
  });
}
