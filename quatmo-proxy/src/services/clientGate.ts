/**
 * clientGate.ts — Client version & build-checksum gate.
 *
 * Decides whether a Fvscode client is allowed to use protected proxy features
 * (session login, chat) based on the identity headers it sends:
 *
 *   X-Client-Version            product.json "version"            (e.g. 1.95.4)
 *   X-Client-Commit             product.json "commit"
 *   X-Client-Build-Hash         sha256 of <appRoot>/out/main.js
 *   X-Client-Extension-Version  quatmo-code package.json "version"
 *
 * Clients released before this feature send none of these headers, so they are
 * reported as "missing_identity" and are blocked once CLIENT_GATE_MODE=enforce.
 *
 * Configuration (env):
 *   CLIENT_GATE_MODE              off | warn | enforce          (default: warn)
 *   CLIENT_MIN_VERSION            minimum app version, e.g. 1.95.4
 *   CLIENT_REQUIRE_LATEST         true => minimum = latest installer/patch release
 *   CLIENT_MIN_EXTENSION_VERSION  minimum quatmo-code extension version
 *   CLIENT_REQUIRE_BUILD_HASH     true => clients on the latest version must send
 *                                 a build hash equal to the published buildHash
 *   CLIENT_GATE_EXEMPT_VERIFIED_SESSIONS  true (default) => chat requests carrying a
 *                                 session token that was issued to a verified client
 *                                 are not re-checked (no mid-exam disruption)
 *
 * A release manifest published with "mandatory": true also raises the minimum
 * version to that release's version.
 */

import fs from "fs";
import path from "path";

export type GateMode = "off" | "warn" | "enforce";
export type GateStatus =
  | "ok"
  | "missing_identity"
  | "outdated"
  | "extension_outdated"
  | "checksum_mismatch";

export interface ClientIdentity {
  version: string;
  commit: string;
  buildHash: string;
  extensionVersion: string;
}

export interface AppReleaseState {
  version: string;
  commit?: string;
  buildHash?: string;
  mandatory?: boolean;
  releasedAt?: string;
  downloadUrl?: string;
  updateType?: string;
  sha256hash?: string;
  filename?: string;
  sizeMB?: number;
  sizeBytes?: number;
  /** Publisher Ed25519 signature, forwarded untouched so clients can verify it. */
  signature?: string;
}

export interface ExtensionReleaseState {
  id?: string;
  version: string;
  mandatory?: boolean;
}

interface GateState {
  app?: AppReleaseState;
  extension?: ExtensionReleaseState;
}

export interface GateEvaluation {
  status: GateStatus;
  allowed: boolean;
  mode: GateMode;
  reason: string;
  minVersion?: string;
  minExtensionVersion?: string;
  latest?: AppReleaseState;
}

// Persisted in the logs/ volume so it survives container rebuilds. It only holds
// public release metadata (version, commit, build hash).
const STATE_PATH =
  process.env.CLIENT_GATE_STATE_PATH ||
  path.resolve(process.cwd(), "logs", "client_gate_state.json");

let state: GateState = {};
try {
  if (fs.existsSync(STATE_PATH)) {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) || {};
  }
} catch (err) {
  console.warn("[ClientGate] Could not read client_gate_state.json:", err);
  state = {};
}

function persistState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("[ClientGate] Failed to persist gate state:", err);
  }
}

// ─── Version helpers ────────────────────────────────────────────────────────

const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && VERSION_RE.test(v.trim());
}

/** Numeric dotted-version compare. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(".").map((n) => parseInt(n, 10));
  const pb = b.trim().split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function maxVersion(...versions: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    if (!isValidVersion(v)) continue;
    if (!best || compareVersions(v, best) > 0) best = v.trim();
  }
  return best;
}

// ─── Release observation (called by update.ts whenever the manifest changes) ─

export function observeRelease(manifest: any): void {
  if (!manifest || !isValidVersion(manifest.version)) return;
  const type = String(manifest.updateType || "installer").toLowerCase();

  if (type === "installer" || type === "patch") {
    const buildHash =
      typeof manifest.buildHash === "string" &&
      HASH_RE.test(manifest.buildHash.trim().toLowerCase())
        ? manifest.buildHash.trim().toLowerCase()
        : undefined;
    const next: AppReleaseState = {
      version: manifest.version.trim(),
      commit: typeof manifest.commit === "string" ? manifest.commit.trim().toLowerCase() : undefined,
      buildHash,
      mandatory: Boolean(manifest.mandatory),
      releasedAt: manifest.releasedAt,
      downloadUrl: manifest.downloadUrl,
      updateType: type,
      sha256hash:
        typeof manifest.sha256hash === "string" && HASH_RE.test(manifest.sha256hash.trim().toLowerCase())
          ? manifest.sha256hash.trim().toLowerCase()
          : undefined,
      filename: typeof manifest.filename === "string" ? manifest.filename : undefined,
      sizeMB: typeof manifest.sizeMB === "number" ? manifest.sizeMB : undefined,
      sizeBytes: typeof manifest.sizeBytes === "number" ? manifest.sizeBytes : undefined,
      signature: typeof manifest.signature === "string" ? manifest.signature : undefined,
    };
    const prev = state.app;
    // Never move the "latest app" pointer backwards.
    if (prev && compareVersions(next.version, prev.version) < 0) return;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      state.app = next;
      persistState();
      console.log(
        `[ClientGate] Latest app release is now v${next.version}${next.mandatory ? " (mandatory)" : ""}`,
      );
    }
    return;
  }

  if (type === "extension") {
    const version = isValidVersion(manifest.extensionVersion)
      ? manifest.extensionVersion.trim()
      : manifest.version.trim();
    const next: ExtensionReleaseState = {
      id: manifest.targetExtensionId || "quatmo-code",
      version,
      mandatory: Boolean(manifest.mandatory),
    };
    const prev = state.extension;
    if (prev && compareVersions(next.version, prev.version) < 0) return;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      state.extension = next;
      persistState();
    }
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

export function getGateMode(): GateMode {
  const raw = (process.env.CLIENT_GATE_MODE || "warn").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "warn";
}

export function exemptVerifiedSessions(): boolean {
  return (process.env.CLIENT_GATE_EXEMPT_VERIFIED_SESSIONS || "true").trim().toLowerCase() !== "false";
}

function getRequirements(): {
  minVersion?: string;
  minExtensionVersion?: string;
  requireHash: boolean;
} {
  const requireLatest =
    (process.env.CLIENT_REQUIRE_LATEST || "").trim().toLowerCase() === "true";
  const app = state.app;
  const minVersion = maxVersion(
    process.env.CLIENT_MIN_VERSION,
    app && (requireLatest || app.mandatory) ? app.version : undefined,
  );
  const ext = state.extension;
  const minExtensionVersion = maxVersion(
    process.env.CLIENT_MIN_EXTENSION_VERSION,
    ext && ext.mandatory ? ext.version : undefined,
  );
  const requireHash =
    (process.env.CLIENT_REQUIRE_BUILD_HASH || "").trim().toLowerCase() === "true";
  return { minVersion, minExtensionVersion, requireHash };
}

export function getLatestAppRelease(): AppReleaseState | undefined {
  return state.app ? { ...state.app } : undefined;
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export function readClientIdentity(
  header: (name: string) => string | undefined,
): ClientIdentity {
  const clean = (v: string | undefined, max: number) =>
    (v || "").trim().slice(0, max);
  return {
    version: clean(header("x-client-version"), 32),
    commit: clean(header("x-client-commit"), 64).toLowerCase(),
    buildHash: clean(header("x-client-build-hash"), 64).toLowerCase(),
    extensionVersion: clean(header("x-client-extension-version"), 32),
  };
}

export function evaluateClient(identity: ClientIdentity): GateEvaluation {
  const mode = getGateMode();
  const { minVersion, minExtensionVersion, requireHash } = getRequirements();
  const latest = getLatestAppRelease();
  const base = { mode, minVersion, minExtensionVersion, latest };

  const result = (status: GateStatus, reason: string): GateEvaluation => ({
    ...base,
    status,
    reason,
    allowed: status === "ok" || mode !== "enforce",
  });

  if (!isValidVersion(identity.version)) {
    return result(
      "missing_identity",
      "Client did not send a valid X-Client-Version (build released before the version gate).",
    );
  }

  if (minVersion && compareVersions(identity.version, minVersion) < 0) {
    return result(
      "outdated",
      `Client v${identity.version} is older than the required v${minVersion}.`,
    );
  }

  if (minExtensionVersion) {
    if (
      !isValidVersion(identity.extensionVersion) ||
      compareVersions(identity.extensionVersion, minExtensionVersion) < 0
    ) {
      return result(
        "extension_outdated",
        `Extension v${identity.extensionVersion || "unknown"} is older than the required v${minExtensionVersion}.`,
      );
    }
  }

  // Build checksum: only meaningful when the client claims to be exactly the
  // latest published app version and that release carries a buildHash.
  if (latest && compareVersions(identity.version, latest.version) === 0) {
    if (latest.buildHash) {
      if (!identity.buildHash) {
        if (requireHash) {
          return result("checksum_mismatch", "Client did not send X-Client-Build-Hash.");
        }
      } else if (identity.buildHash !== latest.buildHash) {
        if (requireHash) {
          return result(
            "checksum_mismatch",
            "Client build checksum does not match the published build.",
          );
        }
        logOnce(
          `hash:${identity.version}:${identity.buildHash}`,
          `[ClientGate] Build hash mismatch for v${identity.version} (not enforced; set CLIENT_REQUIRE_BUILD_HASH=true to enforce).`,
        );
      }
    }
    if (latest.commit && identity.commit && identity.commit !== latest.commit) {
      logOnce(
        `commit:${identity.version}:${identity.commit}`,
        `[ClientGate] Commit mismatch for v${identity.version}: client=${identity.commit} latest=${latest.commit}`,
      );
    }
  }

  return result("ok", "Client is up to date.");
}

// ─── User-facing messages ───────────────────────────────────────────────────

export function blockMessage(evaluation: GateEvaluation): string {
  const need = evaluation.minVersion ? ` (yêu cầu v${evaluation.minVersion} / required v${evaluation.minVersion})` : "";
  switch (evaluation.status) {
    case "checksum_mismatch":
      return `Bản cài Fvscode không khớp checksum phiên bản chính thức. Vui lòng cài lại bản mới nhất. / Fvscode build checksum mismatch. Please reinstall the latest version.`;
    case "extension_outdated":
      return `Extension Quạt Mo đã cũ. Vui lòng cập nhật Fvscode${need}. / Quat Mo extension is outdated. Please update Fvscode.`;
    default:
      return `Phiên bản Fvscode đã cũ, vui lòng cập nhật bản mới nhất để tiếp tục${need}. Mở Command Palette > "Quatmo: Check for Updates". / Fvscode is outdated. Please update to continue.`;
  }
}

// ─── Rate-limited logging ───────────────────────────────────────────────────

const loggedAt = new Map<string, number>();
const LOG_INTERVAL_MS = 10 * 60 * 1000;

export function logOnce(key: string, message: string): void {
  const now = Date.now();
  const last = loggedAt.get(key) || 0;
  if (now - last < LOG_INTERVAL_MS) return;
  loggedAt.set(key, now);
  if (loggedAt.size > 5000) loggedAt.clear();
  console.warn(message);
}
