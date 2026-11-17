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

async function teacher(username: string) {
  lecturerAccounts.set(username, { username, name: username, passwordHash: "fixture-only", status: "active", createdAt: 1, createdBy: "admin", updatedAt: 1, updatedBy: "admin" });
  return { Authorization: `Bearer ${await sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 600 }, getJwtSecret(), "HS256")}`, "Content-Type": "application/json" };
}

for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: record upload persists exact artifacts and S3 calls with owner isolation`, async () => {
    const code = `UPLOAD_RECORD_${index}`;
    const owner = `record-owner-${index}`;
    const other = `${owner}-other`;
    const ownAuth = await teacher(owner);
    const otherAuth = await teacher(other);
    sessions.set(code, { sessionCode: code, createdBy: owner, startTime: 123, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEUPLOAD"]), createdAt: 123 });
    const root = path.join(process.cwd(), "logs", "sessions", code);
    const directory = path.join(root, "SEUPLOAD", "exam_records", "REC_1");
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(true);
    const upload = spyOn(s3Storage, "uploadExamRecordFile").mockResolvedValue(true);
    const metadata = { name: "Dữ liệu thử", sequence: 1 };
    const events = [{ event: "edit", timestamp: 123 }, { event: "save", timestamp: 124 }];
    const interactions = [{ prompt: "fixture", tokensConsumedTotal: 17 }];
    const snapshot = Buffer.from([80, 75, 3, 4, 0, 255]);
    const payload = { recordId: "../REC_1", metadata, events, aiInteractions: interactions, snapshotZipBase64: snapshot.toString("base64") };
    const url = `${prefix}/visualize/sessions/${code}/accounts/seupload/upload-record`;
    const request = (headers: Record<string, string>, body: unknown) => app.request(url, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      expect((await request({}, payload)).status).toBe(401);
      expect((await request(otherAuth, payload)).status).toBe(403);
      expect(fs.existsSync(root)).toBe(false);
      expect(upload).not.toHaveBeenCalled();
      expect((await request(ownAuth, {})).status).toBe(400);
      const response = await request(ownAuth, payload);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, sessionCode: code, studentId: "SEUPLOAD", recordId: "REC_1" });
      expect(fs.readFileSync(path.join(directory, "metadata.json"), "utf8")).toBe(JSON.stringify(metadata, null, 2));
      expect(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8")).toBe(events.map((e) => JSON.stringify(e)).join("\n"));
      expect(fs.readFileSync(path.join(directory, "ai_interactions.jsonl"), "utf8")).toBe(JSON.stringify(interactions[0]));
      expect(fs.readFileSync(path.join(directory, "snapshot_start.zip"))).toEqual(snapshot);
      expect(upload.mock.calls).toEqual([
        [code, "SEUPLOAD", "REC_1", "metadata.json", JSON.stringify(metadata, null, 2), "application/json"],
        [code, "SEUPLOAD", "REC_1", "events.jsonl", events.map((e) => JSON.stringify(e)).join("\n"), "application/x-ndjson"],
        [code, "SEUPLOAD", "REC_1", "ai_interactions.jsonl", JSON.stringify(interactions[0]), "application/x-ndjson"],
        [code, "SEUPLOAD", "REC_1", "snapshot_start.zip", snapshot, "application/zip"],
      ]);
      available.mockReturnValue(false);
      upload.mockClear();
      const raw = { recordId: "REC_RAW", metadata: '{"raw":true}\n', events: '{"raw":"event"}\n\n', aiInteractions: '{"raw":"ai"}\n' };
      expect((await request(ownAuth, raw)).status).toBe(200);
      for (const [filename, content] of [["metadata.json", raw.metadata], ["events.jsonl", raw.events], ["ai_interactions.jsonl", raw.aiInteractions]]) {
        expect(fs.readFileSync(path.join(root, "SEUPLOAD", "exam_records", "REC_RAW", filename), "utf8")).toBe(content);
      }
      expect(upload).not.toHaveBeenCalled();
    } finally {
      available.mockRestore(); upload.mockRestore(); sessions.delete(code);
      for (const username of [owner, other]) lecturerAccounts.delete(username);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${prefix}: S3 status preserves configured endpoint, admin guard and error response`, async () => {
    const owner = `storage-status-${index}`;
    const auth = await teacher(owner);
    const oldEndpoint = process.env.S3_ENDPOINT;
    process.env.S3_ENDPOINT = "https://storage.example.test";
    const available = spyOn(s3Storage, "isAvailable").mockReturnValue(false);
    const bucket = spyOn(s3Storage, "getBucketName").mockReturnValue("fixture-bucket");
    const listing = spyOn(s3Storage, "listSessionsFromS3").mockResolvedValue(["S1", "S2"]);
    const guests = spyOn(s3Storage, "listGuestsFromS3").mockResolvedValue(["G1"]);
    const url = `${prefix}/s3/status`;
    try {
      expect((await app.request(url)).status).toBe(401);
      expect((await app.request(url, { headers: auth })).status).toBe(403);
      expect(available).not.toHaveBeenCalled();
      expect(await (await app.request(url, { headers: admin })).json()).toEqual({ status: "unconfigured", available: false, message: "S3 credentials are not configured in .env", endpoint: "https://storage.example.test", bucket: "fixture-bucket" });
      expect(listing).not.toHaveBeenCalled();
      available.mockReturnValue(true);
      expect(await (await app.request(url, { headers: admin })).json()).toEqual({ status: "connected", available: true, endpoint: "https://storage.example.test", bucket: "fixture-bucket", totalSessionsOnS3: 2, sessions: ["S1", "S2"], totalGuestsOnS3: 1, guests: ["G1"] });
      listing.mockRejectedValue(new Error("fixture storage unavailable"));
      const failed = await app.request(url, { headers: admin });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ status: "error", available: false, error: "fixture storage unavailable" });
    } finally {
      available.mockRestore(); bucket.mockRestore(); listing.mockRestore(); guests.mockRestore(); lecturerAccounts.delete(owner);
      if (oldEndpoint === undefined) delete process.env.S3_ENDPOINT; else process.env.S3_ENDPOINT = oldEndpoint;
    }
  });
}
