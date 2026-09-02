import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const isRedisConfigured = Boolean(process.env.REDIS_URL);

let redis: Redis | null = null;
let lastRedisErrorLog = 0;

try {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 3000,
    lazyConnect: false,
    retryStrategy(times: number) {
      if (!isRedisConfigured) {
        if (times > 2) {
          console.log(
            "[Redis] Local Redis not detected. Disabling reconnect loop (Proxy operating on SQLite & RAM).",
          );
          return null; // Stop reconnect attempts completely
        }
        return 500;
      }
      // Production mode with REDIS_URL set: back off gracefully
      return Math.min(times * 1000, 30000);
    },
  });

  redis.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastRedisErrorLog > 60000) {
      if (isRedisConfigured) {
        console.warn(`[Redis] Connection warning: ${err.message}`);
      }
      lastRedisErrorLog = now;
    }
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
    "[Redis] Failed to initialize Redis. Running with SQLite memory storage.",
  );
}

export { redis };
export type { Redis };
