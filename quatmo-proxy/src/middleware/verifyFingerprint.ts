/**
 * verifyFingerprint.ts — Proxy middleware that verifies the per-device build
 * fingerprint sent via the `X-Client-Fingerprint` header.
 *
 * The fingerprint is a base64-encoded JSON block containing:
 *   { clientId, staffId, deviceId, issuedAt, version, signature }
 *
 * The signature is `hmac-sha256:<hex>`, produced at build time using the
 * BUILD_SIGNING_SECRET.  Only builds signed with the correct secret will
 * pass verification.
 *
 * Context variables set by this middleware:
 *   - `clientId`  — verified clientId, or "unsigned" / "tampered:<id>" / "malformed"
 *   - `staffId`   — from the fingerprint (only when valid)
 *   - `deviceId`  — from the fingerprint (only when valid)
 */

import crypto from "crypto";
import type { MiddlewareHandler } from "hono";
import fs from "fs";
import path from "path";

const BUILD_SIGNING_SECRET = process.env.BUILD_SIGNING_SECRET || "";

export interface ClientFingerprintPayload {
  clientId: string;
  staffId: string;
  deviceId: string;
  issuedAt: string;
  version: string;
  signature: string;
}

async function logForensicEvent(event: {
  timestamp: string;
  clientId: string;
  staffId: string;
  deviceId: string;
  ip: string;
  userAgent: string;
  status: string;
}) {
  try {
    const logDir = path.resolve(process.cwd(), "logs");
    await fs.promises.mkdir(logDir, { recursive: true });
    const logFilePath = path.join(logDir, "forensic_audit.json");
    await fs.promises.appendFile(logFilePath, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    console.error("[Fingerprint Log] Failed to write forensic audit:", err);
  }
}

export const verifyFingerprintMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const raw = c.req.header("X-Client-Fingerprint");
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const userAgent = c.req.header("user-agent") || "unknown";
    const timestamp = new Date().toISOString();

    const LATEST_FINGERPRINT = (process.env.LATEST_FINGERPRINT || "").trim();
    if (LATEST_FINGERPRINT) {
      let matches = false;
      if (raw === LATEST_FINGERPRINT) {
        matches = true;
      } else if (raw) {
        try {
          const decoded = Buffer.from(raw, "base64").toString("utf-8");
          const fingerprint = JSON.parse(decoded);
          if (fingerprint.signature === LATEST_FINGERPRINT) {
            matches = true;
          }
        } catch (e) {
          // ignore
        }
      }

      if (!matches) {
        console.warn(`[Fingerprint] signingkey không hợp lệ (Expected: ${LATEST_FINGERPRINT}, Received: ${raw || "none"})`);
        logForensicEvent({
          timestamp,
          clientId: "invalid_signingkey",
          staffId: "unknown",
          deviceId: "unknown",
          ip,
          userAgent,
          status: "invalid_signingkey",
        });
      }
    }

    if (!raw) {
      // No fingerprint header — unsigned/dev build
      c.set("clientId" as any, "unsigned");
      // Run in background
      logForensicEvent({
        timestamp,
        clientId: "unsigned",
        staffId: "unknown",
        deviceId: "unknown",
        ip,
        userAgent,
        status: "unsigned",
      });
      return next();
    }

    if (!BUILD_SIGNING_SECRET) {
      // Server has no signing secret configured
      c.set("clientId" as any, "unverified");
      return next();
    }

    try {
      const decoded = Buffer.from(raw, "base64").toString("utf-8");
      const fingerprint: ClientFingerprintPayload = JSON.parse(decoded);

      const { signature, ...payload } = fingerprint;

      // Recompute the expected signature
      const payloadStr = JSON.stringify(payload);
      const expectedSig = `hmac-sha256:${crypto
        .createHmac("sha256", BUILD_SIGNING_SECRET)
        .update(payloadStr)
        .digest("hex")}`;

      // Constant-time comparison to prevent timing attacks
      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSig);
      const valid =
        sigBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(sigBuffer, expectedBuffer);

      if (!valid) {
        console.warn(
          `[Fingerprint] INVALID signature from clientId=${fingerprint.clientId} staffId=${fingerprint.staffId} deviceId=${fingerprint.deviceId}`,
        );
        c.set("clientId" as any, `tampered:${fingerprint.clientId}`);
        logForensicEvent({
          timestamp,
          clientId: fingerprint.clientId,
          staffId: fingerprint.staffId,
          deviceId: fingerprint.deviceId,
          ip,
          userAgent,
          status: "tampered",
        });
      } else {
        c.set("clientId" as any, fingerprint.clientId);
        c.set("staffId" as any, fingerprint.staffId);
        c.set("deviceId" as any, fingerprint.deviceId);
        logForensicEvent({
          timestamp,
          clientId: fingerprint.clientId,
          staffId: fingerprint.staffId,
          deviceId: fingerprint.deviceId,
          ip,
          userAgent,
          status: "verified",
        });
      }
    } catch (err) {
      console.warn("[Fingerprint] Malformed fingerprint header:", err);
      c.set("clientId" as any, "malformed");
      logForensicEvent({
        timestamp,
        clientId: "malformed",
        staffId: "unknown",
        deviceId: "unknown",
        ip,
        userAgent,
        status: "malformed",
      });
    }

    return next();
  };
};
