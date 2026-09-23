import crypto from "crypto";
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import { getProxyApiKey } from "../services/proxyKey";
import {
  blockMessage,
  evaluateClient,
  exemptVerifiedSessions,
  getGateMode,
  logOnce,
  readClientIdentity,
} from "../services/clientGate";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export interface ClientVersionGateOptions {
  /**
   * When true, a request carrying a session JWT with the `cgv` claim (issued to a
   * client that passed this gate at session login) is not re-checked. This keeps
   * students who are already inside an exam working if the minimum version is
   * raised mid-session.
   */
  allowVerifiedSessionTokens?: boolean;
}

/**
 * Blocks outdated / unidentified Fvscode clients with HTTP 426.
 * CLIENT_GATE_MODE=warn only logs; CLIENT_GATE_MODE=off disables the check.
 */
export const clientVersionGate = (
  options: ClientVersionGateOptions = {},
): MiddlewareHandler => {
  return async (c, next) => {
    const mode = getGateMode();
    if (mode === "off" || c.req.method === "OPTIONS") {
      return next();
    }

    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";

    // Operator/master key traffic (tools, admin scripts) is not a student client.
    if (token && safeEqual(token, getProxyApiKey())) {
      return next();
    }

    if (
      options.allowVerifiedSessionTokens &&
      exemptVerifiedSessions() &&
      token.startsWith("eyJ")
    ) {
      try {
        const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
        if (payload && payload.sessionCode && payload.cgv === 1) {
          return next();
        }
      } catch {
        // Fall through: invalid tokens are rejected by the auth middleware later.
      }
    }

    const identity = readClientIdentity((n) => c.req.header(n));
    const evaluation = evaluateClient(identity);

    if (evaluation.status === "ok") {
      return next();
    }

    logOnce(
      `gate:${evaluation.status}:${identity.version || "none"}`,
      `[ClientGate] ${mode === "enforce" ? "BLOCKED" : "would block"} ${c.req.method} ${c.req.path}: ${evaluation.reason}`,
    );

    if (!evaluation.allowed) {
      return c.json(
        {
          error: blockMessage(evaluation),
          code: "CLIENT_UPDATE_REQUIRED",
          status: evaluation.status,
          minVersion: evaluation.minVersion || null,
          latestVersion: evaluation.latest?.version || null,
        },
        426,
      );
    }

    return next();
  };
};
