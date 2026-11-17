import path from "path";
import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { RELEASES_DIR } from "../../config/releasePaths";

export async function downloadReleaseArtifact(c: any) {
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
}
