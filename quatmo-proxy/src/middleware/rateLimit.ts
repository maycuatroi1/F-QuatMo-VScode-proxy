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
    const clientType = c.req.header("x-client-type");
    if (clientType === "quatmo-code") {
      return await next();
    }

    const user = c.get("user") as UserSession | undefined;
    if (!user) {
      return c.json({ error: "Context unauthorized" }, 401);
    }

    let limitVal = 30;
    if (process.env.RATE_LIMIT_PER_MINUTE !== undefined) {
      const parsed = parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10);
      if (!isNaN(parsed)) {
        limitVal = parsed;
      }
    }

    if (limitVal <= 0) {
      return await next();
    }

    const currentMinute = Math.floor(Date.now() / 60000);
    const redisKey = `rate:req:${user.keyId}:${currentMinute}`;

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
