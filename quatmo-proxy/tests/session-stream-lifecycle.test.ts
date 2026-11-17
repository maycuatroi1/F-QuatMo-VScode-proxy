import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { getJwtSecret } from "../src/services/jwtKey";
import { sessions, sessionStates } from "../src/services/sessionStore";
import { sessionAuthRouter } from "../src/routes/sessionAuth";
import { eventBus } from "../src/services/eventBus";
import { redisStore } from "../src/services/classifier/redisStore";

const app = new Hono();
app.route("/session", sessionAuthRouter);

describe("Session-Gated SSE Stream Lifecycle & State Recovery", () => {
  const jwtSecret = getJwtSecret();

  it("should reject request with 401 if token is missing", async () => {
    const res = await app.request("/session/events/stream");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Missing or invalid token");
  });

  it("should reject request with 401 if token is invalid or malformed", async () => {
    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: "Bearer invalid.fake.token",
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid or expired session token");
  });

  it("should reject request with 401 if token is missing sessionCode or studentId", async () => {
    const token = await sign({ role: "student" }, jwtSecret);
    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Token is missing sessionCode or studentId");
  });

  it("should reject request with 404 if session does not exist in sessions store", async () => {
    const token = await sign(
      { sessionCode: "NONEXISTENT_SESSION", studentId: "SE12345" },
      jwtSecret,
    );
    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Session does not exist or has ended");
  });

  it("should reject request with 403 if session duration has already expired", async () => {
    const sessionCode = "EXPIRED_TEST_SESSION";
    const now = Math.floor(Date.now() / 1000);
    sessions.set(sessionCode, {
      sessionCode,
      startTime: now - 3600,
      durationMinutes: 30, // Ended 30 minutes ago
      aiOption: "chatbot",
      aiValidityMinutes: 30,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set(["SE99999"]),
      createdAt: now - 3600,
    });

    const token = await sign(
      { sessionCode, studentId: "SE99999" },
      jwtSecret,
    );
    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Session duration has expired");
  });

  it("should establish SSE stream 200 with text/event-stream for active session and emit connected event", async () => {
    const sessionCode = "ACTIVE_TEST_SESSION";
    const now = Math.floor(Date.now() / 1000);
    sessions.set(sessionCode, {
      sessionCode,
      startTime: now,
      durationMinutes: 90,
      aiOption: "chatbot",
      aiValidityMinutes: 90,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set(["SE88888"]),
      createdAt: now,
    });

    const token = await sign(
      { sessionCode, studentId: "SE88888" },
      jwtSecret,
    );

    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read first chunk to verify initial connected event
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: connected");
      expect(text).toContain(sessionCode);
      expect(text).toContain("SE88888");
      await reader.cancel();
    }
  });

  it("should re-sync missed event when client reconnects with Last-Event-ID", async () => {
    const sessionCode = "RESYNC_TEST_SESSION";
    const studentId = "SE77777";
    const now = Math.floor(Date.now() / 1000);

    sessions.set(sessionCode, {
      sessionCode,
      startTime: now,
      durationMinutes: 90,
      aiOption: "chatbot",
      aiValidityMinutes: 90,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
    });

    // Cache a recent event in redisStore
    const cachedEvent = {
      id: `${sessionCode}-${studentId}-2000`,
      label: "instrumental",
      confidence: 0.95,
      iScoreS: 0.85,
      eScoreS: 0.15,
      timestamp: Date.now(),
    };
    await redisStore.cacheLatestEvent(sessionCode, studentId, cachedEvent);

    const token = await sign({ sessionCode, studentId }, jwtSecret);

    // Client reconnects sending Last-Event-ID older than cachedEvent.id
    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Last-Event-ID": `${sessionCode}-${studentId}-1000`,
      },
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      let accumulated = "";
      // Read chunks until we see the cached event
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
        if (accumulated.includes(cachedEvent.id)) break;
      }
      expect(accumulated).toContain("event: connected");
      expect(accumulated).toContain(cachedEvent.id);
      expect(accumulated).toContain("instrumental");
      await reader.cancel();
    }
  });

  it("should deliver realtime IEM update when published on EventBus", async () => {
    const sessionCode = "BUS_TEST_SESSION";
    const studentId = "SE66666";
    const now = Math.floor(Date.now() / 1000);

    sessions.set(sessionCode, {
      sessionCode,
      startTime: now,
      durationMinutes: 90,
      aiOption: "chatbot",
      aiValidityMinutes: 90,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
    });

    const token = await sign({ sessionCode, studentId }, jwtSecret);

    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    if (reader) {
      // Read initial connected event
      const firstChunk = await reader.read();
      const firstText = new TextDecoder().decode(firstChunk.value);
      expect(firstText).toContain("event: connected");

      // Publish an event via eventBus
      const testUpdate = {
        label: "executive",
        confidence: 0.88,
        iScoreS: 0.2,
        eScoreS: 0.8,
        iScoreTurn: 0.1,
        eScoreTurn: 0.9,
        windowSize: 4,
        timestamp: Date.now(),
      };

      // Allow subscriber setup
      await new Promise((r) => setTimeout(r, 50));
      eventBus.publishIemUpdate({ sessionCode, studentId, token, ...testUpdate });

      // Read next chunk from SSE stream
      const secondChunk = await reader.read();
      const secondText = new TextDecoder().decode(secondChunk.value);
      expect(secondText).toContain("event: iem_update");
      expect(secondText).toContain("executive");
      expect(secondText).toContain("0.88");

      await reader.cancel();
    }
  });

  it("should immediately emit session_ended and close stream when session is closed via EventBus", async () => {
    const sessionCode = "CLOSE_TEST_SESSION";
    const studentId = "SE55555";
    const now = Math.floor(Date.now() / 1000);

    sessions.set(sessionCode, {
      sessionCode,
      startTime: now,
      durationMinutes: 90,
      aiOption: "chatbot",
      aiValidityMinutes: 90,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now,
    });

    const token = await sign({ sessionCode, studentId }, jwtSecret);

    const res = await app.request("/session/events/stream", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    if (reader) {
      // Read initial connected event
      const firstChunk = await reader.read();
      const firstText = new TextDecoder().decode(firstChunk.value);
      expect(firstText).toContain("event: connected");

      // Publish session end
      await new Promise((r) => setTimeout(r, 50));
      eventBus.publishSessionEnd(sessionCode, "Exam concluded by invigilator");

      // Read next chunk: must be session_ended
      const secondChunk = await reader.read();
      const secondText = new TextDecoder().decode(secondChunk.value);
      expect(secondText).toContain("event: session_ended");
      expect(secondText).toContain("Exam concluded by invigilator");

      // After session_ended, stream must be closed (done = true)
      const thirdChunk = await reader.read();
      expect(thirdChunk.done).toBe(true);
    }
  });
});
