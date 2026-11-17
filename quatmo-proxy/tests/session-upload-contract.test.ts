import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);

for (const [index, prefix] of ["/session", "/v1/session"].entries()) {
  test(`${prefix}: upload verifies identity/signature and retains the existing 14-day grace`, async () => {
    const code = `UPLOAD_AUTH_${index}`;
    const id = "SEUPLOAD";
    const directory = path.join(process.cwd(), "logs", "sessions", code, id);
    const now = Math.floor(Date.now() / 1000);
    const token = (exp: number, extra = {}) => sign({ sessionCode: code, studentId: id, exp, sessionEndTime: exp, ...extra }, getJwtSecret(), "HS256");
    const upload = (jwt: string, extra = {}) => app.request(`${prefix}/upload-logs`, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode: code, studentId: id, files: [{ relativePath: "evidence.txt", content: "fixture evidence" }], ...extra }) });
    try {
      expect((await upload("invalid")).status).toBe(401);
      expect((await upload(await token(now + 600), { studentId: "OTHER" })).status).toBe(403);
      expect((await upload(await sign({ studentId: id, type: "user", exp: now + 600 }, getJwtSecret(), "HS256"))).status).toBe(403);
      expect((await upload(await token(now - 15 * 86400))).status).toBe(401);
      expect(fs.existsSync(directory)).toBe(false);
      const accepted = await upload(await token(now - 60));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ success: true, savedCount: 1, sessionCode: code, studentId: id });
      expect(fs.readFileSync(path.join(directory, "evidence.txt"), "utf8")).toBe("fixture evidence");
    } finally { fs.rmSync(path.dirname(directory), { recursive: true, force: true }); }
  });

  test(`${prefix}: JSON and multipart uploads retain safe paths and exact binary bytes`, async () => {
    const code = `UPLOAD_PATHS_${index}`;
    const directory = path.join(process.cwd(), "logs", "sessions", code, "SEUPLOAD");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await sign({ sessionCode: code, studentId: "SEUPLOAD", exp: now + 600 }, getJwtSecret(), "HS256");
    try {
      const first = await app.request(`${prefix}/upload-logs`, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify({ files: [
        { relativePath: "../escape.txt", content: "unsafe" }, { relativePath: "upload_info.json", content: "unsafe" }, { relativePath: "nested/ok.txt", content: "Tiếng Việt" },
      ] }) });
      expect(first.status).toBe(200);
      expect((await first.json()).savedCount).toBe(1);
      expect(fs.existsSync(path.join(path.dirname(directory), "escape.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(directory, "nested/ok.txt"), "utf8")).toBe("Tiếng Việt");
      const bytes = Buffer.from([0, 255, 80, 75, 3, 4]);
      const form = new FormData();
      form.set("filePaths", JSON.stringify(["nested/record.bin"]));
      form.append("files", new Blob([bytes]), "upload.bin");
      const multipart = await app.request(`${prefix}/upload-logs`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
      expect(multipart.status).toBe(200);
      expect((await multipart.json()).savedCount).toBe(1);
      expect(fs.readFileSync(path.join(directory, "nested/record.bin"))).toEqual(bytes);
      expect(JSON.parse(fs.readFileSync(path.join(directory, "upload_info.json"), "utf8"))).toMatchObject({ sessionCode: code, studentId: "SEUPLOAD" });
    } finally { fs.rmSync(path.dirname(directory), { recursive: true, force: true }); }
  });
}
