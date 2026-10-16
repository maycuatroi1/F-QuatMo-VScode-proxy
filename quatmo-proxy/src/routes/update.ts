/**
 * @file update.ts
 * @description Release management and software distribution gateway for FPT University Code (Fvscode).
 * Exposes endpoints for client update resolution, binary and asset streaming from local disk or S3,
 * and administrative release publication across installer, patch, extension, and policy channels.
 */

import { Hono } from "hono";
import path from "path";
import fs from "fs";
import { s3Storage } from "../services/s3Storage";
import { getLatestAppRelease, observeRelease } from "../services/clientGate";
import { verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import { getProxyApiKey } from "../services/proxyKey";
import { isAllowedReleaseUrl, safeEqual } from "../services/security";

/** Super-admin check for release publication (master key or admin JWT). */
async function isSuperAdminRequest(c: any): Promise<boolean> {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
  const xApiKey = (c.req.header("x-api-key") || "").trim();
  const master = getProxyApiKey();
  if ((token && safeEqual(token, master)) || (xApiKey && safeEqual(xApiKey, master))) {
    return true;
  }
  if (!token) return false;
  try {
    const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
    return Boolean(payload && payload.role === "admin" && payload.username && !payload.studentId);
  } catch {
    return false;
  }
}

/** Public base URL used to build download links (never trust the Host header in prod). */
function publicBase(c: any): string {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = c.req.header("host") || "localhost:3000";
  const proto =
    c.req.header("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Drops download URLs that are not https on an allowlisted host. */
function sanitizeManifestUrls<T extends { downloadUrl?: string; cdnUrl?: string }>(m: T): T {
  const out: any = { ...m };
  if (!isAllowedReleaseUrl(out.downloadUrl)) {
    console.error(`[UpdateRouter] Rejected non-allowlisted downloadUrl: ${out.downloadUrl}`);
    out.downloadUrl = "";
  }
  if (!isAllowedReleaseUrl(out.cdnUrl)) {
    console.error(`[UpdateRouter] Rejected non-allowlisted cdnUrl: ${out.cdnUrl}`);
    out.cdnUrl = undefined;
  }
  return out;
}

/**
 * Supported software update and configuration distribution channels.
 */
export type UpdateType = "installer" | "patch" | "extension" | "policy";

/**
 * Canonical release manifest data structure.
 */
export interface ReleaseManifest {
  /** Target software version (semver compliant). */
  version: string;
  /** Git commit hash corresponding to the release artifact. */
  commit: string;
  /** Distribution channel classification. */
  updateType?: UpdateType;
  /** Human-readable release display name. */
  name?: string;
  /** Product branding version string. */
  productVersion?: string;
  /** Primary artifact file name. */
  filename?: string;
  /** Object storage key within the releases bucket prefix. */
  s3Key?: string;
  /** Fully-qualified public or proxy-routed artifact download URL. */
  downloadUrl: string;
  /** Optional high-speed CDN or LAN mirror download URL to offload bandwidth from proxy. */
  cdnUrl?: string;
  /** Cryptographic SHA-256 hexadecimal checksum. */
  sha256hash?: string;
  /** SHA-256 of <appRoot>/out/main.js for installer/patch builds (client build checksum). */
  buildHash?: string;
  /** Binary file size in bytes. */
  sizeBytes?: number;
  /** Binary file size in megabytes. */
  sizeMB?: number;
  /** Release changelog or operational notes. */
  notes?: string;
  /** ISO-8601 release timestamp. */
  releasedAt: string;
  /** Enforces mandatory update application prior to workbench execution. */
  mandatory?: boolean;
  /** Target extension identifier when `updateType` is 'extension'. */
  targetExtensionId?: string;
  /** Specific extension version when `updateType` is 'extension'. */
  extensionVersion?: string;
  /** Remote policy payload when `updateType` is 'policy'. */
  policyConfig?: Record<string, any>;
  /** "ed25519:<base64>" publisher signature (scripts/release-signing.mjs). */
  signature?: string;
}

const MANIFEST_PATH = path.resolve(__dirname, "../../release_manifest.json");
const RELEASES_DIR = path.resolve(__dirname, "../../releases");

if (!fs.existsSync(RELEASES_DIR)) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

let currentRelease: ReleaseManifest = {
  version: "1.95.1",
  commit: "0c305f1b8afea035cdb283bef94edb88b7029f98",
  name: "Fvscode 1.95.1",
  productVersion: "1.95.1",
  filename: "Fvscode-UserSetup-x64.exe",
  s3Key: "releases/Fvscode-UserSetup-x64.exe",
  downloadUrl: "http://localhost:3000/v1/releases/Fvscode-UserSetup-x64.exe",
  notes:
    "Phiên bản chuẩn thi cử FPT University: tích hợp hệ thống giám sát thời gian thực và IEM widget.",
  releasedAt: new Date().toISOString(),
  mandatory: false,
};

try {
  if (fs.existsSync(MANIFEST_PATH)) {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    currentRelease = { ...currentRelease, ...JSON.parse(raw) };
  } else {
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify(currentRelease, null, 2),
      "utf8",
    );
  }
} catch (err) {
  console.warn(
    "[UpdateRouter] Could not read local release_manifest.json, using defaults:",
    err,
  );
}
observeRelease(currentRelease);

/**
 * Retrieves the current in-memory release manifest, synchronizing with local disk if available.
 *
 * @returns Active release manifest.
 */
export function getCurrentRelease(): ReleaseManifest {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
      currentRelease = { ...currentRelease, ...JSON.parse(raw) };
    }
  } catch {
    // Retain existing in-memory state on I/O error
  }
  return currentRelease;
}

/**
 * Persists release manifest to disk and updates active in-memory cache.
 *
 * @param manifest Release manifest to persist.
 */
export function saveReleaseManifest(manifest: ReleaseManifest): void {
  currentRelease = { ...manifest };
  observeRelease(currentRelease);
  try {
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify(currentRelease, null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("[UpdateRouter] Failed to persist release manifest:", err);
  }
}

let lastS3CheckTime = 0;
const S3_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Resolves the latest release manifest with optional S3 synchronization.
 *
 * @param forceS3 Forces immediate remote S3 polling bypassing throttling interval.
 * @returns Resolves with the latest active release manifest.
 */
export async function getLatestRelease(
  forceS3 = false,
): Promise<ReleaseManifest> {
  const now = Date.now();

  if (
    s3Storage.isAvailable() &&
    (forceS3 || now - lastS3CheckTime > S3_CHECK_INTERVAL_MS)
  ) {
    lastS3CheckTime = now;
    try {
      const s3Manifest = await s3Storage.getReleaseManifestFromS3();
      if (s3Manifest && s3Manifest.version && s3Manifest.commit) {
        // A signed manifest is authoritative and complete: replace instead of merging,
        // otherwise fields left over from an older release (e.g. targetExtensionId)
        // would leak into it and clients would reject its signature.
        currentRelease = sanitizeManifestUrls(
          s3Manifest.signature
            ? { ...s3Manifest }
            : { ...currentRelease, ...s3Manifest },
        );
        saveReleaseManifest(currentRelease);
        return currentRelease;
      }

      const s3Latest = await s3Storage.findLatestReleaseInS3();
      if (s3Latest) {
        currentRelease.filename = s3Latest.filename;
        currentRelease.s3Key = s3Latest.key;
        currentRelease.sizeBytes = s3Latest.size;
        saveReleaseManifest(currentRelease);
      }
    } catch (err: any) {
      console.warn(
        "[UpdateRouter] S3 release auto-discovery warning:",
        err?.message || err,
      );
    }
  }

  return getCurrentRelease();
}

export const updateRouter = new Hono();

/**
 * Native VS Code client update compatibility endpoint.
 * Conforms to AbstractUpdateService protocol:
 * `GET /v1/api/update/:platform/:quality/:commit`
 *
 * Returns 204 No Content if client is current, or JSON payload with download URL on newer commit.
 */
updateRouter.get("/api/update/:platform/:quality/:commit", async (c) => {
  const { platform, quality, commit } = c.req.param();
  const isBg = c.req.query("bg") === "true";

  const latest = await getLatestRelease();
  // The native updater runs whatever it downloads as an Inno Setup installer, so it
  // must only ever be offered an installer. When the newest manifest is a patch /
  // extension / policy, fall back to the latest installer known to the client gate.
  const gateApp = getLatestAppRelease();
  const release: ReleaseManifest | undefined =
    (latest.updateType || "installer") === "installer"
      ? latest
      : gateApp && gateApp.updateType === "installer"
        ? ({ ...gateApp, downloadUrl: gateApp.downloadUrl || "" } as ReleaseManifest)
        : undefined;

  if (!release || !release.commit) {
    return c.body(null, 204);
  }

  console.log(
    `[UpdateRouter] Check update received - Platform: ${platform}, Quality: ${quality}, Client Commit: ${commit}, Latest Commit: ${release.commit}, Background: ${isBg}`,
  );

  if (commit && commit.toLowerCase() === release.commit.toLowerCase()) {
    console.log(
      `[UpdateRouter] Client ${commit} is up-to-date. Returning 204.`,
    );
    return c.body(null, 204);
  }
  console.log(
    `[UpdateRouter] Update available! Client: ${commit} -> Latest: ${release.commit} (v${release.version})`,
  );

  const filename = path.basename(release.filename || "Fvscode-UserSetup-x64.exe");
  const rawUrl = release.cdnUrl || release.downloadUrl;
  const isLocalOrRelative =
    !rawUrl ||
    rawUrl.startsWith("/") ||
    rawUrl.includes("localhost:") ||
    rawUrl.includes("127.0.0.1:");
  const downloadUrl = isLocalOrRelative
    ? `${publicBase(c)}/v1/releases/${filename}`
    : rawUrl;

  return c.json({
    url: downloadUrl,
    name: release.name || `Fvscode ${release.version}`,
    version: release.commit,
    productVersion: release.productVersion || release.version,
    sha256hash: release.sha256hash,
    notes: release.notes,
    // Signed release metadata verified by Fvscode builds that pin release keys
    // (ignored by older clients).
    quatmoRelease: release.signature
      ? {
          updateType: "installer",
          version: release.version,
          commit: release.commit,
          filename: release.filename,
          sha256hash: release.sha256hash,
          sizeBytes: release.sizeBytes,
          buildHash: release.buildHash,
          releasedAt: release.releasedAt,
          signature: release.signature,
        }
      : undefined,
  });
});

/**
 * Binary artifact streaming endpoint.
 * Serves cached local files from disk or proxies readable streams directly from S3 bucket storage.
 */
updateRouter.get("/releases/:filename", async (c) => {
  const filename = c.req.param("filename");
  const safeFilename = path.basename(filename);
  const localFilePath = path.join(RELEASES_DIR, safeFilename);

  if (fs.existsSync(localFilePath)) {
    const stat = fs.statSync(localFilePath);
    return new Response(Bun.file(localFilePath), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Content-Length": stat.size.toString(),
      },
    });
  }

  if (s3Storage.isAvailable()) {
    console.log(
      `[UpdateRouter] File not local, fetching from S3: releases/${safeFilename}...`,
    );
    const s3Object = await s3Storage.getReleaseStream(safeFilename);
    if (s3Object && s3Object.stream) {
      const headers: Record<string, string> = {
        "Content-Type": s3Object.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
      };
      if (s3Object.contentLength) {
        headers["Content-Length"] = s3Object.contentLength.toString();
      }

      return new Response(s3Object.stream, { headers });
    }
  }

  return c.json({ error: `Artifact ${safeFilename} not found` }, 404);
});

/**
 * Returns current published release details and active S3 repository files for clients.
 */
updateRouter.get("/release/current", async (c) => {
  const release = await getLatestRelease();

  // If a high-speed CDN URL is specified, prioritize it directly.
  // If downloadUrl points to an external CDN/S3 URL, keep it untouched.
  // Only resolve against current proxy host if it is relative or points to a localhost dev instance.
  let downloadUrl = release.cdnUrl || release.downloadUrl;
  const isLocalOrRelative =
    !downloadUrl ||
    downloadUrl.startsWith("/") ||
    downloadUrl.includes("localhost:") ||
    downloadUrl.includes("127.0.0.1:");

  if (isLocalOrRelative) {
    const filename = path.basename(downloadUrl || release.filename || "Fvscode-UserSetup-x64.exe");
    downloadUrl = `${publicBase(c)}/v1/releases/${filename}`;
  }

  const s3Files = await s3Storage.listAllReleaseObjects();

  return c.json({
    success: true,
    release: {
      ...release,
      downloadUrl,
    },
    s3Files,
    s3Enabled: s3Storage.isAvailable(),
  });
});

/**
 * Administrative endpoint returning raw release metadata and S3 availability status.
 */
updateRouter.get("/admin/release/current", async (c) => {
  const release = await getLatestRelease();
  return c.json({
    success: true,
    release,
    s3Enabled: s3Storage.isAvailable(),
  });
});

/**
 * Administrative endpoint to trigger immediate synchronization with the S3 release repository.
 */
let lastForcedSync = 0;
updateRouter.post("/release/sync-s3", async (c) => {
  // Public (called by the admin UI and publish script) but throttled so it cannot
  // be used to hammer S3.
  const now = Date.now();
  const force = now - lastForcedSync > 10_000;
  if (force) lastForcedSync = now;
  const release = await getLatestRelease(force);
  return c.json({
    success: true,
    message: "Synchronized with S3 release repository successfully.",
    release,
  });
});

/**
 * Administrative release publication endpoint.
 * Supports updating metadata for all channels: installer, patch, extension, and policy.
 */
updateRouter.post("/release/set-latest", async (c) => {
  if (!(await isSuperAdminRequest(c))) {
    return c.json({ error: "Unauthorized. Super Admin access required." }, 401);
  }
  try {
    const body = await c.req.json();
    if (!body.version || !body.commit) {
      return c.json({ error: "Missing required fields: version, commit" }, 400);
    }
    if (!isAllowedReleaseUrl(body.downloadUrl)) {
      return c.json({ error: "downloadUrl must be https on an allowlisted host (RELEASE_ALLOWED_HOSTS)." }, 400);
    }
    if (body.sha256hash !== undefined && !/^[a-fA-F0-9]{64}$/.test(String(body.sha256hash).trim())) {
      return c.json({ error: "sha256hash must be a 64-char hex SHA-256." }, 400);
    }

    const updated: ReleaseManifest = {
      version: String(body.version).trim(),
      commit: String(body.commit).trim(),
      updateType:
        (body.updateType as UpdateType) ||
        currentRelease.updateType ||
        "installer",
      name: body.name || `Fvscode ${body.version}`,
      productVersion: body.productVersion || body.version,
      filename:
        body.filename || currentRelease.filename || "Fvscode-UserSetup-x64.exe",
      downloadUrl: body.downloadUrl
        ? String(body.downloadUrl).trim()
        : currentRelease.downloadUrl,
      sha256hash: body.sha256hash?.trim() || currentRelease.sha256hash,
      sizeBytes: body.sizeBytes ?? currentRelease.sizeBytes,
      sizeMB: body.sizeMB ?? currentRelease.sizeMB,
      notes: body.notes || currentRelease.notes || "",
      releasedAt: new Date().toISOString(),
      mandatory: Boolean(body.mandatory),
      targetExtensionId:
        body.targetExtensionId || currentRelease.targetExtensionId,
      extensionVersion:
        body.extensionVersion || currentRelease.extensionVersion,
      policyConfig: body.policyConfig || currentRelease.policyConfig,
    };

    saveReleaseManifest(updated);
    console.log(
      `[UpdateRouter] Published new release: v${updated.version} (${updated.commit}), Type: ${updated.updateType}`,
    );

    return c.json({
      success: true,
      message: `Published ${updated.updateType} release successfully.`,
      release: currentRelease,
    });
  } catch (err: any) {
    console.error("[UpdateRouter] set-latest failed:", err);
    return c.json({ error: "Failed to update release" }, 500);
  }
});
