import { streamSSE } from "hono/streaming";
import { verify } from "hono/jwt";
import { getJwtSecret } from "../../services/jwtKey";
import { eventBus } from "../../services/eventBus";
import { redisStore } from "../../services/classifier/redisStore";
import { sessions, sessionStates } from "../../services/sessionStore";

export async function streamSessionEvents(c: any) {
  const authHeader = c.req.header("Authorization");
  let token = "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else {
    token = c.req.query("token") || "";
  }

  if (!token) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  let sessionCode = "";
  let studentId = "";

  try {
    const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
    if (payload) {
      sessionCode = (payload.sessionCode || "").toUpperCase();
      studentId = (payload.studentId || "").toUpperCase();
    }
  } catch {
    return c.json({ error: "Invalid or expired session token" }, 401);
  }

  if (!sessionCode || !studentId) {
    return c.json({ error: "Token is missing sessionCode or studentId" }, 401);
  }

  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist or has ended" }, 404);
  }

  const currentTime = Math.floor(Date.now() / 1000);
  if (session.durationMinutes > 0) {
    const sessionEndTime = session.startTime + session.durationMinutes * 60;
    if (currentTime >= sessionEndTime) {
      return c.json({ error: "Session duration has expired" }, 403);
    }
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let initialLabel = "none";
    let initialConfidence = 0;
    let iScoreS: number | undefined;
    let eScoreS: number | undefined;

    try {
      const cached = await redisStore.getCachedClassification(token);
      if (cached && cached.label && cached.label !== "none") {
        initialLabel = cached.label;
        initialConfidence = cached.confidence || 0.8;
      }
    } catch {}

    if (initialLabel === "none" && sessionCode && studentId) {
      const stateKey = `${sessionCode}:${studentId}`;
      const state = sessionStates.get(stateKey) as any;
      if (
        state?.latestClassification &&
        state.latestClassification !== "none"
      ) {
        initialLabel = state.latestClassification;
        initialConfidence = 0.8;
        iScoreS = state.I_score_S;
        eScoreS = state.E_score_S;
      }
    }

    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        status: "connected",
        activeClassification: initialLabel,
        confidence: initialConfidence,
        iScoreS,
        eScoreS,
        sessionCode,
        studentId,
        timestamp: Date.now(),
      }),
    });

    const lastEventId =
      c.req.header("last-event-id") ||
      c.req.header("Last-Event-ID") ||
      c.req.query("lastEventId") ||
      "";

    let isAborted = false;
    const eventQueue: any[] = [];
    let notifyEvent: (() => void) | null = null;

    // Check if client reconnected and missed the latest event
    if (lastEventId && sessionCode && studentId) {
      try {
        const latestCached = await redisStore.getLatestEvent(
          sessionCode,
          studentId,
        );
        if (
          latestCached &&
          latestCached.id &&
          latestCached.id !== lastEventId
        ) {
          eventQueue.push(latestCached);
        }
      } catch {}
    }

    const unsubscribe = eventBus.subscribeIemUpdate(
      { sessionCode, studentId, token },
      (payload) => {
        eventQueue.push(payload);
        if (notifyEvent) {
          notifyEvent();
          notifyEvent = null;
        }
      },
    );

    const unsubEnd = eventBus.subscribeSessionEnd(sessionCode, (reason) => {
      eventQueue.push({ type: "session_ended", reason });
      if (notifyEvent) {
        notifyEvent();
        notifyEvent = null;
      }
    });

    stream.onAbort(() => {
      isAborted = true;
      unsubscribe();
      unsubEnd();
      if (notifyEvent) {
        notifyEvent();
        notifyEvent = null;
      }
    });

    try {
      while (!isAborted) {
        if (eventQueue.length === 0) {
          // Heartbeat interval with randomized jitter (25s - 35s) to avoid thundering herd
          const jitterMs = 25000 + Math.floor(Math.random() * 10000);
          await Promise.race([
            new Promise<void>((resolve) => {
              notifyEvent = resolve;
            }),
            stream.sleep(jitterMs),
          ]);
        }

        if (isAborted) break;

        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (!event) continue;

          if (event.type === "session_ended") {
            await stream.writeSSE({
              event: "session_ended",
              data: JSON.stringify({
                reason: event.reason || "Session ended",
                timestamp: Date.now(),
              }),
            });
            isAborted = true;
            break;
          }

          const eventId =
            event.id ||
            `${sessionCode}-${studentId}-${event.timestamp || Date.now()}`;
          await stream.writeSSE({
            id: eventId,
            event: "iem_update",
            data: JSON.stringify({
              id: eventId,
              conversationId: event.conversationId,
              label: event.label,
              confidence: event.confidence,
              iScoreS: event.iScoreS,
              eScoreS: event.eScoreS,
              iScoreSRaw: event.iScoreSRaw,
              eScoreSRaw: event.eScoreSRaw,
              iScoreTurn: event.iScoreTurn,
              eScoreTurn: event.eScoreTurn,
              windowSize: event.windowSize,
              featureSchema: event.featureSchema,
              timestamp: event.timestamp || Date.now(),
            }),
          });
        }

        if (isAborted) break;

        const activeSession = sessions.get(sessionCode);
        const tickTime = Math.floor(Date.now() / 1000);
        if (
          !activeSession ||
          (activeSession.durationMinutes > 0 &&
            tickTime >=
              activeSession.startTime + activeSession.durationMinutes * 60)
        ) {
          await stream.writeSSE({
            event: "session_ended",
            data: JSON.stringify({
              reason: "Session ended or expired",
              timestamp: tickTime,
            }),
          });
          isAborted = true;
          break;
        }

        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    } catch (streamErr) {
      // Client disconnected
    } finally {
      unsubscribe();
      unsubEnd();
    }
  });
}
