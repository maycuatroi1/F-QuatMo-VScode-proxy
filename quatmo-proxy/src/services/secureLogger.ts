/**
 * secureLogger.ts — Encrypted logging service
 *
 * All log files are encrypted with AES-256-GCM using LOG_ENCRYPT_KEY from env.
 * If LOG_ENCRYPT_KEY is not set, logs are written as plain JSON (dev mode).
 *
 * Two log types:
 *   1. Session logs  — per-session activity under logs/sessions/<sessionCode>/<id>.log
 *   2. Global log    — all events since server start under logs/global.log
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = "aes-256-gcm";
const LOG_ENCRYPT_KEY = (process.env.LOG_ENCRYPT_KEY || "").trim();

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptLine(plain: string): string {
  if (!LOG_ENCRYPT_KEY) return plain;
  const key = deriveKey(LOG_ENCRYPT_KEY);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);
  return payload.toString("base64");
}

function decryptLine(encoded: string, secret: string): string {
  const key = deriveKey(secret);
  const payload = Buffer.from(encoded, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf-8");
}

async function appendEncryptedLine(filePath: string, record: object) {
  const line = encryptLine(JSON.stringify(record));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, line + "\n", "utf-8");
}

// ─── Global log ──────────────────────────────────────────────────────────────

const globalLogPath = path.resolve(process.cwd(), "logs", "global.log");

export async function logGlobal(record: {
  timestamp?: string;
  level: "info" | "warn" | "error";
  event: string;
  [key: string]: unknown;
}) {
  const entry = { timestamp: new Date().toISOString(), ...record };
  try {
    await appendEncryptedLine(globalLogPath, entry);
  } catch (err) {
    console.error("[SecureLogger] Failed to write global log:", err);
  }
}

// ─── Session log ─────────────────────────────────────────────────────────────

export async function logSession(
  sessionCode: string,
  studentId: string,
  record: object
) {
  const sessionLogDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode
  );
  const sessionLogPath = path.resolve(sessionLogDir, `${studentId}.log`);
  try {
    await appendEncryptedLine(sessionLogPath, record);
  } catch (err) {
    console.error("[SecureLogger] Failed to write session log:", err);
  }
}

// ─── Read / decrypt helpers (used by the CLI tool) ───────────────────────────

export function decryptLogFile(filePath: string, secret: string): object[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const results: object[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // Try decrypt first; fall back to plain JSON (dev mode files)
      let json: string;
      try {
        json = decryptLine(trimmed, secret);
      } catch {
        json = trimmed;
      }
      results.push(JSON.parse(json));
    } catch {
      results.push({ _raw: trimmed, _error: "Failed to parse line" });
    }
  }
  return results;
}
