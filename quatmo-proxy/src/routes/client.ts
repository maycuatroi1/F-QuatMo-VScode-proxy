import { Hono } from "hono";
import path from "path";
import {
  blockMessage,
  evaluateClient,
  getGateMode,
  readClientIdentity,
} from "../services/clientGate";
import { getLatestRelease } from "./update";

/**
 * Public startup handshake used by Fvscode on launch:
 *   GET /v1/client/handshake
 *
 * - Proves the proxy is reachable (connection check).
 * - Tells the client whether its version / build checksum is acceptable.
 * - Returns the latest app release so the client can update.
 *
 * No authentication: it only exposes public release metadata.
 */
const clientRouter = new Hono();

clientRouter.get("/handshake", async (c) => {
  // Refresh the manifest from S3 (throttled inside getLatestRelease).
  await getLatestRelease().catch(() => undefined);

  const identity = readClientIdentity((n) => c.req.header(n));
  const evaluation = evaluateClient(identity);
  const latest = evaluation.latest;

  c.header("Cache-Control", "no-store");
  return c.json({
    ok: evaluation.status === "ok",
    allowed: evaluation.allowed,
    status: evaluation.status,
    mode: getGateMode(),
    message: evaluation.status === "ok" ? "OK" : blockMessage(evaluation),
    serverTime: Date.now(),
    minVersion: evaluation.minVersion || null,
    minExtensionVersion: evaluation.minExtensionVersion || null,
    latest: latest
      ? {
          version: latest.version,
          commit: latest.commit || null,
          buildHash: latest.buildHash || null,
          updateType: latest.updateType || "installer",
          mandatory: Boolean(latest.mandatory),
          // Everything the client needs to apply the update directly.
          // Relative paths are resolved by the client against its configured proxy.
          downloadUrl:
            latest.downloadUrl ||
            (latest.filename ? `/v1/releases/${encodeURIComponent(path.basename(latest.filename))}` : null),
          sha256hash: latest.sha256hash || null,
          filename: latest.filename || null,
          sizeMB: latest.sizeMB ?? null,
          sizeBytes: latest.sizeBytes ?? null,
          releasedAt: latest.releasedAt || null,
          // Clients that pin release keys verify this before downloading.
          signature: latest.signature || null,
        }
      : null,
  });
});

export { clientRouter };
