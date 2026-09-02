import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let redis: Redis | null = null;

try {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 2000);
      if (times % 10 === 0) {
        console.warn(
          `[Redis] Retrying connection (attempt ${times})...`,
        );
      }
      return delay;
    },
  });

  redis.on("error", (err: Error) => {
    console.error("[Redis] Connection error:", err.message);
  });

  redis.on("connect", () => {
    console.log("[Redis] Connected successfully to Redis server.");
    // Synchronize active SQLite sessions into Redis RAM cache upon connection or reconnection.
    import("./sessionStore").then(({ syncAllDataToRedis }) => {
      syncAllDataToRedis().catch((err) =>
        console.error("[Redis] Re-hydration on connect failed:", err),
      );
    });
  });
} catch (e) {
  console.warn(
    "[Redis] Failed to initialize Redis. Running with limited memory storage.",
  );
}

export { redis };
export type { Redis };
