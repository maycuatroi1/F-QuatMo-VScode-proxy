import { isAllowedReleaseUrl } from "../../services/security";
import { currentRelease, getLatestRelease, saveReleaseManifest } from "./store";
import { isSuperAdminRequest } from "./httpHelpers";
import type { UpdateType, ReleaseManifest } from "./types";

let lastForcedSync = 0;

export async function syncReleaseFromS3(c: any) {
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
}

export async function publishRelease(c: any) {
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
}
