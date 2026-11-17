import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import http from "node:http";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { sessions } = await import("../src/services/sessionStore");
const { eventBus } = await import("../src/services/eventBus");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);

for (const [index, prefix] of ["/session", "/v1/session"].entries()) {
  test(`${prefix}: current SSE headers deliver incremental events over real loopback HTTP`, async () => {
    const code = `SSE_HTTP_${index}`;
    const now = Math.floor(Date.now() / 1000);
    sessions.set(code, { sessionCode: code, startTime: now, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60,
      defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEHTTP"]), createdAt: Date.now() });
    const token = await sign({ sessionCode: code, studentId: "SEHTTP", exp: now + 600 }, getJwtSecret(), "HS256");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const received: string[] = [];
        let emitTimer: ReturnType<typeof setTimeout> | undefined;
        const request = http.get(`http://127.0.0.1:${server.port}${prefix}/events/stream`, {
          agent: false,
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", "Accept-Encoding": "gzip, br" },
        });
        const timeout = setTimeout(() => request.destroy(new Error("Loopback SSE did not deliver/close within 5 seconds")), 5000);
        const fail = (error: unknown) => { request.destroy(); reject(error); };
        request.on("error", fail);
        request.on("response", (response) => {
          try {
            expect(response.statusCode).toBe(200);
            expect(response.headers["content-type"]).toContain("text/event-stream");
            expect(response.headers["cache-control"]).toBe("no-cache");
            expect(response.headers["x-accel-buffering"]).toBe("no");
            expect(response.headers["content-encoding"]).toBeUndefined();
          } catch (error) { fail(error); return; }
          response.setEncoding("utf8");
          response.on("error", fail);
          response.on("data", (chunk: string) => {
            buffer += chunk;
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (frame.includes("event: connected")) {
                received.push("connected");
                emitTimer = setTimeout(() => eventBus.publishIemUpdate({ sessionCode: code, studentId: "SEHTTP", id: "http-fixture", label: "executive", confidence: 0.9, timestamp: Date.now() }), 10);
              } else if (frame.includes("event: iem_update")) {
                received.push("iem_update");
                // Reaching this callback proves delivery before the stream closes.
                eventBus.publishSessionEnd(code, "HTTP fixture finished");
              } else if (frame.includes("event: session_ended")) {
                received.push("session_ended");
              }
            }
          });
          response.on("end", () => {
            try {
              expect(received).toEqual(["connected", "iem_update", "session_ended"]);
              resolve();
            } catch (error) { reject(error); }
          });
        });
        request.on("close", () => { clearTimeout(timeout); if (emitTimer) clearTimeout(emitTimer); });
      });
    } finally { server.stop(true); sessions.delete(code); }
  }, 10000);
}
