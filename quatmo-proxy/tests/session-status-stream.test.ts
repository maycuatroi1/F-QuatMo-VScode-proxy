import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { sessions, sessionStates } = await import("../src/services/sessionStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const { redisStore } = await import("../src/services/classifier/redisStore");
const { eventBus } = await import("../src/services/eventBus");
const app = new Hono();
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);

for (const [index, prefix] of ["/session", "/v1/session"].entries()) {
  const seed = (code: string, duration = 60, validity = 30) => {
    const now = Math.floor(Date.now() / 1000);
    sessions.set(code, { sessionCode: code, startTime: now, durationMinutes: duration, aiOption: "agent", aiValidityMinutes: validity, defaultTokenBudget: 1000,
      runtimeConfig: { enabled: true, runtimeType: "python", runtimeVersion: "3.12" }, allowedStudentIds: new Set(["SESTATUS"]), createdAt: Date.now() });
    sessionStates.set(`${code}:SESTATUS`, { sessionCode: code, studentId: "SESTATUS", hasLoggedIn: true, loginTimestamp: now, reassigned: false, tokensConsumed: 137, latestClassification: "mixed" });
    return now;
  };
  const token = (code: string, now: number, studentId = "SESTATUS") => sign({ sessionCode: code, studentId, loginTime: now, exp: now + 3600 }, getJwtSecret(), "HS256");
  const status = (jwt?: string) => app.request(`${prefix}/status`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });

  test(`${prefix}: status preserves authentication and missing-session/state responses`, async () => {
    const code = `SESSION_STATUS_AUTH_${index}`;
    const now = seed(code);
    try {
      expect((await status()).status).toBe(401);
      expect((await status("invalid")).status).toBe(401);
      expect((await status(await token(`${code}_MISSING`, now))).status).toBe(404);
      const missing = await status(await token(code, now, "MISSING"));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Student session state not found." });
    } finally { sessions.delete(code); }
  });

  test(`${prefix}: status retains usage, runtime configuration and versionless access after reassign flags`, async () => {
    const code = `SESSION_STATUS_DATA_${index}`;
    const now = seed(code);
    try {
      const jwt = await token(code, now);
      const response = await status(jwt);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ success: true, studentId: "SESTATUS", sessionCode: code, aiOption: "agent", tokenBudget: 1000, tokensConsumed: 137, tokensRemaining: 863,
        runtimeConfig: { enabled: true, runtimeType: "python", runtimeVersion: "3.12" } });
      expect(body.sessionRemainingMinutes).toBeGreaterThanOrEqual(59);
      expect(body.sessionRemainingMinutes).toBeLessThanOrEqual(60);
      expect(body.aiRemainingMinutes).toBeGreaterThanOrEqual(29);
      expect(body.aiRemainingMinutes).toBeLessThanOrEqual(30);
      const state = sessionStates.get(`${code}:SESTATUS`)!;
      sessionStates.set(`${code}:SESTATUS`, { ...state, hasLoggedIn: false, reassigned: true });
      expect((await status(jwt)).status).toBe(200);
    } finally { sessions.delete(code); }
  });

  test(`${prefix}: unlimited status retains -1 durations and zero-clamped remaining budget`, async () => {
    const code = `SESSION_STATUS_UNLIMITED_${index}`;
    const now = seed(code, -1, -1);
    const state = sessionStates.get(`${code}:SESTATUS`)!;
    sessionStates.set(`${code}:SESTATUS`, { ...state, tokensConsumed: 1200 });
    try {
      expect(await (await status(await token(code, now))).json()).toMatchObject({ tokensConsumed: 1200, tokensRemaining: 0, sessionRemainingMinutes: -1, aiRemainingMinutes: -1 });
    } finally { sessions.delete(code); }
  });

  test(`${prefix}: query-token SSE retains initial state, replay and session-end closure`, async () => {
    const code = `SESSION_STREAM_ALIAS_${index}`;
    const now = seed(code);
    const cached = spyOn(redisStore, "getCachedClassification").mockResolvedValue(null);
    const latest = spyOn(redisStore, "getLatestEvent").mockResolvedValue({ id: "new-event", label: "executive", confidence: 0.9, timestamp: Date.now() } as any);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const jwt = await token(code, now);
      const response = await app.request(`${prefix}/events/stream?token=${encodeURIComponent(jwt)}&lastEventId=old-event`);
      reader = response.body!.getReader();
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      // Hono currently overwrites the route's no-transform directive.
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("X-Accel-Buffering")).toBe("no");
      const connected = new TextDecoder().decode((await reader.read()).value);
      expect(connected).toContain("event: connected");
      expect(connected).toContain('"activeClassification":"mixed"');
      const replay = new TextDecoder().decode((await reader.read()).value);
      expect(replay).toContain("event: iem_update");
      expect(replay).toContain("new-event");
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ping");
      await new Promise((resolve) => setTimeout(resolve, 10));
      eventBus.publishSessionEnd(code, "Fixture closed");
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("Fixture closed");
      expect((await reader.read()).done).toBe(true);
    } finally {
      if (reader) await reader.cancel();
      cached.mockRestore(); latest.mockRestore(); sessions.delete(code);
    }
  });
}
