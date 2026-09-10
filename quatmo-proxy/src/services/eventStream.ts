import { Redis } from "ioredis";
import { redis } from "./redis";
import { EventEmitter } from "events";

export interface StudentEventPayload {
  type: string;
  sessionCode?: string;
  studentId?: string;
  timestamp: number;
  data?: any;
}

interface SseClient {
  id: string;
  studentId: string;
  sessionCode: string;
  send: (event: string, data: any) => Promise<void> | void;
  close: () => void;
}

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(10000);

const activeClients = new Map<string, SseClient>();
const studentClientMap = new Map<string, Set<string>>(); // studentId -> Set<clientId>
const sessionClientMap = new Map<string, Set<string>>(); // sessionCode -> Set<clientId>

let redisSub: Redis | null = null;
let isSubscribedToRedis = false;

function initRedisSubscriber() {
  if (isSubscribedToRedis) return;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    redisSub = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 3000,
      lazyConnect: false,
    });

    redisSub.on("connect", () => {
      console.log("[EventStream] Redis Subscriber connected successfully.");
      redisSub?.psubscribe(
        "events:student:*",
        "events:session:*",
        "events:admin",
        (err) => {
          if (err) {
            console.error("[EventStream] Redis psubscribe error:", err);
          } else {
            isSubscribedToRedis = true;
          }
        },
      );
    });

    redisSub.on("pmessage", (_pattern, channel, message) => {
      try {
        const parsed = JSON.parse(message);
        const eventName = parsed.event || "message";
        const payload = parsed.data || parsed;

        if (channel.startsWith("events:student:")) {
          const targetStudentId = channel
            .replace("events:student:", "")
            .toUpperCase();
          dispatchToLocalStudent(targetStudentId, eventName, payload);
        } else if (channel.startsWith("events:session:")) {
          const targetSessionCode = channel
            .replace("events:session:", "")
            .toUpperCase();
          dispatchToLocalSession(targetSessionCode, eventName, payload);
        }
      } catch (err) {
        console.error(
          "[EventStream] Error processing Redis Pub/Sub message:",
          err,
        );
      }
    });

    redisSub.on("error", (err) => {
      console.warn("[EventStream] Redis Subscriber error:", err.message);
    });
  } catch (err) {
    console.warn("[EventStream] Could not initialize Redis subscriber:", err);
  }
}

initRedisSubscriber();

function dispatchToLocalStudent(
  studentId: string,
  eventName: string,
  payload: any,
) {
  const sId = studentId.toUpperCase();
  const clientIds = studentClientMap.get(sId);
  if (!clientIds || clientIds.size === 0) return;

  for (const clientId of clientIds) {
    const client = activeClients.get(clientId);
    if (client) {
      try {
        client.send(eventName, payload);
      } catch (e) {}
    }
  }
}

function dispatchToLocalSession(
  sessionCode: string,
  eventName: string,
  payload: any,
) {
  const sCode = sessionCode.toUpperCase();
  const clientIds = sessionClientMap.get(sCode);
  if (!clientIds || clientIds.size === 0) return;

  for (const clientId of clientIds) {
    const client = activeClients.get(clientId);
    if (client) {
      try {
        client.send(eventName, payload);
      } catch (e) {}
    }
  }
}

/**
 * Broadcast an event directly to a specific student across all proxy cluster instances.
 */
export async function broadcastStudentEvent(
  sessionCode: string,
  studentId: string,
  eventName: string,
  data: any,
): Promise<void> {
  const sCode = (sessionCode || "DEFAULT").toUpperCase();
  const sId = (studentId || "DEFAULT_USER").toUpperCase();
  const payload = {
    event: eventName,
    sessionCode: sCode,
    studentId: sId,
    timestamp: Date.now(),
    data,
  };

  dispatchToLocalStudent(sId, eventName, payload);

  if (redis && redis.status === "ready") {
    try {
      await redis.publish(`events:student:${sId}`, JSON.stringify(payload));
    } catch (err) {
      console.error("[EventStream] Redis publish student event failed:", err);
    }
  }
}

/**
 * Broadcast an event to all students in a session across all cluster instances.
 */
export async function broadcastSessionEvent(
  sessionCode: string,
  eventName: string,
  data: any,
): Promise<void> {
  const sCode = (sessionCode || "DEFAULT").toUpperCase();
  const payload = {
    event: eventName,
    sessionCode: sCode,
    timestamp: Date.now(),
    data,
  };

  dispatchToLocalSession(sCode, eventName, payload);

  if (redis && redis.status === "ready") {
    try {
      await redis.publish(`events:session:${sCode}`, JSON.stringify(payload));
    } catch (err) {
      console.error("[EventStream] Redis publish session event failed:", err);
    }
  }
}

/**
 * Registers an active SSE client connection.
 */
export function registerSseClient(
  studentId: string,
  sessionCode: string,
  sendFn: (event: string, data: any) => Promise<void> | void,
  closeFn: () => void,
): { clientId: string; unregister: () => void } {
  const clientId = `sse_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const sId = (studentId || "DEFAULT_USER").toUpperCase();
  const sCode = (sessionCode || "DEFAULT").toUpperCase();

  const client: SseClient = {
    id: clientId,
    studentId: sId,
    sessionCode: sCode,
    send: sendFn,
    close: closeFn,
  };

  activeClients.set(clientId, client);

  if (!studentClientMap.has(sId)) {
    studentClientMap.set(sId, new Set());
  }
  studentClientMap.get(sId)!.add(clientId);

  if (!sessionClientMap.has(sCode)) {
    sessionClientMap.set(sCode, new Set());
  }
  sessionClientMap.get(sCode)!.add(clientId);

  console.log(
    `[EventStream] Registered SSE Client ${clientId} for student ${sId} in session ${sCode} (Total active: ${activeClients.size})`,
  );

  const unregister = () => {
    activeClients.delete(clientId);
    const sSet = studentClientMap.get(sId);
    if (sSet) {
      sSet.delete(clientId);
      if (sSet.size === 0) studentClientMap.delete(sId);
    }
    const sessSet = sessionClientMap.get(sCode);
    if (sessSet) {
      sessSet.delete(clientId);
      if (sessSet.size === 0) sessionClientMap.delete(sCode);
    }
    console.log(
      `[EventStream] Unregistered SSE Client ${clientId} for ${sId} (Remaining: ${activeClients.size})`,
    );
  };

  return { clientId, unregister };
}

export function getActiveSseClientCount(): number {
  return activeClients.size;
}
