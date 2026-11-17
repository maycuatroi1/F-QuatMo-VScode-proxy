import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { observeRelease } from "../../services/clientGate";
import { isAllowedReleaseUrl } from "../../services/security";
import { MANIFEST_PATH, RELEASES_DIR } from "../../config/releasePaths";
import type { ReleaseManifest } from "./types";

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

if (!fs.existsSync(RELEASES_DIR)) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

export let currentRelease: ReleaseManifest = {
  version: "1.97.0",
  commit: "03850501b32ad9986f8649f50b4d937e6292e82d",
  name: "Fvscode 1.97.0",
  productVersion: "1.97.0",
  updateType: "patch",
  filename: "Fvscode-Patch-1.97.0.zip",
  s3Key: "releases/Fvscode-Patch-1.97.0.zip",
  downloadUrl: "https://fvscode-proxy.iahn.hanoi.vn/v1/releases/Fvscode-Patch-1.97.0.zip",
  sha256hash: "a72115a04f8f584f13793c56b9c3904a62c63409189e363075e1bcff7c4666fa",
  sizeBytes: 36469591,
  sizeMB: 34.78,
  buildHash: "b7646fb5eed6c6401786547e9a3f86d1e58c8fecababd6338a1367be70694ae3",
  signature: "ed25519:5jleRInFNIvIZS0820tkTYAyb6mkpr6xQ7l7ZqsoJcMVi7zJZFwJ+yX2MRaBpqe8nvC/2Gkbgs3B+4gSZ3q1DQ==",
  notes: "Bản vá 1.97.0: Fix auto-update freeze, locked file resilience, safe reload UX",
  releasedAt: "2026-11-06T07:01:18.561Z",
  mandatory: true,
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
