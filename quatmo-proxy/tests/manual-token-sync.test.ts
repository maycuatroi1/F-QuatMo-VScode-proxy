import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const scriptPath = fileURLToPath(new URL("../scripts/sync_session_tokens.ts", import.meta.url));
const storePath = fileURLToPath(new URL("../src/services/sessionStore.ts", import.meta.url));
const isolation = fileURLToPath(new URL("./setup/isolation.ts", import.meta.url));

test("manual token sync imports and executes on isolated SQLite, manifest and ZIP fixtures", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), "manual-sync-"));
  const directory = path.join(root, "work");
  fs.mkdirSync(directory);
  const code = "SCRIPT_SYNC_TEST";
  const manifest = path.join(directory, "logs", "sessions", code, "session_manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "\uFEFF" + JSON.stringify({ students: [{ studentId: "sefixture", tokensConsumed: 321, promptTurns: 3 }] }));
  const zip = new AdmZip();
  zip.addFile("session_manifest.json", Buffer.from(JSON.stringify({ sessionCode: code, students: [{ studentId: "sefixture", tokensConsumed: 456, promptTurns: 4 }] })));
  fs.writeFileSync(path.join(root, "logs_fixture.zip"), zip.toBuffer());
  fs.writeFileSync(path.join(root, "logs_corrupt.zip"), "invalid ZIP");
  const seed = `const { sessions, sessionStates } = await import(${JSON.stringify(storePath)});
    for (const sessionCode of [${JSON.stringify(code)}, "SCRIPT_OTHER"]) {
      sessions.set(sessionCode, { sessionCode, startTime: 123, durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000, allowedStudentIds: new Set(["SEFIXTURE"]), createdAt: 123 });
      sessionStates.set(sessionCode + ":SEFIXTURE", { sessionCode, studentId: "SEFIXTURE", hasLoggedIn: true, loginTimestamp: 123, tokensConsumed: 99, reassigned: false });
    }
    process.argv[2] = ${JSON.stringify(code.toLowerCase())};
    await import(${JSON.stringify(scriptPath)});`;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", isolation, "-e", seed], {
    cwd: directory, env: process.env, timeout: 15000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("Completed. Updated 2 student token records");
  const db = new Database(path.join(directory, "logs/quatmo.db"), { readonly: true });
  try {
    expect(db.query("SELECT tokens_consumed, has_logged_in, login_timestamp FROM session_states WHERE session_code = ?").get(code)).toEqual({ tokens_consumed: 456, has_logged_in: 1, login_timestamp: 123 });
    expect(db.query("SELECT tokens_consumed FROM session_states WHERE session_code = ?").get("SCRIPT_OTHER")).toEqual({ tokens_consumed: 99 });
    expect(fs.readFileSync(manifest, "utf8")).toContain('"tokensConsumed":321');
  } finally { db.close(); }
});
