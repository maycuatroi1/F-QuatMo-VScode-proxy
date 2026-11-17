export const MAX_UPLOAD_FILES = parseInt(process.env.MAX_UPLOAD_FILES || "5000", 10);
export const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES || String(100 * 1024 * 1024),
  10,
);
