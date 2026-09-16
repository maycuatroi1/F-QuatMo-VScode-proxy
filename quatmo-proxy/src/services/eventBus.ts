import { EventEmitter } from "events";
import { redis } from "./redis";
import type { Redis } from "ioredis";

import { redisStore } from "./classifier/redisStore";

export interface IemUpdateEventPayload {
  id?: string;
  token?: string;
  sessionCode: string;
  studentId: string;
  conversationId?: string;
  label: string; // overallLabel
  currentLabel?: string; // single-turn label
  overallLabel?: string; // top-5 sliding window label
  confidence: number;
  iScoreS?: number;
  eScoreS?: number;
  iScoreTurn?: number;
  eScoreTurn?: number;
  windowSize?: number;
  timestamp?: number;
}

const REDIS_CHANNEL_IEM_UPDATES = "fedu:iem:updates";
const REDIS_CHANNEL_SESSION_PATTERN = "fedu:iem:session:*";
const REDIS_CHANNEL_SESSION_END_PATTERN = "fedu:session:end:*";

class EventBus {
  private emitter = new EventEmitter();
  private redisSub: Redis | null = null;
  private isRedisSubReady = false;

  constructor() {
    this.emitter.setMaxListeners(5000);
    this.initRedisSub();
  }

  private initRedisSub() {
    if (!redis) return;

    try {
      this.redisSub = redis.duplicate();
      this.redisSub.subscribe(REDIS_CHANNEL_IEM_UPDATES, (err) => {
        if (!err) {
          this.isRedisSubReady = true;
          console.log(
            `[EventBus] Subscribed to Redis Pub/Sub channel '${REDIS_CHANNEL_IEM_UPDATES}'.`,
          );
        }
      });

      this.redisSub.psubscribe(REDIS_CHANNEL_SESSION_PATTERN, (err) => {
        if (!err) {
          console.log(
            `[EventBus] Subscribed to Redis partitioned pattern '${REDIS_CHANNEL_SESSION_PATTERN}'.`,
          );
        }
      });

      this.redisSub.psubscribe(REDIS_CHANNEL_SESSION_END_PATTERN, (err) => {
        if (!err) {
          console.log(
            `[EventBus] Subscribed to Redis session end pattern '${REDIS_CHANNEL_SESSION_END_PATTERN}'.`,
          );
        }
      });

      this.redisSub.on("message", (channel, message) => {
        if (channel === REDIS_CHANNEL_IEM_UPDATES) {
          try {
            const payload: IemUpdateEventPayload = JSON.parse(message);
            this.dispatchLocal(payload, false);
          } catch (e) {
            console.error("[EventBus] Failed to parse Redis message:", e);
          }
        }
      });

      this.redisSub.on("pmessage", (pattern, channel, message) => {
        try {
          if (pattern === REDIS_CHANNEL_SESSION_END_PATTERN) {
            const data = JSON.parse(message);
            const sCode = (data.sessionCode || "").toUpperCase();
            this.emitter.emit(`session:end:${sCode}`, data.reason || "Session ended");
            return;
          }
          const payload: IemUpdateEventPayload = JSON.parse(message);
          this.dispatchLocal(payload, false);
        } catch (e) {
          console.error("[EventBus] Failed to parse Redis pmessage:", e);
        }
      });

      this.redisSub.on("error", () => {
        // Silently handle error, local EventEmitter remains fallback
      });
    } catch {}
  }

  private dispatchLocal(payload: IemUpdateEventPayload, isOriginLocal = true) {
    const sCode = (payload.sessionCode || "").toUpperCase();
    const sId = (payload.studentId || "").toUpperCase();

    if (sCode && sId) {
      this.emitter.emit(`iem:${sCode}:${sId}`, payload);
    }

    if (payload.token) {
      this.emitter.emit(`iem:token:${payload.token}`, payload);
    }

    this.emitter.emit("iem:all", payload);

    if (isOriginLocal) {
      const safeOverall = (payload.overallLabel || payload.label || "unknown").toUpperCase();
      const safeCurrent = (payload.currentLabel || safeOverall).toUpperCase();
      const safeConf = (payload.confidence ?? 0).toFixed(2);
      console.log(
        `[EventBus] Dispatched IEM update for ${sId} in ${sCode} -> currentLabel: ${safeCurrent} | overallLabel (top5): ${safeOverall} (${safeConf})`,
      );
    }
  }

  public async publishIemUpdate(payload: IemUpdateEventPayload): Promise<void> {
    const sCode = (payload.sessionCode || "").toUpperCase();
    const sId = (payload.studentId || "").toUpperCase();
    payload.id = payload.id || `${sCode}-${sId}-${Date.now()}`;
    payload.timestamp = payload.timestamp || Date.now();

    this.dispatchLocal(payload, true);

    // Cache latest event for instant Last-Event-ID replay
    await redisStore.cacheLatestEvent(sCode, sId, payload).catch(() => {});

    if (redis && redis.status === "ready") {
      try {
        const payloadStr = JSON.stringify(payload);
        const sessionChannel = `fedu:iem:session:${sCode}`;
        await redis.publish(sessionChannel, payloadStr);
        await redis.publish(REDIS_CHANNEL_IEM_UPDATES, payloadStr);
      } catch (err: any) {
        console.warn(
          "[EventBus] Failed to publish IEM update to Redis:",
          err.message,
        );
      }
    }
  }

  public subscribeIemUpdate(
    identifier: { sessionCode?: string; studentId?: string; token?: string },
    callback: (payload: IemUpdateEventPayload) => void,
  ): () => void {
    const sCode = (identifier.sessionCode || "").toUpperCase();
    const sId = (identifier.studentId || "").toUpperCase();
    const token = identifier.token;

    const eventNames: string[] = [];

    if (sCode && sId) {
      eventNames.push(`iem:${sCode}:${sId}`);
    }
    if (token) {
      eventNames.push(`iem:token:${token}`);
    }
    if (eventNames.length === 0) {
      eventNames.push("iem:all");
    }

    for (const name of eventNames) {
      this.emitter.on(name, callback);
    }

    return () => {
      for (const name of eventNames) {
        this.emitter.off(name, callback);
      }
    };
  }

  public publishSessionEnd(sessionCode: string, reason = "Session ended"): void {
    const sCode = sessionCode.toUpperCase();
    this.emitter.emit(`session:end:${sCode}`, reason);
    if (redis && redis.status === "ready") {
      redis
        .publish(
          `fedu:session:end:${sCode}`,
          JSON.stringify({ sessionCode: sCode, reason }),
        )
        .catch(() => {});
    }
  }

  public subscribeSessionEnd(
    sessionCode: string,
    callback: (reason: string) => void,
  ): () => void {
    const sCode = sessionCode.toUpperCase();
    const eventName = `session:end:${sCode}`;
    this.emitter.on(eventName, callback);
    return () => {
      this.emitter.off(eventName, callback);
    };
  }
}

export const eventBus = new EventBus();
