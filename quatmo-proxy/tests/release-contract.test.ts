import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
for (const scenario of ["native", "publication"]) {
  test(`release ${scenario}: isolated source/manifest/artifact contract`, () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), "release-fixture-"));
    fs.cpSync(path.join(root, "src"), path.join(directory, "src"), { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
    fs.mkdirSync(path.join(directory, "tests/setup"), { recursive: true });
    for (const name of ["isolation.ts", "releaseProbe.ts"]) fs.copyFileSync(path.join(root, "tests/setup", name), path.join(directory, "tests/setup", name));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    fs.writeFileSync(path.join(directory, ".release-test-fixture"), "synthetic only");
    fs.writeFileSync(path.join(directory, "release_manifest.json"), JSON.stringify({ version: "0.0.1-fixture", commit: "fixture-old", updateType: "installer", filename: "fixture.exe", downloadUrl: "", releasedAt: "2026-01-01T00:00:00Z", mandatory: false, signature: "" }));
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", "./tests/setup/isolation.ts", "./tests/setup/releaseProbe.ts", scenario], {
      cwd: directory, env: { ...process.env, PROXY_RELEASE_ROOT: directory, PUBLIC_BASE_URL: "https://proxy.example.test", RELEASE_ALLOWED_HOSTS: "proxy.example.test,cdn.example.test" }, timeout: 15000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain(`RELEASE_PROBE:${scenario}:PASS`);
  });
}
