import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { getJwtSecret } from "../services/jwtKey";
import { studentAccounts } from "../services/sessionStore";

declare const Bun: any;

const authRouter = new Hono();

// POST /auth/login — Global account login (studentId + password only, no session required)
authRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const { studentId: rawStudentId, password } = body as {
    studentId?: string;
    password?: string;
  };

  if (!rawStudentId || !password) {
    return c.json(
      { error: "Missing required fields: studentId, password" },
      400,
    );
  }

  const studentId = rawStudentId.trim().toUpperCase();

  const account = studentAccounts.get(studentId);
  if (!account) {
    return c.json(
      { error: "Student account does not exist." },
      403,
    );
  }

  const isPasswordValid = await Bun.password.verify(
    password,
    account.passwordHash,
  );
  if (!isPasswordValid) {
    return c.json({ error: "Incorrect password." }, 403);
  }

  const jwtSecret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);

  // User token: valid for 7 days (persistent login)
  const exp = now + 7 * 24 * 60 * 60;
  const payload = {
    studentId,
    type: "user",
    iat: now,
    exp,
  };

  const token = await sign(payload, jwtSecret);

  return c.json({
    success: true,
    token,
    studentId,
  });
});

// GET /auth/me — Verify user token and return account info
authRouter.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid token" }, 401);
  }

  const token = authHeader.substring(7).trim();
  const jwtSecret = getJwtSecret();

  let payload: any;
  try {
    payload = await verify(token, jwtSecret, "HS256" as any);
  } catch {
    return c.json({ error: "Invalid or expired token." }, 401);
  }

  if (payload.type !== "user") {
    return c.json({ error: "Token is not a valid user token." }, 401);
  }

  const account = studentAccounts.get(payload.studentId);
  if (!account) {
    return c.json({ error: "Account no longer exists." }, 404);
  }

  return c.json({
    success: true,
    studentId: payload.studentId,
  });
});

export { authRouter };
