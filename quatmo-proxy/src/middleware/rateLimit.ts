import type { MiddlewareHandler } from "hono";
import { redis } from "../services/redis";
import type { UserSession } from "./auth";

const inMemoryStore = new Map<string, number>();

setInterval(() => {
  const currentMinute = Math.floor(Date.now() / 60000);
  for (const key of inMemoryStore.keys()) {
    const parts = key.split(":");
    const min = parseInt(parts[parts.length - 1], 10);
    if (min < currentMinute) {
      inMemoryStore.delete(key);
    }
  }
}, 60000).unref();

export const rateLimitMiddleware = (): MiddlewareHandler<{
  Variables: { user: UserSession; token: string };
}> => {
  return async (c, next) => {
    // The client type header is client-controlled, so it must not disable limits.
    // Agent mode (many tool-call turns) just gets a higher, separate budget.
    const clientType = c.req.header("x-client-type");
    const isAgent = clientType === "quatmo-code";

    const user = c.get("user") as UserSession | undefined;
    if (!user) {
      return c.json({ error: "Context unauthorized" }, 401);
    }

    let limitVal = isAgent ? 120 : 30;
    const envLimit = isAgent
      ? process.env.RATE_LIMIT_AGENT_PER_MINUTE
      : process.env.RATE_LIMIT_PER_MINUTE;
    if (envLimit !== undefined) {
      const parsed = parseInt(envLimit, 10);
      if (!isNaN(parsed)) {
        limitVal = parsed;
      }
    }

    if (limitVal <= 0) {
      return await next();
    }

    const currentMinute = Math.floor(Date.now() / 60000);
    // Session tokens share keyId "session-<code>" across the whole class: bucket per
    // student so one student can never throttle the others during an exam.
    const subject = user.userId ? `${user.keyId}:${user.userId}` : user.keyId;
    const redisKey = `rate:req:${isAgent ? "agent" : "chat"}:${subject}:${currentMinute}`;

    if (redis && redis.status === "ready") {
      try {
        const count = await redis.incr(redisKey);
        if (count === 1) {
          redis.expire(redisKey, 60).catch((err) => {
            console.error("[RateLimit] Redis expire error:", err);
          });
        }

        if (count > limitVal) {
          return c.json(
            {
              error: `Too many requests. Rate limit exceeded (${limitVal} req/min).`,
            },
            429,
          );
        }
      } catch (err) {
        console.error("[RateLimit] Redis error:", err);
      }
    } else {
      // In-memory rate limiting fallback for local dev without Redis
      const count = (inMemoryStore.get(redisKey) || 0) + 1;
      inMemoryStore.set(redisKey, count);
      if (count > limitVal) {
        return c.json(
          {
            error: `Too many requests. Rate limit exceeded (${limitVal} req/min).`,
          },
          429,
        );
      }
    }

    return await next();
  };
};
