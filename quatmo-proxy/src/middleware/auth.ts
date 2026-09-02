import type { MiddlewareHandler } from "hono";
import { getProxyApiKey } from "../services/proxyKey";

export interface UserSession {
  keyId: string;
  userId: string;
  monthlyTokenLimit: number;
  tokensConsumed: number;
}

export const authMiddleware = (): MiddlewareHandler<{
  Variables: { user: UserSession; token: string };
}> => {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.substring(7).trim();
    const proxyApiKey = getProxyApiKey();

    let session: UserSession | null = null;

    if (token === proxyApiKey) {
      session = {
        keyId: "master-key-id",
        userId: "master-user",
        monthlyTokenLimit: 999_999_999,
        tokensConsumed: 0,
      };
    } else if (token.startsWith("eyJ")) {
      try {
        const { verify } = await import("hono/jwt");
        const { getJwtSecret } = await import("../services/jwtKey");
        const payload: any = await verify(token, getJwtSecret(), "HS256" as any);
        if (payload && (payload.studentId || payload.userId)) {
          const uid = payload.studentId || payload.userId;
          session = {
            keyId: payload.sessionCode ? `session-${payload.sessionCode}` : `user-${uid}`,
            userId: uid,
            monthlyTokenLimit: 999_999_999,
            tokensConsumed: 0,
          };
        }
      } catch {
        // Invalid JWT
      }
    }

    if (!session) {
      return c.json(
        {
          error:
            "Unauthorized. Provided API key does not match the proxy access key.",
        },
        401,
      );
    }

    // Attach user session to the request context
    c.set("user", session);
    c.set("token", token);
    return await next();
  };
};
