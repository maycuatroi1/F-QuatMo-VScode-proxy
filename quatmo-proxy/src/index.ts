import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { chatRouter } from "./routes/chat";
import { adminRouter } from "./routes/admin";
import { examAuthRouter } from "./routes/examAuth";
import { proxyKeyConfig } from "./services/proxyKey";
import dotenv from "dotenv";

dotenv.config();

const app = new Hono();

// Global Logger (only enabled in dev or if explicitly requested to maximize CCU)
if (process.env.ENABLE_LOGS === "true" || process.env.NODE_ENV !== "production") {
  app.use("*", logger());
}

// CORS Policy
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Route mappings
app.route("/v1/chat", chatRouter);
app.route("/admin", adminRouter);
app.route("/v1/exam", examAuthRouter);

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

export default {
  port,
  idleTimeout: 255,
  fetch: app.fetch,
};
