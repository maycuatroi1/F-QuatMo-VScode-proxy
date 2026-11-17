import path from "path";
import { s3Storage } from "../../services/s3Storage";
import { getLatestAppRelease } from "../../services/clientGate";
import { getLatestRelease } from "./store";
import { publicBase } from "./httpHelpers";
import type { ReleaseManifest } from "./types";

export async function resolveNativeUpdate(c: any) {
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
}

export async function getPublicRelease(c: any) {
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
}

export async function getAdminRelease(c: any) {
  const release = await getLatestRelease();
  return c.json({
    success: true,
    release,
    s3Enabled: s3Storage.isAvailable(),
  });
}
