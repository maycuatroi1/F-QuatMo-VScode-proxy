import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { summaryStorageService: storage } = await import("../src/services/summaryStorage");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/admin", adminRouter); app.route("/v1/admin", adminRouter);
app.route("/session", sessionAuthRouter); app.route("/v1/session", sessionAuthRouter);
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };

test("summary cache replacement preserves the prior report when atomic rename fails", async () => {
  const code = "ATOMIC_SUMMARY_FIXTURE";
  await storage.saveStudentSummary(code, "SE1", "original report", { original: true });
  const rename = spyOn(fs.promises, "rename").mockRejectedValue(new Error("synthetic disk error"));
  try {
    await expect(storage.saveStudentSummary(code, "SE1", "new report", {})).rejects.toThrow("synthetic disk error");
    expect((await storage.getStudentSummary(code, "SE1"))?.markdown).toBe("original report");
    expect(fs.readdirSync(storage.getLocalStudentDir(code, "SE1")).sort()).toEqual(["summary.json", "summary.md"]);
  } finally { rename.mockRestore(); fs.rmSync(storage.getLocalSessionDir(code), { recursive: true, force: true }); }
});

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: generation bounds all job endpoints and releases capacity after failure`, async () => {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const single = spyOn(storage, "generateStudentSummary").mockImplementation(async () => { started(); await wait; return { ok: true, markdown: "synthetic" }; });
    const batch = spyOn(storage, "generateSessionSummaries").mockResolvedValue({ ok: true });
    const read = spyOn(storage, "getStudentSummary").mockResolvedValue(null);
    const log = spyOn(console, "error").mockImplementation(() => {});
    const base = `${prefix}/visualize/sessions/SECURITY_FIXTURE`;
    const url = `${base}/accounts/SE1/summary/generate`;
    const maximum = process.env.SUMMARY_MAX_CONCURRENT_JOBS;
    process.env.SUMMARY_MAX_CONCURRENT_JOBS = "1";
    const first = app.request(url, { method: "POST", headers: admin });
    try {
      await entered;
      expect((await app.request(url, { method: "POST", headers: admin })).status).toBe(429);
      expect((await app.request(`${base}/summary/generate-all`, { method: "POST", headers: admin })).status).toBe(429);
      expect((await app.request(`${prefix}/visualize/summary/generate-from-zip`, { method: "POST", headers: admin, body: "invalid body" })).status).toBe(429);
      expect(batch).not.toHaveBeenCalled();
      expect((await app.request(`${base}/accounts/SE1/summary`, { headers: admin })).status).toBe(404);
      release(); expect((await first).status).toBe(200);
      const sensitive = Object.assign(new Error("private synthetic stdout credential"), { stdout: "private report", stderr: "private key", code: 1 });
      single.mockRejectedValue(sensitive);
      const failed = await app.request(url, { method: "POST", headers: admin });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).not.toContain("private");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      single.mockResolvedValue({ ok: true });
      expect((await app.request(url, { method: "POST", headers: admin })).status).toBe(200);
      process.env.SUMMARY_MAX_CONCURRENT_JOBS = "invalid";
      expect((await app.request(url, { method: "POST", headers: admin })).status).toBe(503);
    } finally {
      release(); await first;
      single.mockRestore(); batch.mockRestore(); read.mockRestore(); log.mockRestore();
      if (maximum === undefined) delete process.env.SUMMARY_MAX_CONCURRENT_JOBS; else process.env.SUMMARY_MAX_CONCURRENT_JOBS = maximum;
    }
  });

  test(`${prefix}: wildcard admin authentication covers encoded line terminators`, async () => {
    for (const suffix of ["", "%0A", "%0D", "%E2%80%A8"]) {
      const response = await app.request(`${prefix}/visualize/sessions/SECURITY_FIXTURE/accounts/SE1/summary${suffix}`);
      expect(response.status === 401 || response.status === 404).toBe(true);
    }
  });

  for (const multipart of [false, true]) {
    test(`${prefix}: ${multipart ? "multipart" : "JSON"} student upload cannot replace generated summaries`, async () => {
      const code = `SUMMARY_RESERVED_${index}_${multipart ? "FORM" : "JSON"}`;
      const root = storage.getLocalStudentDir(code, "SE1");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "summary.md"), "original generated report");
      fs.writeFileSync(path.join(root, "summary.json"), '{"original":true}');
      const jwt = await sign({ sessionCode: code, studentId: "SE1", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256");
      const files = ["summary.md", "./summary.json", "SUMMARY.MD", "nested/summary.md", "evidence.txt"];
      const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
      let body: string | FormData;
      if (multipart) {
        body = new FormData(); body.set("filePaths", JSON.stringify(files));
        for (let i = 0; i < files.length; i++) body.append("files", new Blob(["synthetic upload"]), `file${i}`);
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({ files: files.map(relativePath => ({ relativePath, content: "synthetic upload" })) });
      }
      try {
        const response = await app.request(`${index === 0 ? "/session" : "/v1/session"}/upload-logs`, { method: "POST", headers, body });
        expect(response.status).toBe(200);
        expect((await response.json()).savedCount).toBe(2);
        expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toBe("original generated report");
        expect(fs.readFileSync(path.join(root, "summary.json"), "utf8")).toBe('{"original":true}');
        expect(fs.readFileSync(path.join(root, "nested", "summary.md"), "utf8")).toBe("synthetic upload");
        expect(fs.readFileSync(path.join(root, "evidence.txt"), "utf8")).toBe("synthetic upload");
      } finally { fs.rmSync(path.dirname(root), { recursive: true, force: true }); }
    });
  }
}
