import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { randomUUID } from "node:crypto";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { summaryStorageService: storage } = await import("../src/services/summaryStorage");
const { startSummaryProgress, updateSummaryProgress, getSummaryProgress } = await import("../src/services/summaryProgress");
const { lecturerAccounts } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono(); app.route("/admin", adminRouter); app.route("/v1/admin", adminRouter);
const admin = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };

test("progress counts completed units and reaches 100 only after persistence finishes", () => {
  const id = randomUUID();
  expect(startSummaryProgress(id, "fixture-owner")).toBe(true);
  expect(getSummaryProgress(id, "fixture-owner")).toEqual({ stage: "preparing", completed: 0, total: null, percent: null });
  updateSummaryProgress(id, { stage: "generating", completed: 0, total: 2 });
  expect(getSummaryProgress(id, "fixture-owner")?.percent).toBe(40);
  updateSummaryProgress(id, { stage: "generating", completed: 1, total: 2 });
  expect(getSummaryProgress(id, "fixture-owner")?.percent).toBe(60);
  updateSummaryProgress(id, { stage: "generating", completed: 0, total: 2 });
  updateSummaryProgress(id, { stage: "generating", completed: 2, total: 3 });
  expect(getSummaryProgress(id, "fixture-owner")?.percent).toBe(60);
  updateSummaryProgress(id, { stage: "saving", completed: 2, total: 2 });
  expect(getSummaryProgress(id, "fixture-owner")?.percent).toBe(80);
  expect(getSummaryProgress(id, "other-owner")).toBeNull();
  updateSummaryProgress(id, { stage: "completed" });
  expect(getSummaryProgress(id, "fixture-owner")?.percent).toBe(100);
  updateSummaryProgress(id, { stage: "generating", completed: 0, total: 2 });
  expect(getSummaryProgress(id, "fixture-owner")?.stage).toBe("completed");
});

test("failed engine closes the progress job without success or sensitive error data", async () => {
  const id = randomUUID();
  const generate = spyOn(storage, "generateStudentSummary").mockImplementation(async (_code, _id, _zip, _persist, report) => {
    report?.({ stage: "generating", completed: 0, total: 1 });
    throw new Error("synthetic secret must never be in the response");
  });
  try {
    const response = await app.request(`/admin/visualize/sessions/PROGRESS_FIXTURE/accounts/SE1/summary/generate?jobId=${id}`, { method: "POST", headers: admin });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic secret");
    expect(await (await app.request(`/admin/visualize/summary/jobs/${id}`, { headers: admin })).json()).toEqual({ ok: true, stage: "failed", completed: 0, total: 1, percent: 50 });
  } finally { generate.mockRestore(); }
});

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: job progress is authenticated, caller-scoped and never contains report data`, async () => {
    const id = randomUUID(), username = `progress-observer-${index}`;
    lecturerAccounts.set(username, { username, name: username, passwordHash: "fixture-only", status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin" });
    const stranger = { Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}` };
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const generate = spyOn(storage, "generateStudentSummary").mockImplementation(async (_code, _id, _zip, _persist, report) => {
      report?.({ stage: "generating", completed: 0, total: 1 }); entered();
      await pending;
      report?.({ stage: "saving", completed: 1, total: 1 });
      return { ok: true, markdown: "synthetic private report" };
    });
    const url = `${prefix}/visualize/sessions/PROGRESS_FIXTURE/accounts/SE1/summary/generate?jobId=${id}`;
    const request = app.request(url, { method: "POST", headers: admin });
    try {
      await started;
      const statusUrl = `${prefix}/visualize/summary/jobs/${id}`;
      expect((await app.request(statusUrl)).status).toBe(401);
      expect((await app.request(statusUrl, { headers: stranger })).status).toBe(404);
      const status = await (await app.request(statusUrl, { headers: admin })).json();
      expect(status).toEqual({ ok: true, stage: "generating", completed: 0, total: 1, percent: 50 });
      expect(JSON.stringify(status)).not.toContain("private");
      release(); expect((await request).status).toBe(200);
      expect(await (await app.request(statusUrl, { headers: admin })).json()).toMatchObject({ stage: "completed", completed: 1, total: 1, percent: 100 });
      expect((await app.request(url, { method: "POST", headers: admin })).status).toBe(409);
      expect((await app.request(url.replace(id, "invalid"), { method: "POST", headers: admin })).status).toBe(400);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { release(); await request; generate.mockRestore(); lecturerAccounts.delete(username); }
  });
}
