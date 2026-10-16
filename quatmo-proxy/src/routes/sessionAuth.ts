import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sign, verify } from "hono/jwt";
import { redis } from "../services/redis";
import { getJwtSecret } from "../services/jwtKey";
import { eventBus } from "../services/eventBus";
import { redisStore } from "../services/classifier/redisStore";

declare const Bun: any;
import {
  studentAccounts,
  sessions,
  sessionStates,
  studentGroups,
  getStudentAccount,
  getStudentGroup,
  type StudentSessionState,
  verifyPasswordSafely,
} from "../services/sessionStore";
import {
  checkLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
} from "../services/rateLimiter";
import { s3Storage } from "../services/s3Storage";
import { getClientIP } from "./admin";
import { clientVersionGate } from "../middleware/clientVersionGate";
import { evaluateClient, readClientIdentity } from "../services/clientGate";
import { normalizeUploadRelPath, resolveInside } from "../services/security";

const MAX_UPLOAD_FILES = parseInt(process.env.MAX_UPLOAD_FILES || "5000", 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(100 * 1024 * 1024), 10);

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

const sessionAuthRouter = new Hono();

sessionAuthRouter.get("/events/stream", async (c) => {
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
              iScoreTurn: event.iScoreTurn,
              eScoreTurn: event.eScoreTurn,
              windowSize: event.windowSize,
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
});

sessionAuthRouter.get("/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const jwtSecret = getJwtSecret();
  let payload: any;
  try {
    payload = await verify(token, jwtSecret, "HS256" as any);
  } catch (err) {
    return c.json({ error: "Invalid or expired token." }, 401);
  }

  const { studentId, sessionCode } = payload;
  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);
  if (!state) {
    return c.json({ error: "Student session state not found." }, 404);
  }

  let consumed = state.tokensConsumed;
  if (redis && redis.status === "ready") {
    try {
      const val = await redis.hget(
        `session:user:${sessionCode}:${studentId}`,
        "consumed",
      );
      if (val !== null) {
        consumed = parseInt(val, 10);
      }
    } catch {
      // fallback
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime =
    session.durationMinutes === -1
      ? session.startTime + 24 * 60 * 60
      : session.startTime + session.durationMinutes * 60;
  const aiExpirationTime =
    session.aiValidityMinutes === -1
      ? payload.loginTime + 24 * 60 * 60
      : payload.loginTime + session.aiValidityMinutes * 60;
  const sessionRemainingSeconds = Math.max(0, sessionEndTime - now);
  const aiRemainingSeconds = Math.max(0, aiExpirationTime - now);

  return c.json({
    success: true,
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    tokenBudget: session.defaultTokenBudget,
    tokensConsumed: consumed,
    tokensRemaining: Math.max(0, session.defaultTokenBudget - consumed),
    sessionRemainingMinutes:
      session.durationMinutes === -1
        ? -1
        : Math.ceil(sessionRemainingSeconds / 60),
    aiRemainingMinutes:
      session.aiValidityMinutes === -1
        ? -1
        : Math.ceil(aiRemainingSeconds / 60),
    runtimeConfig: session.runtimeConfig,
  });
});

sessionAuthRouter.post("/login", clientVersionGate(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let {
    sessionCode: rawSessionCode,
    studentId: rawStudentId,
    password,
  } = body as {
    sessionCode?: string;
    studentId?: string;
    password?: string;
  };

  const authHeader = c.req.header("Authorization");
  let bearerStudentId: string | undefined;
  let bearerCreatedBy: string | undefined;
  let bearerValidLecturers: string[] | undefined;
  let bearerIat: number | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    try {
      const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
      if (payload && payload.studentId) {
        bearerStudentId = payload.studentId;
        bearerCreatedBy = payload.createdBy;
        bearerIat = payload.iat;
        if (Array.isArray(payload.validLecturers)) {
          bearerValidLecturers = payload.validLecturers.map((l: string) =>
            String(l).toLowerCase(),
          );
        } else if (payload.createdBy) {
          bearerValidLecturers = [String(payload.createdBy).toLowerCase()];
        }
      }
    } catch {
      // Invalid Bearer token
    }
  }

  const studentId = (rawStudentId || bearerStudentId || "")
    .trim()
    .toUpperCase();
  const sessionCode = (rawSessionCode || "").trim().toUpperCase();

  if (!sessionCode) {
    return c.json({ error: "Missing required field: sessionCode" }, 400);
  }

  if (!studentId) {
    return c.json(
      {
        error:
          "Missing Student ID. Please log in with your FPT Student Account first.",
      },
      400,
    );
  }

  const ip = getClientIP(c);

  const lockout = await checkLockout(ip, studentId);
  if (lockout.isLocked) {
    c.header("Retry-After", String(lockout.remainingSeconds));
    c.header("X-RateLimit-Reset", String(lockout.lockedUntil));
    return c.json(
      {
        error: `Too many failed login attempts. Account/IP temporarily locked for security.`,
        retryAfterSeconds: lockout.remainingSeconds,
        lockedUntil: lockout.lockedUntil,
        reason: lockout.reason,
      },
      429,
    );
  }

  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const existingState = sessionStates.get(stateKey);

  const isDirectlyAllowed = session.allowedStudentIds.has(studentId);
  let isGroupAllowed = false;

  if (
    !isDirectlyAllowed &&
    Array.isArray(session.assignedGroups) &&
    session.assignedGroups.length > 0
  ) {
    for (const groupName of session.assignedGroups) {
      const g = getStudentGroup(groupName, session.createdBy);
      if (g && Array.isArray(g.userIds)) {
        if (g.userIds.some((uid) => uid.trim().toUpperCase() === studentId)) {
          isGroupAllowed = true;
          session.allowedStudentIds.add(studentId);
          sessions.set(sessionCode, session);
          break;
        }
      }
    }
  }

  if (!isDirectlyAllowed && !isGroupAllowed && !existingState) {
    return c.json(
      {
        error:
          "You are not allowed to join this session. Please contact your instructor for assistance.",
      },
      403,
    );
  }

  if (!session.allowedStudentIds.has(studentId) && existingState) {
    session.allowedStudentIds.add(studentId);
    sessions.set(sessionCode, session);
  }

  const sessionCreator = (session.createdBy || "admin").toLowerCase();
  const mapKey = `${studentId}:${sessionCreator}`;
  const creatorAccount = studentAccounts.get(mapKey);
  const adminAccount = studentAccounts.get(`${studentId}:admin`);
  const account =
    creatorAccount ||
    (sessionCreator === "admin" ? adminAccount : undefined) ||
    getStudentAccount(studentId, sessionCreator);

  if (!account) {
    return c.json(
      {
        error: `Student account for ${studentId} does not exist under instructor @${session.createdBy || "admin"}.`,
      },
      403,
    );
  }

  if (account.isDeleted) {
    return c.json(
      {
        error: `Student account for ${studentId} has been deactivated.`,
      },
      403,
    );
  }

  let bearerAuthenticated = false;
  if (bearerStudentId && bearerStudentId.trim().toUpperCase() === studentId) {
    const isPasswordStillFresh =
      !account.updatedAt ||
      (bearerIat ? (bearerIat + 2) * 1000 >= account.updatedAt : true);

    if (isPasswordStillFresh) {
      if (bearerValidLecturers && Array.isArray(bearerValidLecturers)) {
        const isDirectMatch = bearerValidLecturers.includes(sessionCreator);
        const isSuperAdminSession = sessionCreator === "admin";
        const hasAdminAuth = bearerValidLecturers.includes("admin");
        if (
          isDirectMatch ||
          (isSuperAdminSession && hasAdminAuth) ||
          hasAdminAuth
        ) {
          bearerAuthenticated = true;
        }
      } else if (bearerCreatedBy) {
        if (
          bearerCreatedBy.toLowerCase() === sessionCreator ||
          bearerCreatedBy.toLowerCase() === "admin"
        ) {
          bearerAuthenticated = true;
        }
      }
    }
  }

  if (!bearerAuthenticated) {
    if (!password) {
      return c.json(
        {
          error: `This session was created by instructor @${session.createdBy || "admin"}. Please log in with the password provided by @${session.createdBy || "admin"}.`,
          requirePassword: true,
        },
        403,
      );
    }

    let isPasswordValid = false;
    if (creatorAccount) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        creatorAccount.passwordHash,
      );
    }
    if (!isPasswordValid && adminAccount) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        adminAccount.passwordHash,
      );
    }
    if (!isPasswordValid && account) {
      isPasswordValid = await verifyPasswordSafely(
        password,
        account.passwordHash,
      );
    }

    if (!isPasswordValid) {
      const result = await recordFailedAttempt(ip, studentId);
      if (result.isNowLocked && result.lockoutInfo) {
        c.header("Retry-After", String(result.lockoutInfo.remainingSeconds));
        c.header("X-RateLimit-Reset", String(result.lockoutInfo.lockedUntil));
        return c.json(
          {
            error: `Too many failed login attempts. Account/IP temporarily locked for 15 minutes.`,
            retryAfterSeconds: result.lockoutInfo.remainingSeconds,
            lockedUntil: result.lockoutInfo.lockedUntil,
            reason: result.lockoutInfo.reason,
          },
          429,
        );
      }
      return c.json(
        {
          error: `Password is incorrect for instructor @${session.createdBy || "admin"}. (Failed attempts: ${result.attemptsCount}/10)`,
          failedAttempts: result.attemptsCount,
          remainingAttempts: Math.max(0, 10 - result.attemptsCount),
        },
        403,
      );
    }
  }

  await recordSuccessfulLogin(ip, studentId);

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime =
    session.durationMinutes === -1
      ? session.startTime + 24 * 60 * 60
      : session.startTime + session.durationMinutes * 60;
  const remainingSeconds = sessionEndTime - now;

  if (remainingSeconds <= 0) {
    return c.json({ error: "Session has ended." }, 403);
  }

  let state = existingState;
  if (!state) {
    state = {
      sessionCode,
      studentId,
      hasLoggedIn: false,
      loginTimestamp: 0,
      tokensConsumed: 0,
      reassigned: false,
    };
    sessionStates.set(stateKey, state);
  }

  const wasReassigned = Boolean(state.reassigned);
  if (state.hasLoggedIn && !state.reassigned) {
    return c.json(
      {
        error:
          "Your account is currently logged in on another device. Please contact your instructor or system administrator to reset.",
      },
      403,
    );
  }

  state.hasLoggedIn = true;
  if (!state.loginTimestamp || state.loginTimestamp === 0) {
    state.loginTimestamp = now;
  }
  state.reassigned = false;

  if (redis && redis.status === "ready") {
    try {
      const pattern = `session:user:*:${studentId}`;
      const oldKeys = await redis.keys(pattern);
      const keysToDelete = oldKeys.filter(
        (k) => !k.includes(`:${sessionCode}:${studentId}`),
      );
      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
    } catch (err) {
      console.warn(
        "[Auth] Failed to clean up stale Redis session keys on switch:",
        err,
      );
    }

    try {
      const redisKey = `session:user:${sessionCode}:${studentId}`;
      await redis.hset(redisKey, {
        budget: String(session.defaultTokenBudget),
        consumed: String(state.tokensConsumed),
        loginTime: String(state.loginTimestamp),
      });
      await redis.expire(redisKey, remainingSeconds);
    } catch (err) {
      console.error(
        `[Auth] Failed to set Redis session for student ${studentId}:`,
        err,
      );
      return c.json(
        { error: "Failed to connect to RAM database (Redis)." },
        500,
      );
    }
  } else {
    console.warn(
      "[Auth] Redis is offline. Running session check from RAM only.",
    );
  }

  const jwtSecret = getJwtSecret();
  const payload = {
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    promptMode: session.promptMode || "scaffolded_code",
    aiValidityMinutes: session.aiValidityMinutes,
    loginTime: state.loginTimestamp,
    sessionEndTime,
    exp: sessionEndTime,
    // cgv = client-gate-verified: this token was issued to a client that passed
    // the version/checksum gate, so chat requests with it are not re-checked.
    ...(evaluateClient(readClientIdentity((n) => c.req.header(n))).status === "ok"
      ? { cgv: 1 }
      : {}),
  };

  const token = await sign(payload, jwtSecret);

  return c.json({
    success: true,
    token,
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    promptMode: session.promptMode || "scaffolded_code",
    runtimeConfig: session.runtimeConfig,
    isReassigned: wasReassigned,
    reassigned: wasReassigned,
  });
});

async function verifyTokenSignatureOnly(token: string, secretStr: string): Promise<any | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretStr),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Buffer.from(sigB64, "base64url");
    const data = new TextEncoder().encode(headerB64 + "." + payloadB64);
    const isValid = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!isValid) return null;
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

interface JsonlRecord {
  timestamp: number;
  type?: string;
  payload?: any;
  groupId?: number;
  [key: string]: any;
}

function mergeJsonlBuffers(existingBuf: Buffer, newBuf: Buffer): Buffer {
  const existingStr = existingBuf.toString("utf-8");
  const newStr = newBuf.toString("utf-8");
  const existingLines = existingStr.split("\n").filter((l) => l.trim().length > 0);
  const newLines = newStr.split("\n").filter((l) => l.trim().length > 0);

  const parsedRecords: Array<{ record: JsonlRecord; raw?: string; isRaw: boolean }> = [];
  const seenFingerprints = new Set<string>();

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as JsonlRecord;
      if (typeof obj === "object" && obj !== null && typeof obj.timestamp === "number") {
        // Construct semantic fingerprint ignoring transient groupId counter
        const fp = `${obj.type || ""}_${obj.timestamp}_${JSON.stringify(obj.payload ?? "")}`;
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          parsedRecords.push({ record: obj, isRaw: false });
        }
        return;
      }
    } catch {
      // JSON parse failed; fall back to raw string preservation
    }

    if (!seenFingerprints.has(trimmed)) {
      seenFingerprints.add(trimmed);
      parsedRecords.push({
        record: { timestamp: 0 },
        raw: trimmed,
        isRaw: true,
      });
    }
  };

  for (const l of existingLines) {
    processLine(l);
  }
  for (const l of newLines) {
    processLine(l);
  }

  // Strictly sort chronologically by timestamp ascending
  parsedRecords.sort((a, b) => {
    if (a.isRaw && !b.isRaw) return -1;
    if (!a.isRaw && b.isRaw) return 1;
    return a.record.timestamp - b.record.timestamp;
  });

  // Re-index groupId monotonically across the unified timeline (0, 1, 2, ...)
  let currentGroupId = 0;
  const mergedLines: string[] = [];

  for (const item of parsedRecords) {
    if (item.isRaw && item.raw) {
      mergedLines.push(item.raw);
    } else {
      item.record.groupId = currentGroupId++;
      mergedLines.push(JSON.stringify(item.record));
    }
  }

  return Buffer.from(mergedLines.join("\n") + "\n", "utf-8");
}

function mergeMetadataBuffers(existingBuf: Buffer, newBuf: Buffer): Buffer {
  try {
    const existingMeta = JSON.parse(existingBuf.toString("utf-8"));
    const newMeta = JSON.parse(newBuf.toString("utf-8"));

    const merged = {
      ...existingMeta,
      ...newMeta,
      // Preserve earliest exam start time across all machines
      examStartAt: Math.min(
        Number(existingMeta.examStartAt) || Date.now(),
        Number(newMeta.examStartAt) || Date.now()
      ),
      // Set to latest end time if present
      examEndAt: Math.max(
        Number(existingMeta.examEndAt) || 0,
        Number(newMeta.examEndAt) || 0
      ) || undefined,
      conversations: [
        ...(Array.isArray(existingMeta.conversations) ? existingMeta.conversations : []),
        ...(Array.isArray(newMeta.conversations) ? newMeta.conversations : []),
      ],
    };

    if (Array.isArray(merged.conversations)) {
      const seenConv = new Set<string>();
      merged.conversations = merged.conversations.filter((c: any) => {
        const id = c?.id || c?.conversationId || JSON.stringify(c);
        if (seenConv.has(id)) return false;
        seenConv.add(id);
        return true;
      });
    }

    return Buffer.from(JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    return newBuf;
  }
}


sessionAuthRouter.post("/upload-logs", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  let tokenPayload: any;
  try {
    tokenPayload = await verify(token, getJwtSecret(), "HS256" as any);
  } catch {
    // If standard verification fails (e.g. token expired because session ended),
    // verify the cryptographic signature directly to permit valid students to submit their logs.
    tokenPayload = await verifyTokenSignatureOnly(token, getJwtSecret());
    if (!tokenPayload) {
      return c.json({ error: "Token expired or invalid" }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenExp = Number(tokenPayload.exp || tokenPayload.sessionEndTime || 0);
    const maxGraceSeconds = 14 * 24 * 3600; // 14-day upload grace window
    if (tokenExp > 0 && now > tokenExp + maxGraceSeconds) {
      return c.json({ error: "Log upload grace period (14 days) has expired" }, 401);
    }
  }

  // Identity comes ONLY from the verified session token. Body fields are accepted
  // for backward compatibility but must match the token.
  const tokenSessionCode = String(tokenPayload?.sessionCode || "").trim().toUpperCase();
  const tokenStudentId = String(tokenPayload?.studentId || "").trim().toUpperCase();
  if (!tokenSessionCode || !tokenStudentId) {
    return c.json({ error: "A session token is required to upload logs." }, 403);
  }

  let sessionCode = "";
  let studentId = "";
  let uploadReason = "";
  interface ParsedUploadFile {
    relativePath: string;
    buffer: Buffer;
  }
  const uploadFiles: ParsedUploadFile[] = [];

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Failed to parse multipart form data" }, 400);
    }
    sessionCode = String(
      formData.get("sessionCode") || tokenPayload.sessionCode || "",
    )
      .trim()
      .toUpperCase();
    studentId = String(
      formData.get("studentId") || tokenPayload.studentId || "",
    )
      .trim()
      .toUpperCase();
    uploadReason = String(formData.get("uploadReason") || "").trim();

    // Parse path mapping if provided as JSON array
    let explicitPaths: string[] = [];
    const pathsRaw = formData.get("filePaths");
    if (typeof pathsRaw === "string") {
      try {
        explicitPaths = JSON.parse(pathsRaw);
      } catch {
        /* ignore */
      }
    }

    const fileEntries = formData.getAll("files");
    for (let i = 0; i < fileEntries.length; i++) {
      const entry = fileEntries[i];
      if (entry && typeof (entry as any).arrayBuffer === "function") {
        const fileObj = entry as File;
        const relPath = explicitPaths[i] || fileObj.name;
        if (relPath) {
          const ab = await fileObj.arrayBuffer();
          uploadFiles.push({
            relativePath: relPath,
            buffer: Buffer.from(ab),
          });
        }
      }
    }
  } else {
    // Fallback: Legacy JSON payload
    const body = await c.req.json().catch(() => ({}));
    sessionCode = String(body.sessionCode || tokenPayload.sessionCode || "")
      .trim()
      .toUpperCase();
    studentId = String(body.studentId || tokenPayload.studentId || "")
      .trim()
      .toUpperCase();
    uploadReason = String(body.uploadReason || "").trim();

    const rawFiles: Array<{
      relativePath: string;
      content: string;
      encoding?: string;
    }> = body.files || [];
    for (const f of rawFiles) {
      if (f && f.relativePath && f.content !== undefined) {
        uploadFiles.push({
          relativePath: f.relativePath,
          buffer:
            f.encoding === "base64"
              ? Buffer.from(f.content, "base64")
              : Buffer.from(f.content, "utf-8"),
        });
      }
    }
  }

  sessionCode = sessionCode || tokenSessionCode;
  studentId = studentId || tokenStudentId;
  if (sessionCode !== tokenSessionCode || studentId !== tokenStudentId) {
    return c.json({ error: "sessionCode/studentId do not match your session token." }, 403);
  }

  if (uploadFiles.length > MAX_UPLOAD_FILES) {
    return c.json({ error: `Too many files (max ${MAX_UPLOAD_FILES}).` }, 413);
  }
  // Drop (instead of rejecting the whole submission) entries whose path is absolute,
  // contains "..", or would overwrite the server-generated upload_info.json. The rest
  // of the student's work is still stored, and nothing can escape the student folder.
  let totalBytes = 0;
  let droppedFiles = 0;
  for (let i = uploadFiles.length - 1; i >= 0; i--) {
    const f = uploadFiles[i];
    const normalized = normalizeUploadRelPath(f.relativePath);
    if (!normalized || normalized.toLowerCase() === "upload_info.json") {
      uploadFiles.splice(i, 1);
      droppedFiles++;
      continue;
    }
    f.relativePath = normalized;
    totalBytes += f.buffer.length;
  }
  if (droppedFiles > 0) {
    console.warn(
      `[SessionAuth] upload-logs ${sessionCode}/${studentId}: dropped ${droppedFiles} file(s) with unsafe paths`,
    );
    if (uploadFiles.length === 0) {
      return c.json({ error: "Invalid file path." }, 400);
    }
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return c.json({ error: `Upload too large (max ${MAX_UPLOAD_BYTES} bytes).` }, 413);
  }

  const targetDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sanitizeFilename(sessionCode),
    sanitizeFilename(studentId),
  );

  await fs.promises.mkdir(targetDir, { recursive: true });

  // 1. Asynchronous concurrent local disk writes with JSONL merge support (preserves historical logs across reassignments)
  await Promise.all(
    uploadFiles.map(async (file) => {
      const destPath = resolveInside(targetDir, file.relativePath);
      if (!destPath) return;
      const destDir = path.dirname(destPath);
      await fs.promises.mkdir(destDir, { recursive: true });

      // Preserve baseline initial snapshot: never overwrite start snapshot from machine 1
      if (file.relativePath.endsWith("snapshot_start.zip") && fs.existsSync(destPath)) {
        return;
      }

      if (
        (file.relativePath.endsWith("events.jsonl") ||
          file.relativePath.endsWith("ai_interactions.jsonl")) &&
        fs.existsSync(destPath)
      ) {
        try {
          const existingBuf = await fs.promises.readFile(destPath);
          file.buffer = mergeJsonlBuffers(existingBuf, file.buffer);
        } catch (err) {
          console.warn(`[Logs] Failed to merge existing ${file.relativePath}:`, err);
        }
      } else if (file.relativePath.endsWith("metadata.json") && fs.existsSync(destPath)) {
        try {
          const existingBuf = await fs.promises.readFile(destPath);
          file.buffer = mergeMetadataBuffers(existingBuf, file.buffer);
        } catch (err) {
          console.warn(`[Logs] Failed to merge existing metadata.json:`, err);
        }
      }

      await fs.promises.writeFile(destPath, file.buffer);
    }),
  );

  const savedCount = uploadFiles.length;
  const metaPath = path.join(targetDir, "upload_info.json");
  const metaData = {
    studentId,
    sessionCode,
    uploadReason: uploadReason || undefined,
    uploadTimestamp: Math.floor(Date.now() / 1000),
    uploadTimeISO: new Date().toISOString(),
    filesUploaded: savedCount,
    ip: c.req.header("x-forwarded-for") || "local",
  };
  await fs.promises.writeFile(
    metaPath,
    JSON.stringify(metaData, null, 2),
    "utf-8",
  );

  console.log(
    `[Logs] Uploaded ${savedCount} monitoring log file(s) for student ${studentId} in session ${sessionCode}`,
  );

  // 2. High-throughput parallel S3 upload with connection pooling
  if (s3Storage.isAvailable()) {
    try {
      // Clean previous exam records for this student in this session
      await s3Storage.purgeStudentExamRecords(sessionCode, studentId);

      // Upload all files concurrently
      const s3UploadPromises = uploadFiles.map((file) => {
        return s3Storage.uploadStudentFile(
          sessionCode,
          studentId,
          file.relativePath,
          file.buffer,
        );
      });

      s3UploadPromises.push(
        s3Storage.uploadStudentFile(
          sessionCode,
          studentId,
          "upload_info.json",
          JSON.stringify(metaData, null, 2),
          "application/json",
        ),
      );

      await Promise.all(s3UploadPromises);
      console.log(
        `[S3 Storage] High-throughput parallel synced ${savedCount} log file(s) for student ${studentId} in session ${sessionCode} to S3`,
      );
    } catch (s3Err) {
      console.error(
        `[S3 Storage] Failed to sync uploaded logs to S3 for ${sessionCode}/${studentId}:`,
        s3Err,
      );
    }
  }

  return c.json({
    success: true,
    message: `Successfully uploaded ${savedCount} monitoring log file(s).`,
    sessionCode,
    studentId,
    savedCount,
  });
});

export { sessionAuthRouter };
