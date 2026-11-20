import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = mkdtempSync(path.join(tmpdir(), "quatmo-proxy-test-"));
// Match the production resource layout without copying secrets or live data.
cpSync(path.join(root, "src/systemPrompts"), path.join(sandbox, "src/systemPrompts"), { recursive: true });
const result = Bun.spawnSync({
  cmd: [
    process.execPath,
    "--no-env-file",
    "test",
    "--preload",
    path.join(root, "tests/setup/isolation.ts"),
    path.join(root, "tests"),
    ...process.argv.slice(2),
  ],
  cwd: sandbox,
  env: {
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "",
    TEMP: tmpdir(),
    TMP: tmpdir(),
    NODE_ENV: "test",
    PROXY_REFACTOR_SANDBOX: "1",
    JWT_SECRET: "isolated-proxy-test-secret-not-for-production",
    PROXY_API_KEY: "isolated-proxy-test-key-not-for-production",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
  },
  stdout: "inherit",
  stderr: "inherit",
});
console.log(`Test-only files retained at: ${sandbox}`);
process.exit(result.exitCode);
