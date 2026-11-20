import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { createRequire } from "node:module";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, lecturerAccounts } = await import("../src/services/sessionStore");
const { s3Storage, S3StorageService } = await import("../src/services/s3Storage");
const { summaryStorageService: storage, getSummaryEngineDiagnostic } = await import("../src/services/summaryStorage");
const { createSummaryArchive, validateSummaryZip } = await import("../src/services/summaryArchive");
const { SUMMARY_MAX_ARCHIVE_BYTES } = await import("../src/config/summaryLimits");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };

function archive() {
  const zip = new AdmZip();
  for (const id of ["SE1", "SE2"]) zip.addFile(`${id}/exam_records/REC/events.jsonl`, Buffer.from('{"event":"save"}\n'));
  return zip.toBuffer();
}

async function teacher(username: string) {
  lecturerAccounts.set(username, { username, name: username, passwordHash: "fixture-only", status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin" });
  return { Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` };
}

function session(code: string, owner: string) {
  sessions.set(code, { sessionCode: code, createdBy: owner, startTime: 1, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(["SE1", "SE2"]), createdAt: 1 });
}

// A real child process reproduces the existing CLI: progress then JSON, files for batch results.
async function withEngine(run: () => Promise<void>, legacyRoot = false) {
  const directory = await fs.promises.mkdtemp(path.resolve("summary-engine-fixture-"));
  const script = path.join(directory, "engine.cjs");
  const require = createRequire(import.meta.url);
  await fs.promises.writeFile(script, `
    const fs = require('node:fs'), path = require('node:path');
    const Zip = require(${JSON.stringify(require.resolve("adm-zip"))});
    const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
    const input = value('--zip'), id = args.includes('--student') ? value('--student') : null;
    const entries = new Zip(input).getEntries().map(e => e.entryName);
    if (id === 'FAIL') { console.log(JSON.stringify({ok:false,error:'fixture failure'})); process.exit(0); }
    if (id === 'EXIT1') { console.error('synthetic private credential'); console.log(JSON.stringify({ok:false,error:'Summary archive exceeds decompression limits.',phase:'archive_validation',error_type:'ValueError'})); process.exit(1); }
    if (id === 'LEGACY') { console.log(JSON.stringify({ok:true,student_id:id,markdown:'unverified legacy result'})); process.exit(0); }
    const report = student => ({analysisRuleVersion:'scheduled-signin-v1', student_id:student, markdown:'# Summary ' + student + ' — thử nghiệm', check_report:{ok:true}, metrics:{requests_count:2}});
    let result;
    if (id) result = {...report(id), ok:true};
    else {
      const root = path.join(value('--output-dir'), path.basename(input, '.zip'));
      fs.mkdirSync(path.join(root, 'students'), {recursive:true});
      for (const student of ['SE1','SE2']) {
        fs.writeFileSync(path.join(root, ${legacyRoot ? "''" : "'students'"}, student + '_summary.md'), report(student).markdown);
        fs.mkdirSync(path.join(root, 'stages', student), {recursive:true});
        fs.writeFileSync(path.join(root, 'stages', student, 'check_report.json'), JSON.stringify({ok:true}));
      }
      result = {ok:true, analysisRuleVersion:'scheduled-signin-v1', students:['SE1','SE2'], manifest_content:'# Session summary'};
    }
    console.log('pipeline progress');
    console.log(JSON.stringify({...result,inputEntries:entries,engineEnvNames:Object.keys(process.env)}));
  `);
  const keys = ["SUMMARY_ENGINE_BIN", "SUMMARY_CLI_PATH", "SUMMARY_PYTHON_BIN"];
  const previous = keys.map(key => process.env[key]);
  process.env.SUMMARY_ENGINE_BIN = path.join(directory, "missing-engine");
  process.env.SUMMARY_CLI_PATH = script;
  process.env.SUMMARY_PYTHON_BIN = process.execPath;
  try { await run(); } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test("summary exit-one diagnostics preserve only fixed categories and clean up the job", async () => {
  const expected = { phase: "archive_validation", errorType: "ValueError", reason: "archive_decompression_limit" };
  expect(getSummaryEngineDiagnostic(JSON.stringify({ ok: false, phase: "archive_validation", error_type: "ValueError", error: "Summary archive exceeds decompression limits." }))).toEqual(expected);
  expect(getSummaryEngineDiagnostic(JSON.stringify({ ok: false, phase: "private path", error_type: "private key", error: "private report" }))).toEqual({ phase: "unknown", errorType: "unknown", reason: "unclassified" });
  expect(getSummaryEngineDiagnostic("private traceback")).toBeUndefined();
  expect(getSummaryEngineDiagnostic("null")).toBeUndefined();
  await withEngine(async () => {
    const input = path.resolve("diagnostic-fixture.zip");
    fs.writeFileSync(input, archive());
    try {
      await storage.generateStudentSummary("DIAGNOSTIC_FIXTURE", "EXIT1", input);
      throw new Error("Expected engine to fail");
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.engineDiagnostic).toEqual(expected);
      expect(error.stdout).toBeUndefined();
      expect(error.stderr).toBeUndefined();
      expect(error.message).not.toContain("private");
      expect(fs.readdirSync(path.resolve("logs", "temp_summaries"))).toEqual([]);
    } finally { fs.unlinkSync(input); }
  });
});

test("summary rejects a legacy engine that cannot attest to the scheduled analysis window", async () => {
  await withEngine(async () => {
    const input = path.resolve("legacy-engine-fixture.zip");
    fs.writeFileSync(input, archive());
    try {
      await expect(storage.generateStudentSummary("LEGACY_ENGINE", "LEGACY", input)).rejects.toThrow("scheduled-signin-v1");
      expect(fs.existsSync(path.resolve("logs/sessions/LEGACY_ENGINE/LEGACY/summary.md"))).toBe(false);
    } finally { fs.unlinkSync(input); }
  });
});

test("summary local persistence, S3 fallback and purge only after successful sync", async () => {
  const code = "SUMMARY_STORAGE";
  const available = spyOn(s3Storage, "isAvailable").mockReturnValue(false);
  const upload = spyOn(s3Storage, "uploadStudentSummary").mockResolvedValue(false);
  const read = spyOn(s3Storage, "getStudentSummary").mockResolvedValue({ markdown: "remote", metadata: { version: 2 } });
  const remoteList = spyOn(s3Storage, "listStudentSummariesFromS3").mockResolvedValue(["SE1", "SE2"]);
  const manifestUpload = spyOn(s3Storage, "uploadSessionSummaryManifest").mockResolvedValue(true);
  const manifestRead = spyOn(s3Storage, "getSessionSummaryManifest").mockResolvedValue("remote manifest");
  const oldPurge = process.env.PURGE_LOCAL_SUMMARY_AFTER_S3;
  try {
    await storage.saveStudentSummary(code, "SE1", "local tiếng Việt", { version: 1 });
    expect(await storage.getStudentSummary(code, "SE1")).toMatchObject({ markdown: "local tiếng Việt", metadata: { version: 1 }, source: "local" });
    expect(upload).not.toHaveBeenCalled();
    available.mockReturnValue(true);
    await storage.saveSessionManifest(code, "local manifest");
    expect(await storage.getSessionManifest(code)).toEqual({ manifestMarkdown: "local manifest", source: "local" });
    expect(manifestUpload).toHaveBeenCalledWith(code, "local manifest");
    fs.unlinkSync(path.join(storage.getLocalSessionDir(code), "session_manifest_summary.md"));
    expect(await storage.getSessionManifest(code)).toEqual({ manifestMarkdown: "remote manifest", source: "s3" });
    process.env.PURGE_LOCAL_SUMMARY_AFTER_S3 = "true";
    await storage.saveStudentSummary(code, "SE1", "retained", {});
    expect(fs.existsSync(path.join(storage.getLocalStudentDir(code, "SE1"), "summary.md"))).toBe(true);
    upload.mockResolvedValue(true);
    await storage.saveStudentSummary(code, "SE1", "synced", {});
    expect(fs.existsSync(path.join(storage.getLocalStudentDir(code, "SE1"), "summary.md"))).toBe(false);
    expect(await storage.getStudentSummary(code, "SE1")).toMatchObject({ markdown: "remote", source: "s3" });
    expect(await storage.listSessionSummaries(code)).toEqual([{ studentId: "SE1", hasSummary: true, source: "s3" }, { studentId: "SE2", hasSummary: true, source: "s3" }]);
  } finally {
    available.mockRestore(); upload.mockRestore(); read.mockRestore(); remoteList.mockRestore();
    manifestUpload.mockRestore(); manifestRead.mockRestore();
    if (oldPurge === undefined) delete process.env.PURGE_LOCAL_SUMMARY_AFTER_S3; else process.env.PURGE_LOCAL_SUMMARY_AFTER_S3 = oldPurge;
    fs.rmSync(storage.getLocalSessionDir(code), { recursive: true, force: true });
  }
});

test("summary S3 commands retain exact keys, content types and paginated availability", async () => {
  const service = new S3StorageService();
  (service as any).client = {};
  (service as any).initialized = true;
  const send = spyOn(service as any, "sendCommand");
  try {
    send.mockResolvedValue({});
    expect(await service.uploadStudentSummary("code", "se1", "markdown", { ok: true })).toBe(true);
    expect(send.mock.calls.map(([cmd]: any) => cmd.input)).toEqual([
      { Bucket: service.getBucketName(), Key: "sessions/CODE/students/SE1/summary.md", Body: "markdown", ContentType: "text/markdown; charset=utf-8" },
      { Bucket: service.getBucketName(), Key: "sessions/CODE/students/SE1/summary.json", Body: '{\n  "ok": true\n}', ContentType: "application/json" },
    ]);
    send.mockReset();
    send.mockResolvedValueOnce({ Contents: [{ Key: "sessions/CODE/students/SE1/summary.md" }], NextContinuationToken: "page2" });
    send.mockResolvedValueOnce({ Contents: [{ Key: "sessions/CODE/students/SE2/summary.md" }, { Key: "sessions/CODE/students/SE2/summary.json" }] });
    expect(await service.listStudentSummariesFromS3("code")).toEqual(["SE1", "SE2"]);
    expect((send.mock.calls[1][0] as any).input.ContinuationToken).toBe("page2");
    send.mockReset();
    send.mockResolvedValueOnce({ Contents: [{ Key: "sessions/CODE/students/SE1/prompt_turns.json" }], NextContinuationToken: "page2" });
    send.mockResolvedValueOnce({ Contents: [{ Key: "sessions/CODE/students/SE2/exam_records/R/events.jsonl" }] });
    expect(await service.listSessionTelemetryFiles("code")).toEqual(["SE1/prompt_turns.json", "SE2/exam_records/R/events.jsonl"]);
    expect((send.mock.calls[1][0] as any).input.ContinuationToken).toBe("page2");
    send.mockReset();
    send.mockResolvedValueOnce({ Body: { transformToString: async () => "remote markdown" } });
    send.mockResolvedValueOnce({ Body: { transformToString: async () => '{"ok":true}' } });
    expect(await service.getStudentSummary("code", "se1")).toEqual({ markdown: "remote markdown", metadata: { ok: true } });
    send.mockReset(); send.mockRejectedValue({ name: "NoSuchKey" });
    expect(await service.getStudentSummary("code", "se1")).toBeNull();
  } finally { send.mockRestore(); }
});

test("summary archive fills missing S3 telemetry, excludes secrets and rejects corrupt/nested bomb ZIPs", async () => {
  const code = "SUMMARY_ARCHIVE";
  const root = storage.getLocalSessionDir(code);
  const job = fs.mkdtempSync(path.resolve("summary-archive-fixture-"));
  fs.mkdirSync(path.join(root, "SE1", "exam_records", "REC"), { recursive: true });
  fs.writeFileSync(path.join(root, "SE1", "exam_records", "REC", "events.jsonl"), "local evidence");
  fs.writeFileSync(path.join(root, ".env"), "private fixture");
  fs.writeFileSync(path.join(root, "SE1", "summary.md"), "old summary");
  fs.writeFileSync(path.join(root, "session_manifest.json"), JSON.stringify({sessionCode: code, createdAt: 1700000000000, durationMinutes: 60, students: []}));
  const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
  const listing = spyOn(s3Storage, "listSessionTelemetryFiles").mockResolvedValue(["SE1/exam_records/REC/events.jsonl", "SE1/prompt_turns.json", "SE2/exam_records/REC/events.jsonl", "SE2/summary.md"]);
  const read = spyOn(s3Storage, "getStudentFile").mockImplementation(async (_code, _id, name) => name === "prompt_turns.json" ? "[]" : "remote evidence");
  try {
    const zip = new AdmZip(await createSummaryArchive(code, job));
    expect(zip.readAsText("SE1/exam_records/REC/events.jsonl")).toBe("local evidence");
    expect(zip.readAsText("SE2/exam_records/REC/events.jsonl")).toBe("remote evidence");
    expect(zip.readAsText("SE1.json")).toBe("[]");
    expect(zip.getEntry(".env")).toBeNull(); expect(zip.getEntry("SE1/summary.md")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(() => validateSummaryZip(Buffer.from("invalid archive"))).toThrow();
    expect(() => validateSummaryZip(new AdmZip().toBuffer())).toThrow("empty");
    const nested = new AdmZip(); nested.addFile("large.txt", Buffer.alloc(2 * 1024 * 1024));
    const outer = new AdmZip(); outer.addFile("SE1/exam_records/REC/snapshot_start.zip", nested.toBuffer());
    // Nested payloads are inspected in the memory-limited Python worker, not the HTTP thread.
    expect(() => validateSummaryZip(outer.toBuffer())).not.toThrow();
    listing.mockRejectedValue(new Error("storage unavailable"));
    await expect(createSummaryArchive(code, job)).rejects.toThrow("storage unavailable");
  } finally {
    available.mockRestore(); listing.mockRestore(); read.mockRestore();
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(job, { recursive: true, force: true });
  }
});

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: summary reads require ownership and never generate automatically`, async () => {
    const code = `SUMMARY_AUTH_${index}`, owner = `summary-owner-${index}`, stranger = `${owner}-other`;
    const headers = await teacher(owner), other = await teacher(stranger);
    session(code, owner);
    const generate = spyOn(storage, "generateStudentSummary").mockRejectedValue(new Error("must not generate"));
    const url = `${prefix}/visualize/sessions/${code}/accounts/SE1/summary?auto=true`;
    try {
      expect((await app.request(url)).status).toBe(401);
      expect((await app.request(url, { headers: other })).status).toBe(403);
      expect((await app.request(url, { headers })).status).toBe(404);
      expect(await (await app.request(`${prefix}/visualize/sessions/${code}/summaries`, { headers })).json()).toMatchObject({ summaries: [{ studentId: "SE1", hasSummary: false, source: "none" }, { studentId: "SE2", hasSummary: false, source: "none" }] });
      expect((await app.request(url.replace("accounts/SE1/summary?auto=true", "summary-manifest"), { headers })).status).toBe(404);
      expect(generate).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); sessions.delete(code); lecturerAccounts.delete(owner); lecturerAccounts.delete(stranger); }
  });

  test(`${prefix}: manual single and session generation round-trip through child process, persistence and API`, async () => {
    const code = `SUMMARY_GEN_${index}`, owner = `summary-generator-${index}`;
    const headers = await teacher(owner); session(code, owner);
    const root = storage.getLocalSessionDir(code);
    for (const id of ["SE1", "SE2"]) {
      fs.mkdirSync(path.join(root, id, "exam_records", "REC"), { recursive: true });
      fs.writeFileSync(path.join(root, id, "exam_records", "REC", "events.jsonl"), '{"event":"save"}\n');
    }
    try { await withEngine(async () => {
      const base = `${prefix}/visualize/sessions/${code}`;
      const single = await app.request(`${base}/accounts/SE1/summary/generate`, { method: "POST", headers });
      expect(single.status).toBe(200);
      const singleResult = await single.json();
      expect(singleResult).toMatchObject({ ok: true, markdown: "# Summary SE1 — thử nghiệm" });
      expect(singleResult.engineEnvNames).not.toContain("JWT_SECRET");
      expect(singleResult.engineEnvNames).not.toContain("PROXY_API_KEY");
      expect(await (await app.request(`${base}/accounts/SE1/summary`, { headers })).json()).toMatchObject({ markdown: "# Summary SE1 — thử nghiệm", metadata: { metrics: { requests_count: 2 } }, source: "local" });
      const batch = await app.request(`${base}/summary/generate-all`, { method: "POST", headers: admin });
      expect(batch.status).toBe(200);
      expect((await batch.json()).reports.SE2.markdown).toBe("# Summary SE2 — thử nghiệm");
      expect(await (await app.request(`${base}/accounts/SE2/summary`, { headers })).json()).toMatchObject({ markdown: "# Summary SE2 — thử nghiệm", metadata: { check_report: { ok: true } } });
      expect(await (await app.request(`${base}/summaries`, { headers })).json()).toMatchObject({ ok: true, summaries: [{ studentId: "SE1", hasSummary: true }, { studentId: "SE2", hasSummary: true }] });
      expect(await (await app.request(`${base}/summary-manifest`, { headers })).json()).toMatchObject({ manifestMarkdown: "# Session summary", source: "local" });
      const failed = await app.request(`${base}/accounts/FAIL/summary/generate`, { method: "POST", headers });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ ok: false, error: "Unable to generate summary. Check the engine configuration or try again." });
      expect(fs.readdirSync(path.resolve("logs", "temp_summaries"))).toEqual([]);
    }, index === 1); } finally { sessions.delete(code); lecturerAccounts.delete(owner); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${prefix}: offline ZIP supports single/batch, blocks foreign writes and cleans temporary files`, async () => {
    const code = `SUMMARY_OFFLINE_${index}`, owner = `summary-importer-${index}`, stranger = `${owner}-other`;
    const headers = await teacher(owner), other = await teacher(stranger); session(code, owner);
    const url = `${prefix}/visualize/summary/generate-from-zip`;
    function form(sessionCode = code, mode = "single", buffer = archive()) {
      const data = new FormData(); data.set("file", new Blob([buffer]), "logs.zip"); data.set("sessionCode", sessionCode); data.set("mode", mode);
      if (mode === "single") data.set("studentId", "SE1");
      return data;
    }
    try { await withEngine(async () => {
      expect((await app.request(url, { method: "POST", body: form() })).status).toBe(401);
      expect((await app.request(url, { method: "POST", headers: { ...headers, "Content-Length": String(SUMMARY_MAX_ARCHIVE_BYTES + 1) }, body: form() })).status).toBe(413);
      expect((await app.request(url, { method: "POST", headers: other, body: form() })).status).toBe(403);
      expect(fs.existsSync(storage.getLocalSessionDir(code))).toBe(false);
      expect((await app.request(url, { method: "POST", headers, body: form("../BAD") })).status).toBe(400);
      expect((await app.request(url, { method: "POST", headers, body: form(code, "single", Buffer.from("not a zip")) })).status).toBe(400);
      const single = await app.request(url, { method: "POST", headers, body: form() });
      expect(single.status).toBe(200);
      expect(await storage.getStudentSummary(code, "SE1")).toMatchObject({ markdown: "# Summary SE1 — thử nghiệm" });
      const historical = `${code}_HISTORY`;
      const batch = await app.request(url, { method: "POST", headers, body: form(historical, "all") });
      expect(batch.status).toBe(200);
      expect((await batch.json()).reports.SE2.markdown).toBe("# Summary SE2 — thử nghiệm");
      expect(fs.existsSync(storage.getLocalSessionDir(historical))).toBe(false);
      expect(fs.readdirSync(path.resolve("logs", "temp_zips"))).toEqual([]);
      expect(fs.readdirSync(path.resolve("logs", "temp_summaries"))).toEqual([]);
    }); } finally { sessions.delete(code); lecturerAccounts.delete(owner); lecturerAccounts.delete(stranger); fs.rmSync(storage.getLocalSessionDir(code), { recursive: true, force: true }); }
  });
}

test("summary archive ENV budgets are independent from student-upload limits", () => {
  const input = path.resolve("summary-budget-fixture.zip");
  fs.writeFileSync(input, archive());
  const moduleUrl = new URL("../src/services/summaryArchive.ts", import.meta.url).href;
  const script = `import fs from 'node:fs'; const {validateSummaryZip}=await import(${JSON.stringify(moduleUrl)}); validateSummaryZip(fs.readFileSync(${JSON.stringify(input)}));`;
  function check(files: string, bytes: string) {
    return Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", "--eval", script], cwd: process.cwd(), env: { ...process.env, MAX_UPLOAD_BYTES: "1", MAX_UPLOAD_FILES: "1", SUMMARY_MAX_ARCHIVE_FILES: files, SUMMARY_MAX_ARCHIVE_BYTES: bytes }, stdout: "pipe", stderr: "pipe" });
  }
  try {
    expect(check("2", "1048576").exitCode).toBe(0);
    expect(check("1", "1048576").stderr.toString()).toContain("too many entries");
    expect(check("2", "1").stderr.toString()).toContain("archive limits");
    expect(check("invalid", "1048576").stderr.toString()).toContain("Invalid summary archive limits");
  } finally { fs.unlinkSync(input); }
});

test("summary fails clearly when engine is not installed without altering telemetry", async () => {
  const cli = process.env.SUMMARY_CLI_PATH, binary = process.env.SUMMARY_ENGINE_BIN;
  process.env.SUMMARY_CLI_PATH = path.resolve("missing-cli.py"); process.env.SUMMARY_ENGINE_BIN = path.resolve("missing-engine");
  try { await expect(storage.generateStudentSummary("MISSING", "SE1")).rejects.toThrow("Summary engine unavailable"); }
  finally {
    if (cli === undefined) delete process.env.SUMMARY_CLI_PATH; else process.env.SUMMARY_CLI_PATH = cli;
    if (binary === undefined) delete process.env.SUMMARY_ENGINE_BIN; else process.env.SUMMARY_ENGINE_BIN = binary;
  }
});
