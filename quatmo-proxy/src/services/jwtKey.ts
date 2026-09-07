import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

let jwtSecret = process.env.JWT_SECRET?.trim();

if (!jwtSecret) {
  const secretFilePath = path.resolve(process.cwd(), "logs", "jwt_secret.key");
  try {
    if (fs.existsSync(secretFilePath)) {
      jwtSecret = fs.readFileSync(secretFilePath, "utf8").trim();
    }
  } catch {}

  if (!jwtSecret) {
    jwtSecret = randomBytes(32).toString("hex");
    try {
      const logsDir = path.dirname(secretFilePath);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.writeFileSync(secretFilePath, jwtSecret, "utf8");
    } catch {}
  }
}

export function getJwtSecret(): string {
  return jwtSecret!;
}
