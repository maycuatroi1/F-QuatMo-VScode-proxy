import { redis } from "../redis";

export interface TurnLog {
  timestamp: number;
  prompt: string;
  response: string;
  codeSnapshot?: string;
  terminalOutput?: string;
  lastTerminalCommand?: string;
  I_score: number;
  E_score: number;
  featureVector?: Record<string, number>;
}

export interface ClientContext {
  activeFile?: {
    path: string;
    content: string;
    languageId: string;
  };
  files?: Array<{
    path: string;
    content: string;
    languageId: string;
  }>;
  recentPaste?: {
    text: string;
    timestamp: number;
  };
  recentTerminal?: {
    output: string;
    lastCommand?: string;
    exitCode?: number;
    timestamp: number;
  };
}

const localClientContexts = new Map<string, ClientContext>();
const localTurns = new Map<string, TurnLog[]>();
const localLatestClassifications = new Map<
  string,
  { label: string; confidence: number }
>();

const CLIENT_CONTEXT_TTL_SEC = 120;
const TURNS_TTL_SEC = 18000;
const LATEST_CLASS_TTL_SEC = 300;
const EVAL_PENDING_TTL_SEC = parseInt(
  process.env.EVAL_PENDING_TTL_SEC || "120",
  10,
);

export const redisStore = {
  async saveClientContext(
    sessionCode: string,
    studentId: string,
    context: Partial<ClientContext>,
  ): Promise<void> {
    const key = `session:client-context:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    const existing = await this.getClientContext(sessionCode, studentId);
    const merged: ClientContext = {
      activeFile: context.activeFile ?? existing?.activeFile,
      files: context.files ?? existing?.files,
      recentPaste: context.recentPaste ?? existing?.recentPaste,
      recentTerminal: context.recentTerminal ?? existing?.recentTerminal,
    };
    if (redis && redis.status === "ready") {
      try {
        await redis.set(
          key,
          JSON.stringify(merged),
          "EX",
          CLIENT_CONTEXT_TTL_SEC,
        );
      } catch (err) {
        console.error("[Classifier Redis] Failed to save client context:", err);
      }
    } else {
      localClientContexts.set(key, merged);
      setTimeout(
        () => localClientContexts.delete(key),
        CLIENT_CONTEXT_TTL_SEC * 1000,
      );
    }
  },

  async getClientContext(
    sessionCode: string,
    studentId: string,
  ): Promise<ClientContext | null> {
    const key = `session:client-context:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        const val = await redis.get(key);
        if (val) {
          return JSON.parse(val);
        }
      } catch (err) {
        console.error("[Classifier Redis] Failed to get client context:", err);
      }
    } else {
      return localClientContexts.get(key) || null;
    }
    return null;
  },

  async getTurns(
    sessionCode: string,
    studentId: string,
    conversationId?: string,
  ): Promise<TurnLog[]> {
    const sCode = sessionCode.toUpperCase();
    const sId = studentId.toUpperCase();
    const key = conversationId
      ? `session:turns:${sCode}:${sId}:${conversationId}`
      : `session:turns:${sCode}:${sId}`;
    if (redis && redis.status === "ready") {
      try {
        // First attempt LRANGE because pushTurnAtomic and saveTurns store turns as a Redis List
        const items = await redis.lrange(key, 0, -1);
        if (items && items.length > 0) {
          return items.map((item) => JSON.parse(item));
        }
        // Fallback for legacy keys stored as a single JSON string
        const val = await redis.get(key);
        if (val) {
          return JSON.parse(val);
        }
      } catch (err: any) {
        // If LRANGE throws WRONGTYPE because key is a legacy string, read via GET
        if (err?.message?.includes("WRONGTYPE")) {
          try {
            const val = await redis.get(key);
            if (val) return JSON.parse(val);
          } catch {}
        }
        console.error("[Classifier Redis] Failed to get turns:", err);
      }
    } else {
      return localTurns.get(key) || [];
    }
    return [];
  },

  /**
   * Atomically appends a turn to the student's sliding window and trims to maxWindow using an atomic Redis Lua script.
   * Eliminates Read-Modify-Write race conditions under high CCU.
   * If conversationId is provided, the sliding window is scoped strictly to that conversation.
   */
  async pushTurnAtomic(
    sessionCode: string,
    studentId: string,
    turn: TurnLog,
    maxWindow = 10,
    conversationId?: string,
  ): Promise<TurnLog[]> {
    const sCode = sessionCode.toUpperCase();
    const sId = studentId.toUpperCase();
    const key = conversationId
      ? `session:turns:${sCode}:${sId}:${conversationId}`
      : `session:turns:${sCode}:${sId}`;

    if (redis && redis.status === "ready") {
      try {
        const luaScript = `
          redis.call('RPUSH', KEYS[1], ARGV[1])
          redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
          redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
          return redis.call('LRANGE', KEYS[1], 0, -1)
        `;
        const result = (await redis.eval(
          luaScript,
          1,
          key,
          JSON.stringify(turn),
          maxWindow.toString(),
          TURNS_TTL_SEC.toString(),
        )) as string[];

        if (Array.isArray(result)) {
          return result.map((item) => JSON.parse(item));
        }
      } catch (err) {
        console.error(
          "[Classifier Redis] pushTurnAtomic Lua failed, falling back to local memory:",
          err,
        );
      }
    }

    const list = localTurns.get(key) || [];
    list.push(turn);
    const trimmed = list.slice(-maxWindow);
    localTurns.set(key, trimmed);
    setTimeout(() => {
      if (localTurns.get(key) === trimmed) {
        localTurns.delete(key);
      }
    }, TURNS_TTL_SEC * 1000);
    return trimmed;
  },

  async saveTurns(
    sessionCode: string,
    studentId: string,
    turns: TurnLog[],
    conversationId?: string,
  ): Promise<void> {
    const sCode = sessionCode.toUpperCase();
    const sId = studentId.toUpperCase();
    const key = conversationId
      ? `session:turns:${sCode}:${sId}:${conversationId}`
      : `session:turns:${sCode}:${sId}`;
    if (redis && redis.status === "ready") {
      try {
        const pipeline = redis.pipeline();
        pipeline.del(key);
        if (turns.length > 0) {
          pipeline.rpush(key, ...turns.map((t) => JSON.stringify(t)));
          pipeline.expire(key, TURNS_TTL_SEC);
        }
        await pipeline.exec();
      } catch (err) {
        console.error("[Classifier Redis] Failed to save turns:", err);
      }
    } else {
      localTurns.set(key, turns);
    }
  },

  async cacheLatestEvent(
    sessionCode: string,
    studentId: string,
    event: any,
  ): Promise<void> {
    const key = `session:latest-event:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.set(key, JSON.stringify(event), "EX", 86400);
      } catch (err) {
        console.error("[Classifier Redis] Failed to cache latest event:", err);
      }
    } else {
      localLatestClassifications.set(key, event);
    }
  },

  async getLatestEvent(
    sessionCode: string,
    studentId: string,
  ): Promise<any | null> {
    const key = `session:latest-event:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        const val = await redis.get(key);
        if (val) return JSON.parse(val);
      } catch (err) {
        console.error("[Classifier Redis] Failed to get latest event:", err);
      }
    } else {
      return localLatestClassifications.get(key) || null;
    }
    return null;
  },

  async cacheClassification(
    token: string,
    label: string,
    confidence: number,
  ): Promise<void> {
    const key = `session:latest-class:${token}`;
    if (redis && redis.status === "ready") {
      try {
        const data = JSON.stringify({ label, confidence });
        await redis.set(key, data, "EX", LATEST_CLASS_TTL_SEC);
      } catch (err) {
        console.error(
          "[Classifier Redis] Failed to cache classification:",
          err,
        );
      }
    } else {
      localLatestClassifications.set(key, { label, confidence });
      setTimeout(
        () => localLatestClassifications.delete(key),
        LATEST_CLASS_TTL_SEC * 1000,
      );
    }
  },

  async setCachedClassification(
    token: string,
    label: string,
    confidence: number,
  ): Promise<void> {
    return this.cacheClassification(token, label, confidence);
  },

  async getCachedClassification(
    token: string,
  ): Promise<{ label: string; confidence: number } | null> {
    const key = `session:latest-class:${token}`;
    if (redis && redis.status === "ready") {
      try {
        const val = await redis.get(key);
        if (val) {
          return JSON.parse(val);
        }
      } catch (err) {
        console.error(
          "[Classifier Redis] Failed to get cached classification:",
          err,
        );
      }
    } else {
      return localLatestClassifications.get(key) || null;
    }
    return null;
  },

  async setEvaluationPending(token: string, pending: boolean): Promise<void> {
    const key = `session:eval-pending:${token}`;
    if (redis && redis.status === "ready") {
      try {
        if (pending) {
          await redis.set(key, "true", "EX", EVAL_PENDING_TTL_SEC);
        } else {
          await redis.del(key);
        }
      } catch (err) {
        console.error("[Classifier Redis] Failed to set evaluation pending:", err);
      }
    } else {
      if (pending) {
        localPendingEvaluations.set(key, true);
        setTimeout(
          () => localPendingEvaluations.delete(key),
          EVAL_PENDING_TTL_SEC * 1000,
        );
      } else {
        localPendingEvaluations.delete(key);
      }
    }
  },

  async isEvaluationPending(token: string): Promise<boolean> {
    const key = `session:eval-pending:${token}`;
    if (redis && redis.status === "ready") {
      try {
        const val = await redis.get(key);
        return val === "true";
      } catch (err) {
        console.error("[Classifier Redis] Failed to check evaluation pending:", err);
        return false;
      }
    } else {
      return !!localPendingEvaluations.get(key);
    }
  },
};

const localPendingEvaluations = new Map<string, boolean>();
