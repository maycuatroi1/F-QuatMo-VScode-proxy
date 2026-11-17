import assert from "node:assert/strict";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = "42917845fe89656af343e26c1b93898063b7ec6e";
const baselineAdmin = Bun.spawnSync(["git", "show", `${baseline}:quatmo-proxy/src/routes/admin.ts`], { cwd: root });
assert.equal(baselineAdmin.exitCode, 0, "Unable to read pinned baseline");
const baselineUserAuth = Bun.spawnSync(["git", "show", `${baseline}:quatmo-proxy/src/routes/auth.ts`], { cwd: root });
assert.equal(baselineUserAuth.exitCode, 0, "Unable to read pinned user-auth baseline");
const baselineSessionAuth = Bun.spawnSync(["git", "show", `${baseline}:quatmo-proxy/src/routes/sessionAuth.ts`], { cwd: root });
assert.equal(baselineSessionAuth.exitCode, 0, "Unable to read pinned session-auth baseline");
const baselineChat = Bun.spawnSync(["git", "show", `${baseline}:quatmo-proxy/src/routes/chat.ts`], { cwd: root });
assert.equal(baselineChat.exitCode, 0, "Unable to read pinned chat baseline");
const baselineUpdate = Bun.spawnSync(["git", "show", `${baseline}:quatmo-proxy/src/routes/update.ts`], { cwd: root });
assert.equal(baselineUpdate.exitCode, 0, "Unable to read pinned update baseline");
const workspace = mkdtempSync(path.join(tmpdir(), "quatmo-env-parity-"));
const safeEnv = {
  NODE_ENV: "production", PORT: "43127", MAX_REQUEST_BODY_BYTES: "1234567",
  PROXY_API_KEY: "fixture-proxy-key-for-env-parity-only-0123456789",
  JWT_SECRET: "fixture-jwt-secret-for-env-parity-only-0123456789",
  ADMIN_USERNAME: "fixture-admin", ADMIN_PASSWORD: "fixture-password-only",
  CORS_ORIGINS: "https://probe.example.test", IEM_WEIGHT_MODE: "nominal",
};
const cases = [
  { name: "container-env", env: safeEnv, file: {}, autoEnv: false },
  { name: "dotenv-file", env: {}, file: safeEnv, autoEnv: false },
  { name: "env-over-dotenv", env: safeEnv, file: { ...safeEnv, PORT: "43128", ADMIN_USERNAME: "file-admin", IEM_WEIGHT_MODE: "calibrated" }, autoEnv: false },
  { name: "bun-auto-env", env: {}, file: safeEnv, autoEnv: true },
  { name: "fallback-defaults", env: { NODE_ENV: "test" }, file: {}, autoEnv: false },
  { name: "reject-insecure-production", env: { ...safeEnv, JWT_SECRET: "123" }, file: {}, autoEnv: false, rejected: true },
];
for (const scenario of cases) {
  const outcomes: any[] = [];
  for (const version of ["baseline", "current"]) {
    const directory = path.join(workspace, `${scenario.name}-${version}`);
    cpSync(path.join(root, "src"), path.join(directory, "src"), { recursive: true });
    cpSync(path.join(root, "package.json"), path.join(directory, "package.json"));
    cpSync(path.join(root, "tests/setup/envProbe.ts"), path.join(directory, "probe.ts"));
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    if (version === "baseline") {
      writeFileSync(path.join(directory, "src/routes/admin.ts"), baselineAdmin.stdout);
      writeFileSync(path.join(directory, "src/routes/auth.ts"), baselineUserAuth.stdout);
      writeFileSync(path.join(directory, "src/routes/sessionAuth.ts"), baselineSessionAuth.stdout);
      writeFileSync(path.join(directory, "src/routes/chat.ts"), baselineChat.stdout);
      writeFileSync(path.join(directory, "src/routes/update.ts"), baselineUpdate.stdout);
    }
    writeFileSync(path.join(directory, ".env"), Object.entries(scenario.file).map(([key, value]) => `${key}=${value}`).join("\n"));
    const result = Bun.spawnSync({
      cmd: [process.execPath, ...(scenario.autoEnv ? [] : ["--no-env-file"]), "probe.ts"],
      cwd: directory,
      env: { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TEMP: tmpdir(), ...scenario.env },
      timeout: 15000,
    });
    if (scenario.rejected) {
      assert.equal(result.exitCode, 1, `${version}: insecure production config was not rejected`);
      continue;
    }
    assert.equal(result.exitCode, 0, `${scenario.name}/${version}: ${result.stderr.toString().slice(-1200)}`);
    const line = result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("ENV_PROBE:"));
    assert.ok(line, `${scenario.name}/${version}: no probe output`);
    const actual = JSON.parse(line.slice("ENV_PROBE:".length));
    if (scenario.name !== "dotenv-file") {
      assert.equal(actual.proxyMatchesEnv, true);
      assert.equal(actual.jwtMatchesEnv, true);
    }
    assert.equal(actual.adminPasswordMatches, true);
    assert.equal(actual.deniedStatus, 401);
    assert.equal(actual.healthStatus, 200);
    assert.equal(actual.forbiddenCorsOrigin, null);
    if (scenario.name !== "fallback-defaults") {
      assert.equal(actual.port, 43127);
      assert.equal(actual.maxRequestBodySize, 1234567);
      assert.equal(actual.admin, "fixture-admin");
      assert.equal(actual.corsOrigin, "https://probe.example.test");
      if (scenario.name !== "dotenv-file") assert.equal(actual.keySource, "env");
    } else {
      assert.equal(actual.port, 3000);
      assert.equal(actual.maxRequestBodySize, 110 * 1024 * 1024);
      assert.equal(actual.keySource, "generated");
    }
    outcomes.push(actual);
  }
  if (!scenario.rejected) assert.deepEqual(outcomes[0], outcomes[1], `${scenario.name}: ENV behavior differs from baseline`);
  console.log(`PASS: ${scenario.name} (baseline/current)`);
  if (scenario.name === "dotenv-file") {
    console.log(`Existing dotenv-only initialization: keySource=${outcomes[0].keySource}, proxyMatchesEnv=${outcomes[0].proxyMatchesEnv}, jwtMatchesEnv=${outcomes[0].jwtMatchesEnv}`);
  }
}
console.log(`ENV parity verified in 12 isolated processes. Fixtures retained at ${workspace}`);
