import { sign } from "hono/jwt";
import { getAdminUsername, getAdminPassword } from "../../services/adminCredentials";
import { checkLockout, recordFailedAttempt, recordSuccessfulLogin } from "../../services/rateLimiter";
import { safeEqual } from "../../services/security";
import { getJwtSecret } from "../../services/jwtKey";
import { lecturerAccounts } from "../../services/sessionStore";
import { requireCaller } from "../../shared/http/adminCaller";
import { getClientIP } from "../../shared/http/clientIP";

export async function adminLogin(c: any) {
  const body = await c.req.json();
  const { username, password } = body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    return c.json({ error: "Username and password are required." }, 400);
  }

  const inputUser = username.trim();
  const ip = getClientIP(c);

  // Rate limiter & lockout check
  const lockout = await checkLockout(ip, inputUser);
  if (lockout.isLocked) {
    c.header("Retry-After", String(lockout.remainingSeconds));
    c.header("X-RateLimit-Reset", String(lockout.lockedUntil));
    return c.json(
      {
        error: `Too many failed login attempts. Account/IP temporarily locked for security.`,
        retryAfterSeconds: lockout.remainingSeconds,
        lockedUntil: lockout.lockedUntil,
        reason: lockout.reason,
      },
      429,
    );
  }

  const expectedUsername = getAdminUsername();
  const expectedPassword = getAdminPassword();

  // 1. Check Super Admin credentials
  if (
    safeEqual(inputUser, expectedUsername) &&
    safeEqual(password, expectedPassword)
  ) {
    await recordSuccessfulLogin(ip, inputUser);
    const jwtSecret = getJwtSecret();
    const payload = {
      username: "admin",
      role: "admin",
      name: "Super Admin",
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days expiration
    };
    const token = await sign(payload, jwtSecret, "HS256" as any);
    return c.json({
      success: true,
      token,
      username: "admin",
      role: "admin",
      name: "Super Admin",
    });
  }

  // 2. Check Lecturer accounts in SQLite
  const lecturer = lecturerAccounts.get(inputUser);
  if (lecturer) {
    if (lecturer.status === "inactive") {
      return c.json(
        { error: "Your lecturer account has been deactivated." },
        403,
      );
    }

    const isValid = await Bun.password.verify(password, lecturer.passwordHash);
    if (isValid) {
      await recordSuccessfulLogin(ip, inputUser);
      const jwtSecret = getJwtSecret();
      const payload = {
        username: lecturer.username,
        role: "lecturer",
        name: lecturer.name,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days expiration
      };
      const token = await sign(payload, jwtSecret, "HS256" as any);
      return c.json({
        success: true,
        token,
        username: lecturer.username,
        role: "lecturer",
        name: lecturer.name,
      });
    }
  }

  // Failed login attempt
  const result = await recordFailedAttempt(ip, inputUser);
  if (result.isNowLocked && result.lockoutInfo) {
    c.header("Retry-After", String(result.lockoutInfo.remainingSeconds));
    c.header("X-RateLimit-Reset", String(result.lockoutInfo.lockedUntil));
    return c.json(
      {
        error: `Too many failed login attempts. Account/IP temporarily locked for 15 minutes.`,
        retryAfterSeconds: result.lockoutInfo.remainingSeconds,
        lockedUntil: result.lockoutInfo.lockedUntil,
        reason: result.lockoutInfo.reason,
      },
      429,
    );
  }

  return c.json(
    {
      error: `Invalid username or password. (Failed attempts: ${result.attemptsCount}/10)`,
      failedAttempts: result.attemptsCount,
      remainingAttempts: Math.max(0, 10 - result.attemptsCount),
    },
    401,
  );
}

export async function changeAdminPassword(c: any) {
  const caller = requireCaller(c);
  const body = await c.req.json();
  const { currentPassword, newPassword } = body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword || !newPassword.trim()) {
    return c.json(
      { error: "Fields 'currentPassword' and 'newPassword' are required." },
      400,
    );
  }

  if (caller.role === "admin") {
    const expectedPassword = getAdminPassword();
    if (currentPassword !== expectedPassword) {
      return c.json({ error: "Incorrect current password." }, 400);
    }
    process.env.ADMIN_PASSWORD = newPassword.trim();
    return c.json({
      success: true,
      message: "Super Admin password updated successfully.",
    });
  }

  if (caller.role === "lecturer") {
    const lecturer = lecturerAccounts.get(caller.username);
    if (!lecturer) {
      return c.json({ error: "Lecturer account not found." }, 404);
    }

    const isValid = await Bun.password.verify(
      currentPassword,
      lecturer.passwordHash,
    );
    if (!isValid) {
      return c.json({ error: "Incorrect current password." }, 400);
    }

    const newHash = await Bun.password.hash(newPassword.trim(), "bcrypt");
    lecturer.passwordHash = newHash;
    lecturer.updatedAt = Date.now();
    lecturer.updatedBy = caller.username;

    lecturerAccounts.set(caller.username, lecturer);

    return c.json({
      success: true,
      message: "Password updated successfully.",
    });
  }

  return c.json({ error: "Unauthorized." }, 401);
}
