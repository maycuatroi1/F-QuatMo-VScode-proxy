#!/usr/bin/env bun
/**
 * decrypt-logs.ts — CLI tool to decrypt encrypted log files
 *
 * Usage:
 *   bun bin/decrypt-logs.ts <log-file> [--key <secret>] [--pretty]
 *
 * Examples:
 *   bun bin/decrypt-logs.ts logs/global.log --key mySecret --pretty
 *   bun bin/decrypt-logs.ts logs/sessions/EX-001/student1.log --pretty
 *
 * If --key is omitted, LOG_ENCRYPT_KEY from .env is used.
 */

import path from "path";
import { decryptLogFile } from "../src/services/secureLogger";
import dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
  decrypt-logs — Decrypt encrypted proxy log files

  Usage:
    bun bin/decrypt-logs.ts <log-file> [options]

  Options:
    --key <secret>   Encryption key (defaults to LOG_ENCRYPT_KEY in .env)
    --pretty         Pretty-print JSON output
    -h, --help       Show this help

  Examples:
    bun bin/decrypt-logs.ts logs/global.log --pretty
    bun bin/decrypt-logs.ts logs/sessions/EX-001/2.log --key mySecret --pretty
`);
  process.exit(0);
}

const filePath = path.resolve(process.cwd(), args[0]);
let key = (process.env.LOG_ENCRYPT_KEY || "").trim();
let pretty = false;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--key" && args[i + 1]) {
    key = args[i + 1];
    i++;
  } else if (args[i] === "--pretty") {
    pretty = true;
  }
}

if (!key) {
  console.warn(
    "[decrypt-logs] No key provided and LOG_ENCRYPT_KEY not set. Attempting plain JSON fallback."
  );
}

try {
  const records = decryptLogFile(filePath, key);
  console.log(pretty ? JSON.stringify(records, null, 2) : JSON.stringify(records));
} catch (err: any) {
  console.error("[decrypt-logs] Failed to read/decrypt file:", err.message);
  process.exit(1);
}
