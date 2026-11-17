import { verify } from "hono/jwt";
import { redis } from "../../services/redis";
import { getJwtSecret } from "../../services/jwtKey";
import { sessions, sessionStates } from "../../services/sessionStore";

export async function getSessionStatus(c: any) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const jwtSecret = getJwtSecret();
  let payload: any;
  try {
    payload = await verify(token, jwtSecret, "HS256" as any);
  } catch (err) {
    return c.json({ error: "Invalid or expired token." }, 401);
  }

  const { studentId, sessionCode } = payload;
  const session = sessions.get(sessionCode);
  if (!session) {
    return c.json({ error: "Session does not exist." }, 404);
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);
  if (!state) {
    return c.json({ error: "Student session state not found." }, 404);
  }

  let consumed = state.tokensConsumed;
  if (redis && redis.status === "ready") {
    try {
      const val = await redis.hget(
        `session:user:${sessionCode}:${studentId}`,
        "consumed",
      );
      if (val !== null) {
        consumed = parseInt(val, 10);
      }
    } catch {
      // fallback
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionEndTime =
    session.durationMinutes === -1
      ? session.startTime + 24 * 60 * 60
      : session.startTime + session.durationMinutes * 60;
  const aiExpirationTime =
    session.aiValidityMinutes === -1
      ? payload.loginTime + 24 * 60 * 60
      : payload.loginTime + session.aiValidityMinutes * 60;
  const sessionRemainingSeconds = Math.max(0, sessionEndTime - now);
  const aiRemainingSeconds = Math.max(0, aiExpirationTime - now);

  return c.json({
    success: true,
    studentId,
    sessionCode,
    aiOption: session.aiOption,
    tokenBudget: session.defaultTokenBudget,
    tokensConsumed: consumed,
    tokensRemaining: Math.max(0, session.defaultTokenBudget - consumed),
    sessionRemainingMinutes:
      session.durationMinutes === -1
        ? -1
        : Math.ceil(sessionRemainingSeconds / 60),
    aiRemainingMinutes:
      session.aiValidityMinutes === -1
        ? -1
        : Math.ceil(aiRemainingSeconds / 60),
    runtimeConfig: session.runtimeConfig,
  });
}
