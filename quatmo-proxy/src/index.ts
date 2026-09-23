import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { chatRouter } from "./routes/chat";
import { adminRouter } from "./routes/admin";
import { sessionAuthRouter } from "./routes/sessionAuth";
import { authRouter } from "./routes/auth";
import { updateRouter } from "./routes/update";
import { clientRouter } from "./routes/client";
import { proxyKeyConfig } from "./services/proxyKey";
import { unifiedAuthMiddleware } from "./middleware/authUnified";
import { logGlobal } from "./services/secureLogger";
import { syncAllDataToRedis } from "./services/sessionStore";
import dotenv from "dotenv";
import { maskSecret, validateSecretsAtStartup } from "./services/security";
import { logOnce } from "./services/clientGate";

dotenv.config();
validateSecretsAtStartup();

/**
 * CORS allowlist. Desktop clients (Node fetch) send no Origin and are unaffected.
 * CORS_ORIGINS: comma-separated exact origins; "*.domain" allows https subdomains.
 */
const corsPatterns = (
  process.env.CORS_ORIGINS || "*.iahn.hanoi.vn,vscode-webview://*"
)
  .split(",")
  .map((o) => o.trim().toLowerCase())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  const o = origin.toLowerCase();
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
    return true;
  }
  for (const p of corsPatterns) {
    if (p === o) return true;
    if (p === "vscode-webview://*" && o.startsWith("vscode-webview://")) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".iahn.hanoi.vn"
      try {
        const u = new URL(o);
        if (u.protocol === "https:" && (u.hostname.endsWith(suffix) || u.hostname === suffix.slice(1))) {
          return true;
        }
      } catch {}
    }
  }
  // Surface misconfiguration (e.g. admin UI hosted on a domain not in CORS_ORIGINS).
  logOnce(`cors:${o}`, `[CORS] Rejected origin ${o.slice(0, 200)} (add it to CORS_ORIGINS if legitimate)`);
  return false;
}

const app = new Hono();

// Global Logger (only enabled in dev or if explicitly requested to maximize CCU)
if (
  process.env.ENABLE_LOGS === "true" ||
  process.env.NODE_ENV !== "production"
) {
  app.use("*", logger());
}

// CORS Policy - allowlisted browser origins only (quatmo-admin); desktop clients send no Origin
app.use(
  "*",
  cors({
    origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-api-key",
      "X-API-Key",
      "x-proxy-key",
      "X-Proxy-Key",
      "x-client-type",
      "x-machine-id",
      "x-client-fingerprint",
      "x-client-version",
      "x-client-commit",
      "x-client-build-hash",
      "x-client-extension-version",
      "x-conversation-id",
      "last-event-id",
    ],
    exposeHeaders: ["Content-Disposition", "Retry-After", "X-RateLimit-Reset"],
    maxAge: 86400,
  }),
);

// Global OPTIONS preflight handler to guarantee zero preflight failures across all routes
app.options("*", (c) => {
  return c.body(null, 204);
});

// Route mappings
app.route("/v1/chat", chatRouter);
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);
app.route("/auth", authRouter);
app.route("/v1/auth", authRouter);
app.route("/v1/client", clientRouter);
app.route("/client", clientRouter);
app.route("/v1", updateRouter);
app.route("/", updateRouter);

app.get("/v1/models", unifiedAuthMiddleware(), (c) => {
  return c.json({
    data: [{ id: "gemma4-26b" }],
  });
});

// Health check endpoint
app.get("/health", (c) =>
  c.json({ status: "healthy", timestamp: new Date().toISOString() }),
);

const port = parseInt(process.env.PORT || "3000", 10);

console.log(`[Proxy] Starting Quatmo Proxy Server on port ${port}...`);
syncAllDataToRedis().catch((err) =>
  console.error("[Proxy] Redis startup sync error:", err),
);

console.log(
  proxyKeyConfig.source === "env"
    ? "[Proxy] Using PROXY_API_KEY from environment."
    : "[Proxy] No PROXY_API_KEY found. Generated runtime proxy key.",
);
console.log(
  `[Proxy] Access key: ${
    proxyKeyConfig.source === "generated" && process.env.NODE_ENV !== "production"
      ? proxyKeyConfig.value
      : maskSecret(proxyKeyConfig.value)
  }`,
);

logGlobal({ level: "info", event: "server_start", port });

process.on("uncaughtException", (err) => {
  console.error("[Proxy] Uncaught exception:", err);
  logGlobal({
    level: "error",
    event: "uncaught_exception",
    error: err.message,
    stack: err.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.error("[Proxy] Unhandled rejection:", msg);
  logGlobal({
    level: "error",
    event: "unhandled_rejection",
    error: msg,
    stack,
  });
});

export default {
  port,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  // Hard cap on request bodies (uploads, chat). Default 128MB in Bun.
  maxRequestBodySize: parseInt(process.env.MAX_REQUEST_BODY_BYTES || String(110 * 1024 * 1024), 10),
  fetch: app.fetch,
};
