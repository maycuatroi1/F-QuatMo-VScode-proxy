import { randomBytes } from "crypto";

let jwtSecret = process.env.JWT_SECRET?.trim();

if (!jwtSecret) {
  jwtSecret = randomBytes(32).toString("hex");
  console.warn(
    `\x1b[33m[Auth]\x1b[0m JWT_SECRET is not configured in .env. Generated a secure random secret key for this session.`
  );
}

export function getJwtSecret(): string {
  return jwtSecret!;
}
