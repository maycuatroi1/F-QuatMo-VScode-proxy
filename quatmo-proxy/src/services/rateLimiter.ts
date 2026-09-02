import { redis } from "./redis";

export interface LockoutInfo {
  isLocked: boolean;
  remainingSeconds: number;
  lockedUntil: number;
  reason: "ip" | "account" | null;
  attemptsCount: number;
}

interface InternalLockoutRecord {
  attempts: number;
  lockedUntil: number;
  firstAttemptAt: number;
}

// In-memory fallback maps for when Redis is unconfigured or offline
const ipLocks = new Map<string, InternalLockoutRecord>();
const accountLocks = new Map<string, InternalLockoutRecord>();

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60; // 15 minutes window
const LOCKOUT_SECONDS = 15 * 60; // 15 minutes lockout

function cleanExpiredLocalRecords() {
  const now = Date.now();
  for (const [ip, rec] of ipLocks.entries()) {
    if (rec.lockedUntil > 0 && now > rec.lockedUntil) {
      ipLocks.delete(ip);
    } else if (rec.lockedUntil === 0 && now - rec.firstAttemptAt > WINDOW_SECONDS * 1000) {
      ipLocks.delete(ip);
    }
  }
  for (const [acc, rec] of accountLocks.entries()) {
    if (rec.lockedUntil > 0 && now > rec.lockedUntil) {
      accountLocks.delete(acc);
    } else if (rec.lockedUntil === 0 && now - rec.firstAttemptAt > WINDOW_SECONDS * 1000) {
      accountLocks.delete(acc);
    }
  }
}

setInterval(cleanExpiredLocalRecords, 60 * 1000);

export async function checkLockout(
  ip: string,
  identifier: string
): Promise<LockoutInfo> {
  const cleanIp = (ip || "127.0.0.1").trim();
  const cleanId = (identifier || "unknown").trim().toLowerCase();
  const now = Date.now();

  // 1. Try Redis check if available
  if (redis && redis.status === "ready") {
    try {
      const ipLockUntil = await redis.get(`rate:locked:ip:${cleanIp}`);
      if (ipLockUntil) {
        const untilMs = parseInt(ipLockUntil, 10);
        const remSec = Math.max(1, Math.ceil((untilMs - now) / 1000));
        return {
          isLocked: true,
          remainingSeconds: remSec,
          lockedUntil: untilMs,
          reason: "ip",
          attemptsCount: MAX_ATTEMPTS,
        };
      }

      const accLockUntil = await redis.get(`rate:locked:account:${cleanId}`);
      if (accLockUntil) {
        const untilMs = parseInt(accLockUntil, 10);
        const remSec = Math.max(1, Math.ceil((untilMs - now) / 1000));
        return {
          isLocked: true,
          remainingSeconds: remSec,
          lockedUntil: untilMs,
          reason: "account",
          attemptsCount: MAX_ATTEMPTS,
        };
      }
    } catch {
      // Fallback to local map on Redis error
    }
  }

  // 2. In-memory local check
  const ipRec = ipLocks.get(cleanIp);
  if (ipRec && ipRec.lockedUntil > now) {
    const remSec = Math.max(1, Math.ceil((ipRec.lockedUntil - now) / 1000));
    return {
      isLocked: true,
      remainingSeconds: remSec,
      lockedUntil: ipRec.lockedUntil,
      reason: "ip",
      attemptsCount: ipRec.attempts,
    };
  }

  const accRec = accountLocks.get(cleanId);
  if (accRec && accRec.lockedUntil > now) {
    const remSec = Math.max(1, Math.ceil((accRec.lockedUntil - now) / 1000));
    return {
      isLocked: true,
      remainingSeconds: remSec,
      lockedUntil: accRec.lockedUntil,
      reason: "account",
      attemptsCount: accRec.attempts,
    };
  }

  return {
    isLocked: false,
    remainingSeconds: 0,
    lockedUntil: 0,
    reason: null,
    attemptsCount: Math.max(ipRec?.attempts || 0, accRec?.attempts || 0),
  };
}

export async function recordFailedAttempt(
  ip: string,
  identifier: string
): Promise<{ attemptsCount: number; isNowLocked: boolean; lockoutInfo?: LockoutInfo }> {
  const cleanIp = (ip || "127.0.0.1").trim();
  const cleanId = (identifier || "unknown").trim().toLowerCase();
  const now = Date.now();

  let ipAttempts = 0;
  let accAttempts = 0;

  // 1. Try Redis recording
  if (redis && redis.status === "ready") {
    try {
      const ipKey = `rate:attempts:ip:${cleanIp}`;
      const accKey = `rate:attempts:account:${cleanId}`;

      ipAttempts = await redis.incr(ipKey);
      if (ipAttempts === 1) await redis.expire(ipKey, WINDOW_SECONDS);

      accAttempts = await redis.incr(accKey);
      if (accAttempts === 1) await redis.expire(accKey, WINDOW_SECONDS);

      if (ipAttempts >= MAX_ATTEMPTS) {
        const lockUntil = now + LOCKOUT_SECONDS * 1000;
        await redis.set(`rate:locked:ip:${cleanIp}`, String(lockUntil), "EX", LOCKOUT_SECONDS);
        return {
          attemptsCount: ipAttempts,
          isNowLocked: true,
          lockoutInfo: {
            isLocked: true,
            remainingSeconds: LOCKOUT_SECONDS,
            lockedUntil: lockUntil,
            reason: "ip",
            attemptsCount: ipAttempts,
          },
        };
      }

      if (accAttempts >= MAX_ATTEMPTS) {
        const lockUntil = now + LOCKOUT_SECONDS * 1000;
        await redis.set(`rate:locked:account:${cleanId}`, String(lockUntil), "EX", LOCKOUT_SECONDS);
        return {
          attemptsCount: accAttempts,
          isNowLocked: true,
          lockoutInfo: {
            isLocked: true,
            remainingSeconds: LOCKOUT_SECONDS,
            lockedUntil: lockUntil,
            reason: "account",
            attemptsCount: accAttempts,
          },
        };
      }

      return {
        attemptsCount: Math.max(ipAttempts, accAttempts),
        isNowLocked: false,
      };
    } catch {
      // Fallback to local map
    }
  }

  // 2. Local memory recording
  let ipRec = ipLocks.get(cleanIp);
  if (!ipRec || (ipRec.lockedUntil === 0 && now - ipRec.firstAttemptAt > WINDOW_SECONDS * 1000)) {
    ipRec = { attempts: 1, lockedUntil: 0, firstAttemptAt: now };
  } else {
    ipRec.attempts++;
  }
  if (ipRec.attempts >= MAX_ATTEMPTS) {
    ipRec.lockedUntil = now + LOCKOUT_SECONDS * 1000;
  }
  ipLocks.set(cleanIp, ipRec);

  let accRec = accountLocks.get(cleanId);
  if (!accRec || (accRec.lockedUntil === 0 && now - accRec.firstAttemptAt > WINDOW_SECONDS * 1000)) {
    accRec = { attempts: 1, lockedUntil: 0, firstAttemptAt: now };
  } else {
    accRec.attempts++;
  }
  if (accRec.attempts >= MAX_ATTEMPTS) {
    accRec.lockedUntil = now + LOCKOUT_SECONDS * 1000;
  }
  accountLocks.set(cleanId, accRec);

  const isLocked = ipRec.attempts >= MAX_ATTEMPTS || accRec.attempts >= MAX_ATTEMPTS;
  const reason = ipRec.attempts >= MAX_ATTEMPTS ? "ip" : accRec.attempts >= MAX_ATTEMPTS ? "account" : null;
  const lockedUntil = Math.max(ipRec.lockedUntil, accRec.lockedUntil);
  const remSec = isLocked ? Math.max(1, Math.ceil((lockedUntil - now) / 1000)) : 0;

  return {
    attemptsCount: Math.max(ipRec.attempts, accRec.attempts),
    isNowLocked: isLocked,
    lockoutInfo: isLocked
      ? {
          isLocked: true,
          remainingSeconds: remSec,
          lockedUntil,
          reason,
          attemptsCount: Math.max(ipRec.attempts, accRec.attempts),
        }
      : undefined,
  };
}

export async function recordSuccessfulLogin(
  ip: string,
  identifier: string
): Promise<void> {
  const cleanIp = (ip || "127.0.0.1").trim();
  const cleanId = (identifier || "unknown").trim().toLowerCase();

  if (redis && redis.status === "ready") {
    try {
      await redis.del(
        `rate:attempts:ip:${cleanIp}`,
        `rate:attempts:account:${cleanId}`,
        `rate:locked:ip:${cleanIp}`,
        `rate:locked:account:${cleanId}`
      );
    } catch {
      // Fallback
    }
  }

  ipLocks.delete(cleanIp);
  accountLocks.delete(cleanId);
}

export async function unlockTarget(
  type: "ip" | "account",
  target: string
): Promise<void> {
  const cleanTarget = (target || "").trim().toLowerCase();
  if (!cleanTarget) return;

  if (redis && redis.status === "ready") {
    try {
      if (type === "ip") {
        await redis.del(`rate:attempts:ip:${cleanTarget}`, `rate:locked:ip:${cleanTarget}`);
      } else {
        await redis.del(`rate:attempts:account:${cleanTarget}`, `rate:locked:account:${cleanTarget}`);
      }
    } catch {
      // Fallback
    }
  }

  if (type === "ip") {
    ipLocks.delete(cleanTarget);
  } else {
    accountLocks.delete(cleanTarget);
  }
}

export async function getLockedList(): Promise<{
  lockedAccounts: Array<{ identifier: string; remainingSeconds: number; lockedUntil: number }>;
  lockedIPs: Array<{ ip: string; remainingSeconds: number; lockedUntil: number }>;
}> {
  const now = Date.now();
  const lockedAccounts: Array<{ identifier: string; remainingSeconds: number; lockedUntil: number }> = [];
  const lockedIPs: Array<{ ip: string; remainingSeconds: number; lockedUntil: number }> = [];

  // Redis list check if ready
  if (redis && redis.status === "ready") {
    try {
      const accKeys = await redis.keys("rate:locked:account:*");
      for (const k of accKeys) {
        const id = k.replace("rate:locked:account:", "");
        const untilStr = await redis.get(k);
        if (untilStr) {
          const untilMs = parseInt(untilStr, 10);
          if (untilMs > now) {
            lockedAccounts.push({
              identifier: id,
              remainingSeconds: Math.max(1, Math.ceil((untilMs - now) / 1000)),
              lockedUntil: untilMs,
            });
          }
        }
      }

      const ipKeys = await redis.keys("rate:locked:ip:*");
      for (const k of ipKeys) {
        const ip = k.replace("rate:locked:ip:", "");
        const untilStr = await redis.get(k);
        if (untilStr) {
          const untilMs = parseInt(untilStr, 10);
          if (untilMs > now) {
            lockedIPs.push({
              ip,
              remainingSeconds: Math.max(1, Math.ceil((untilMs - now) / 1000)),
              lockedUntil: untilMs,
            });
          }
        }
      }
      return { lockedAccounts, lockedIPs };
    } catch {
      // Fallback to local map
    }
  }

  // Local map scan
  for (const [acc, rec] of accountLocks.entries()) {
    if (rec.lockedUntil > now) {
      lockedAccounts.push({
        identifier: acc,
        remainingSeconds: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)),
        lockedUntil: rec.lockedUntil,
      });
    }
  }

  for (const [ip, rec] of ipLocks.entries()) {
    if (rec.lockedUntil > now) {
      lockedIPs.push({
        ip,
        remainingSeconds: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)),
        lockedUntil: rec.lockedUntil,
      });
    }
  }

  return { lockedAccounts, lockedIPs };
}
