import { mock } from "bun:test";

// Mock the driver, not services/redis: preserve dotenv's actual import timing.
class RedisStub {
  status = "end";
  on() { return this; }
  duplicate() { return new RedisStub(); }
  subscribe(_channel: string, callback: Function) { callback(new Error("isolated")); }
  psubscribe(_channel: string, callback: Function) { callback(new Error("isolated")); }
}
mock.module("ioredis", () => ({ Redis: RedisStub, default: RedisStub }));
globalThis.fetch = async () => { throw new Error("External HTTP blocked by ENV probe"); };

const { default: server } = await import("./src/index.ts");
const { getProxyApiKey, proxyKeyConfig } = await import("./src/services/proxyKey.ts");
const { getJwtSecret } = await import("./src/services/jwtKey.ts");
const { getAdminUsername, getAdminPassword } = await import("./src/services/adminCredentials.ts");
const { INSTRUMENTAL_WEIGHTS } = await import("./src/services/classifier/weights.ts");
const origin = process.env.CORS_ORIGINS || "https://probe.example.test";
const cors = await server.fetch(new Request("http://localhost/admin/security/lockouts", {
  method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
}));
const denied = await server.fetch(new Request("http://localhost/admin/security/lockouts"));
const health = await server.fetch(new Request("http://localhost/health"));
const forbiddenOrigin = await server.fetch(new Request("http://localhost/admin/security/lockouts", {
  method: "OPTIONS", headers: { Origin: "https://untrusted.example.invalid", "Access-Control-Request-Method": "GET" },
}));
console.log("ENV_PROBE:" + JSON.stringify({
  port: server.port,
  hostname: server.hostname,
  idleTimeout: server.idleTimeout,
  maxRequestBodySize: server.maxRequestBodySize,
  keySource: proxyKeyConfig.source,
  proxyMatchesEnv: !process.env.PROXY_API_KEY || getProxyApiKey() === process.env.PROXY_API_KEY.trim(),
  jwtMatchesEnv: !process.env.JWT_SECRET || getJwtSecret() === process.env.JWT_SECRET.trim(),
  admin: getAdminUsername(),
  adminPasswordMatches: getAdminPassword() === (process.env.ADMIN_PASSWORD || getProxyApiKey()),
  weights: INSTRUMENTAL_WEIGHTS,
  corsStatus: cors.status,
  corsOrigin: cors.headers.get("access-control-allow-origin"),
  forbiddenCorsOrigin: forbiddenOrigin.headers.get("access-control-allow-origin"),
  deniedStatus: denied.status,
  healthStatus: health.status,
}));
process.exit(0);
