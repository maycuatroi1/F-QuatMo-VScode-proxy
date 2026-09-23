/**
 * security.ts — shared hardening helpers (constant-time compare, trusted client IP,
 * release URL allowlist, startup secret checks, zip-bomb safe reading, upload paths).
 */
import crypto from "crypto";
import path from "path";

// ─── Constant-time string compare ───────────────────────────────────────────
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

// ─── Client IP behind reverse proxies ───────────────────────────────────────
/**
 * TRUSTED_PROXY_HOPS = number of reverse proxies in front of this server that
 * APPEND to X-Forwarded-For (e.g. 2 for "pve01 traefik -> Dokploy traefik").
 * The client IP is then the N-th entry from the right, which the client cannot forge.
 * If unset, the legacy behaviour (left-most X-Forwarded-For) is kept.
 */
export function getTrustedClientIP(header: (name: string) => string | undefined): string {
  const xff = header("x-forwarded-for");
  const hopsRaw = process.env.TRUSTED_PROXY_HOPS;
  const hops = hopsRaw !== undefined && hopsRaw.trim() !== "" ? parseInt(hopsRaw, 10) : NaN;

  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      if (!isNaN(hops) && hops > 0) {
        const idx = Math.max(0, parts.length - hops);
        return parts[idx];
      }
      return parts[0];
    }
  }
  const realIp = header("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

// ─── Release download URL allowlist ─────────────────────────────────────────
function allowedReleaseHosts(): string[] {
  const raw =
    process.env.RELEASE_ALLOWED_HOSTS ||
    "fvscode-proxy.iahn.hanoi.vn,s3-api.iahn.hanoi.vn";
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Accepts only https:// URLs on an allowlisted host, or a relative "/..." path
 * (resolved against this proxy). Blocks javascript:, data:, http:// and foreign hosts.
 */
export function isAllowedReleaseUrl(url: unknown): boolean {
  if (url === undefined || url === null || url === "") return true; // "use default"
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (u.startsWith("/") && !u.startsWith("//")) return true;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) {
      return process.env.NODE_ENV !== "production";
    }
    if (parsed.protocol !== "https:") return false;
    return allowedReleaseHosts().includes(host);
  } catch {
    return false;
  }
}

// ─── Startup secret validation ──────────────────────────────────────────────
// Values that were committed to git (docker-compose.yml / .env) and must be treated as public.
const LEAKED_SECRETS = new Set([
  "123",
  "123456789",
  "super_secret_jwt_signing_key_for_quatmo_proxy_2026",
  "fpt_university_fvscode_signing_secret_2026_super_secure",
]);

export function validateSecretsAtStartup(): void {
  const problems: string[] = [];
  const warnings: string[] = [];
  const check = (name: string, minLen: number, required: boolean) => {
    const v = (process.env[name] || "").trim();
    if (!v) {
      if (required) warnings.push(`${name} is empty`);
      return;
    }
    if (LEAKED_SECRETS.has(v)) problems.push(`${name} uses a value that was committed to git (leaked)`);
    else if (v.length < minLen) warnings.push(`${name} is shorter than ${minLen} characters`);
  };
  check("PROXY_API_KEY", 32, false);
  check("ADMIN_PASSWORD", 12, true);
  check("JWT_SECRET", 32, false);
  check("BUILD_SIGNING_SECRET", 32, false);
  check("LOG_ENCRYPT_KEY", 32, false);

  for (const w of warnings) console.warn(`[Security] WARNING: ${w}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[Security] FATAL: ${p}`);
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_SECRETS !== "true") {
      console.error("[Security] Refusing to start in production with leaked secrets. Rotate them first.");
      process.exit(1);
    }
  }
}

export function maskSecret(v: string): string {
  if (!v) return "(empty)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}****${v.slice(-2)}`;
}

// ─── Zip-bomb safe reading (adm-zip) ────────────────────────────────────────
const MAX_ZIP_ENTRIES = parseInt(process.env.MAX_ZIP_ENTRIES || "5000", 10);
const MAX_ZIP_UNCOMPRESSED = parseInt(
  process.env.MAX_ZIP_UNCOMPRESSED_BYTES || String(50 * 1024 * 1024),
  10,
);
/** Maximum uncompressed/compressed ratio for entries above 1MB (zip-bomb heuristic). */
const MAX_ZIP_RATIO = 200;

/**
 * Reads text entries of an AdmZip archive with limits on entry count and total
 * declared uncompressed size. Oversized archives are skipped (returns {}).
 */
export function readZipTextEntriesSafely(zip: any): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) return out;
  // Pass 1: declared sizes and compression ratio (the header is attacker-controlled,
  // so pass 2 also accounts for the bytes actually produced).
  let declared = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const size = Number(entry.header?.size ?? 0);
    const compressed = Math.max(1, Number(entry.header?.compressedSize ?? 0));
    declared += size;
    if (declared > MAX_ZIP_UNCOMPRESSED) return {};
    if (size > 1024 * 1024 && size / compressed > MAX_ZIP_RATIO) return {};
  }
  let actual = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const data: Buffer = entry.getData();
    actual += data.length;
    if (actual > MAX_ZIP_UNCOMPRESSED) return {};
    out[String(entry.entryName).replace(/\\/g, "/")] = data.toString("utf-8");
  }
  return out;
}

// ─── Upload path containment ────────────────────────────────────────────────
/**
 * Resolves a client-supplied relative path inside baseDir. Returns null for
 * absolute paths, ".." segments, NUL bytes or anything escaping baseDir.
 */
export function resolveInside(baseDir: string, relativePath: string): string | null {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) return null;
  const unified = relativePath.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const segments = unified.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  if (!target.startsWith(base + path.sep)) return null;
  return target;
}

export function normalizeUploadRelPath(relativePath: string): string | null {
  const resolved = resolveInside("/__base__", relativePath);
  if (!resolved) return null;
  return path.relative("/__base__", resolved).split(path.sep).join("/");
}
