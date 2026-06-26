import type { MiddlewareHandler } from "hono";
import { redis } from "../services/redis";
import type { UserSession } from "./auth";

const REQUEST_LIMIT_PER_MINUTE = 30;
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

        if (count > REQUEST_LIMIT_PER_MINUTE) {
          return c.json(
            {
              error: `Too many requests. Rate limit exceeded (${REQUEST_LIMIT_PER_MINUTE} req/min).`,
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
      if (count > REQUEST_LIMIT_PER_MINUTE) {
        return c.json(
          {
            error: `Too many requests. Rate limit exceeded (${REQUEST_LIMIT_PER_MINUTE} req/min).`,
          },
          429,
        );
      }
    }

    return await next();
  };
};
