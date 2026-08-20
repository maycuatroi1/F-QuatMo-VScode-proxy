import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { chatRouter } from "./routes/chat";
import { adminRouter } from "./routes/admin";
import { sessionAuthRouter } from "./routes/sessionAuth";
import { authRouter } from "./routes/auth";
import { proxyKeyConfig } from "./services/proxyKey";
import { unifiedAuthMiddleware } from "./middleware/authUnified";
import { logGlobal } from "./services/secureLogger";
import dotenv from "dotenv";

dotenv.config();

const app = new Hono();

// Global Logger (only enabled in dev or if explicitly requested to maximize CCU)
if (
  process.env.ENABLE_LOGS === "true" ||
  process.env.NODE_ENV !== "production"
) {
  app.use("*", logger());
}

// CORS Policy - Universal permissive configuration for quatmo-admin and all clients
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-api-key",
      "X-API-Key",
      "x-proxy-key",
      "X-Proxy-Key",
      "*",
    ],
    exposeHeaders: ["*"],
    maxAge: 86400,
  }),
);

// Global OPTIONS preflight handler to guarantee zero preflight failures across all routes
app.options("*", (c) => {
  return c.text("", 204);
});

// Route mappings
app.route("/v1/chat", chatRouter);
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
app.route("/session", sessionAuthRouter);
app.route("/v1/session", sessionAuthRouter);
app.route("/auth", authRouter);
app.route("/v1/auth", authRouter);

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
console.log(
  proxyKeyConfig.source === "env"
    ? "[Proxy] Using PROXY_API_KEY from environment."
    : "[Proxy] No PROXY_API_KEY found. Generated runtime proxy key.",
);
console.log(`[Proxy] Access key: ${proxyKeyConfig.value}`);

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
  fetch: app.fetch,
};
