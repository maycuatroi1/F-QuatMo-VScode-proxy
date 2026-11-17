import { s3Storage } from "../../services/s3Storage";

export async function getStorageStatus(c: any) {
  const isAvailable = s3Storage.isAvailable();
  if (!isAvailable) {
    return c.json({
      status: "unconfigured",
      available: false,
      message: "S3 credentials are not configured in .env",
      endpoint: process.env.S3_ENDPOINT || "https://s3-api.iahn.hanoi.vn",
      bucket: s3Storage.getBucketName(),
    });
  }

  try {
    const sessions = await s3Storage.listSessionsFromS3();
    const guests = await s3Storage.listGuestsFromS3();
    return c.json({
      status: "connected",
      available: true,
      endpoint: process.env.S3_ENDPOINT,
      bucket: s3Storage.getBucketName(),
      totalSessionsOnS3: sessions.length,
      sessions,
      totalGuestsOnS3: guests.length,
      guests,
    });
  } catch (err: any) {
    return c.json(
      {
        status: "error",
        available: false,
        error: err?.message || String(err),
      },
      500,
    );
  }
}
