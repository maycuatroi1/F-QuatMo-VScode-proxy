import { verify } from "hono/jwt";
import { getJwtSecret } from "../../services/jwtKey";
import { getProxyApiKey } from "../../services/proxyKey";
import { safeEqual } from "../../services/security";

export async function isSuperAdminRequest(c: any): Promise<boolean> {
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

export function publicBase(c: any): string {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = c.req.header("host") || "localhost:3000";
  const proto =
    c.req.header("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
