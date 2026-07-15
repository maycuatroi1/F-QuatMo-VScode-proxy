import { redis } from "../redis";

export interface TurnLog {
  timestamp: number;
  prompt: string;
  response: string;
  codeSnapshot?: string;
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

export const redisStore = {
  async saveClientContext(
    sessionCode: string,
    studentId: string,
    context: ClientContext,
  ): Promise<void> {
    const key = `session:client-context:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.set(
          key,
          JSON.stringify(context),
          "EX",
          CLIENT_CONTEXT_TTL_SEC,
        );
      } catch (err) {
        console.error("[Classifier Redis] Failed to save client context:", err);
      }
    } else {
      localClientContexts.set(key, context);
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

  async getTurns(sessionCode: string, studentId: string): Promise<TurnLog[]> {
    const key = `session:turns:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        const val = await redis.get(key);
        if (val) {
          return JSON.parse(val);
        }
      } catch (err) {
        console.error("[Classifier Redis] Failed to get turns:", err);
      }
    } else {
      return localTurns.get(key) || [];
    }
    return [];
  },

  async saveTurns(
    sessionCode: string,
    studentId: string,
    turns: TurnLog[],
  ): Promise<void> {
    const key = `session:turns:${sessionCode.toUpperCase()}:${studentId.toUpperCase()}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.set(key, JSON.stringify(turns), "EX", TURNS_TTL_SEC);
      } catch (err) {
        console.error("[Classifier Redis] Failed to save turns:", err);
      }
    } else {
      localTurns.set(key, turns);
    }
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
          await redis.set(key, "true", "EX", 15); // 15s TTL max
        } else {
          await redis.del(key);
        }
      } catch (err) {
        console.error("[Classifier Redis] Failed to set evaluation pending:", err);
      }
    } else {
      if (pending) {
        localPendingEvaluations.set(key, true);
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
