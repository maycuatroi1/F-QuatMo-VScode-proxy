import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") {
  throw new Error("Run through scripts/test-isolated.ts to protect application data.");
}
mock.module(fileURLToPath(new URL("../../src/services/redis.ts", import.meta.url)), () => ({ redis: null }));
globalThis.fetch = async () => {
  throw new Error("Outbound HTTP is disabled in isolated proxy tests");
};
