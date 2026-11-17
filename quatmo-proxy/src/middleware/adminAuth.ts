import { verify } from "hono/jwt";
import { safeEqual } from "../services/security";
import { getProxyApiKey } from "../services/proxyKey";
import { getJwtSecret } from "../services/jwtKey";
import { lecturerAccounts, sessions } from "../services/sessionStore";
import { requireCaller } from "../shared/http/adminCaller";

const ADMIN_LOGIN_PATHS = new Set(["/admin/login", "/v1/admin/login"]);

export async function authenticateAdmin(c: any, next: any) {
  // Only the exact login routes are public. Never match on the raw URL/query string
  // (e.g. "/admin/lecturers?x=/login" used to bypass authentication).
  if (c.req.method === "OPTIONS" || ADMIN_LOGIN_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const masterKey = getProxyApiKey();
  const xApiKey = (c.req.header("x-api-key") || "").trim();
  const authHeader = c.req.header("Authorization");

  if (xApiKey && !safeEqual(xApiKey, masterKey)) {
    return c.json({ error: "Unauthorized. Invalid Proxy API Key" }, 401);
  }

  let caller: { username: string; role: string; name: string } | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (safeEqual(token, masterKey)) {
      caller = { username: "admin", role: "admin", name: "Super Admin" };
    } else {
      try {
        const decoded: any = await verify(
          token,
          getJwtSecret(),
          "HS256" as any,
        );
        // Only tokens minted by /admin/login are accepted: explicit role + username,
        // and never student/session tokens (which share the same signing secret).
        if (
          decoded &&
          (decoded.role === "admin" || decoded.role === "lecturer") &&
          typeof decoded.username === "string" &&
          decoded.username &&
          !decoded.studentId &&
          !decoded.sessionCode
        ) {
          if (decoded.role === "lecturer") {
            const lec = lecturerAccounts.get(decoded.username);
            if (!lec || lec.status === "inactive") {
              return c.json(
                { error: "Lecturer account is inactive or no longer exists." },
                401,
              );
            }
          }
          caller = {
            username: decoded.username,
            role: decoded.role,
            name: decoded.name || decoded.username,
          };
        }
      } catch {
        // JWT verification failed
      }

      // A Bearer token was present but invalid or expired.
      // NEVER fall back to admin identity via x-api-key when a token was provided —
      // this would silently promote a lecturer's expired session into admin and corrupt
      // data isolation (createdBy field gets stamped as "admin" instead of the lecturer).
      if (!caller) {
        return c.json(
          {
            error:
              "Unauthorized. Session expired or invalid token. Please sign in again.",
          },
          401,
        );
      }
    }
  } else if (xApiKey && safeEqual(xApiKey, masterKey)) {
    // Pure API-key-only access (no Bearer token): for server-to-server scripts or curl.
    caller = { username: "admin", role: "admin", name: "Super Admin" };
  }

  if (caller) {
    c.set("caller", caller);
    await next();
    return;
  }

  return c.json({ error: "Unauthorized. Invalid Token or Proxy API Key" }, 401);
}

export const requireSuperAdmin = async (c: any, next: any) => {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }
  await next();
};

/** Lecturers may only touch sessions they created; super admin may touch all. */
export const requireSessionOwner = async (c: any, next: any) => {
  const caller = requireCaller(c);
  if (caller.role === "admin") {
    await next();
    return;
  }
  const code = String(c.req.param("sessionCode") || "").toUpperCase();
  const session = sessions.get(code);
  const owner = (session?.createdBy || "admin").toLowerCase();
  if (!session || owner !== caller.username.toLowerCase()) {
    return c.json({ error: "Forbidden. You do not own this session." }, 403);
  }
  await next();
};
