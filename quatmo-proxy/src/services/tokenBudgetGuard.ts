import { redis } from "./redis";
import type { UserSession } from "../middleware/auth";

export interface ReservationResult {
  allowed: boolean;
  reason?: "budget_exceeded" | "prompt_exceeds_budget" | "error";
  message?: string;
  budget: number;
  consumed: number;
  remainingBefore: number;
  reservedTokens: number;
  allowedOutputTokens: number;
}

export interface FinalizeParams {
  authMode?: "session" | "normal" | string;
  sessionCode?: string;
  studentId?: string;
  token?: string;
  keyId?: string;
  reservedTokens: number;
  actualOutputTokens: number;
  allowedOutputTokens: number;
  user: UserSession;
}

export interface RollbackParams {
  authMode?: "session" | "normal" | string;
  sessionCode?: string;
  studentId?: string;
  token?: string;
  keyId?: string;
  reservedTokens: number;
  user: UserSession;
}

const LUA_PRE_RESERVE_SESSION = `
local sessionKey = KEYS[1]
local inputTokens = tonumber(ARGV[1]) or 0
local defaultBudget = tonumber(ARGV[2]) or 100000000

local rawBudget = redis.call('HGET', sessionKey, 'budget')
local budget = tonumber(rawBudget) or defaultBudget

local rawConsumed = redis.call('HGET', sessionKey, 'consumed')
if not rawConsumed then
  rawConsumed = redis.call('HGET', sessionKey, 'tokensConsumed')
end
local consumed = tonumber(rawConsumed) or 0

local remaining = budget - consumed

if remaining <= 0 then
  return {0, consumed, budget, 0}
end

if inputTokens >= remaining then
  return {-1, consumed, budget, remaining}
end

local newConsumed = redis.call('HINCRBY', sessionKey, 'consumed', inputTokens)
redis.call('HSET', sessionKey, 'tokensConsumed', tostring(newConsumed))
local allowedOutput = budget - newConsumed

return {1, newConsumed, budget, allowedOutput}
`;

const LUA_FINALIZE_SESSION = `
local sessionKey = KEYS[1]
local delta = tonumber(ARGV[1]) or 0
local defaultBudget = tonumber(ARGV[2]) or 100000000

local rawBudget = redis.call('HGET', sessionKey, 'budget')
local budget = tonumber(rawBudget) or defaultBudget

local rawConsumed = redis.call('HGET', sessionKey, 'consumed')
if not rawConsumed then
  rawConsumed = redis.call('HGET', sessionKey, 'tokensConsumed')
end
local consumed = tonumber(rawConsumed) or 0

local remaining = math.max(0, budget - consumed)
local actualDelta = math.min(delta, remaining)

local finalConsumed = consumed
if actualDelta > 0 then
  finalConsumed = redis.call('HINCRBY', sessionKey, 'consumed', actualDelta)
end
redis.call('HSET', sessionKey, 'tokensConsumed', tostring(finalConsumed))

return {finalConsumed, actualDelta}
`;

const LUA_ROLLBACK_SESSION = `
local sessionKey = KEYS[1]
local refund = tonumber(ARGV[1]) or 0
local rawConsumed = redis.call('HGET', sessionKey, 'consumed')
if not rawConsumed then
  rawConsumed = redis.call('HGET', sessionKey, 'tokensConsumed')
end
local consumed = tonumber(rawConsumed) or 0
local newConsumed = math.max(0, consumed - refund)
redis.call('HSET', sessionKey, 'consumed', tostring(newConsumed))
redis.call('HSET', sessionKey, 'tokensConsumed', tostring(newConsumed))
return newConsumed
`;

export class TokenBudgetGuard {
  static async preReserveTokens(params: {
    authMode?: "session" | "normal" | string;
    sessionCode?: string;
    studentId?: string;
    token?: string;
    user: UserSession;
    inputTokens: number;
  }): Promise<ReservationResult> {
    const inputTokens = Math.max(0, Math.ceil(params.inputTokens));

    if (
      params.authMode === "session" &&
      params.sessionCode &&
      params.studentId
    ) {
      const sessionCode = params.sessionCode.toUpperCase();
      const studentId = params.studentId.toUpperCase();
      const sessionKey = `session:user:${sessionCode}:${studentId}`;
      const stateKey = `${sessionCode}:${studentId}`;

      if (redis && redis.status === "ready") {
        try {
          const defaultBudget = params.user.monthlyTokenLimit || 100_000_000;
          const rawRes = (await redis.eval(
            LUA_PRE_RESERVE_SESSION,
            1,
            sessionKey,
            String(inputTokens),
            String(defaultBudget),
          )) as [number, number, number, number];

          const status = Number(rawRes[0]);
          const currentConsumed = Number(rawRes[1]);
          const budget = Number(rawRes[2]);
          const allowedOrRemaining = Number(rawRes[3]);

          if (status === 0) {
            return {
              allowed: false,
              reason: "budget_exceeded",
              message: `Token budget exceeded (${currentConsumed.toLocaleString()} / ${budget.toLocaleString()} tokens). AI access has been locked for this session.`,
              budget,
              consumed: currentConsumed,
              remainingBefore: 0,
              reservedTokens: 0,
              allowedOutputTokens: 0,
            };
          }

          if (status === -1) {
            return {
              allowed: false,
              reason: "prompt_exceeds_budget",
              message: `Prompt requires ${inputTokens.toLocaleString()} tokens, but only ${allowedOrRemaining.toLocaleString()} tokens remain (total session budget: ${budget.toLocaleString()}). Please shorten your prompt.`,
              budget,
              consumed: currentConsumed,
              remainingBefore: allowedOrRemaining,
              reservedTokens: 0,
              allowedOutputTokens: 0,
            };
          }

          const { sessionStates } = await import("./sessionStore");
          const state = sessionStates.get(stateKey);
          if (state) {
            state.tokensConsumed = currentConsumed;
          }
          params.user.tokensConsumed = currentConsumed;

          const remainingBefore = budget - (currentConsumed - inputTokens);
          return {
            allowed: true,
            budget,
            consumed: currentConsumed,
            remainingBefore,
            reservedTokens: inputTokens,
            allowedOutputTokens: Math.max(1, allowedOrRemaining),
          };
        } catch (redisErr: any) {
          console.warn(
            "[TokenBudgetGuard] Redis Lua error, falling back to SQLite RAM:",
            redisErr.message,
          );
        }
      }

      const { sessionStates, sessions } = await import("./sessionStore");
      const state = sessionStates.get(stateKey);
      const sessionObj = sessions.get(sessionCode);
      const budget =
        sessionObj?.defaultTokenBudget ||
        params.user.monthlyTokenLimit ||
        100_000_000;
      const consumed = state?.tokensConsumed ?? params.user.tokensConsumed ?? 0;
      const remaining = budget - consumed;

      if (remaining <= 0) {
        return {
          allowed: false,
          reason: "budget_exceeded",
          message: `Token budget exceeded (${consumed.toLocaleString()} / ${budget.toLocaleString()} tokens). AI access has been locked for this session.`,
          budget,
          consumed,
          remainingBefore: 0,
          reservedTokens: 0,
          allowedOutputTokens: 0,
        };
      }

      if (inputTokens >= remaining) {
        return {
          allowed: false,
          reason: "prompt_exceeds_budget",
          message: `Prompt requires ${inputTokens.toLocaleString()} tokens, but only ${remaining.toLocaleString()} tokens remain (total session budget: ${budget.toLocaleString()}). Please shorten your prompt.`,
          budget,
          consumed,
          remainingBefore: remaining,
          reservedTokens: 0,
          allowedOutputTokens: 0,
        };
      }

      const newConsumed = consumed + inputTokens;
      if (state) {
        state.tokensConsumed = newConsumed;
        sessionStates.set(stateKey, state); // Persists to SQLite
      }
      params.user.tokensConsumed = newConsumed;

      return {
        allowed: true,
        budget,
        consumed: newConsumed,
        remainingBefore: remaining,
        reservedTokens: inputTokens,
        allowedOutputTokens: Math.max(1, budget - newConsumed),
      };
    }

    const budget = params.user.monthlyTokenLimit || 100_000_000;
    const consumed = params.user.tokensConsumed || 0;
    const remaining = budget - consumed;

    if (remaining <= 0) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        message: `Token budget exceeded (${consumed.toLocaleString()} / ${budget.toLocaleString()}). Access Denied.`,
        budget,
        consumed,
        remainingBefore: 0,
        reservedTokens: 0,
        allowedOutputTokens: 0,
      };
    }

    if (inputTokens >= remaining) {
      return {
        allowed: false,
        reason: "prompt_exceeds_budget",
        message: `Prompt requires ${inputTokens.toLocaleString()} tokens, but only ${remaining.toLocaleString()} tokens remain.`,
        budget,
        consumed,
        remainingBefore: remaining,
        reservedTokens: 0,
        allowedOutputTokens: 0,
      };
    }

    params.user.tokensConsumed += inputTokens;
    if (redis && redis.status === "ready" && params.user.keyId) {
      try {
        await redis.incrby(`budget:consumed:${params.user.keyId}`, inputTokens);
        if (params.token) {
          await redis.set(
            `key:auth:${params.token}`,
            JSON.stringify(params.user),
            "EX",
            600,
          );
        }
      } catch {}
    }

    return {
      allowed: true,
      budget,
      consumed: params.user.tokensConsumed,
      remainingBefore: remaining,
      reservedTokens: inputTokens,
      allowedOutputTokens: Math.max(1, budget - params.user.tokensConsumed),
    };
  }

  static async finalizeUsage(params: FinalizeParams): Promise<{
    finalConsumed: number;
    additionalCharged: number;
    totalCharged: number;
  }> {
    const outputTokens = Math.max(0, Math.ceil(params.actualOutputTokens));
    const deltaToAdd = Math.min(outputTokens, params.allowedOutputTokens);

    if (
      params.authMode === "session" &&
      params.sessionCode &&
      params.studentId
    ) {
      const sessionCode = params.sessionCode.toUpperCase();
      const studentId = params.studentId.toUpperCase();
      const sessionKey = `session:user:${sessionCode}:${studentId}`;
      const stateKey = `${sessionCode}:${studentId}`;

      let finalConsumed = 0;
      let actualDelta = 0;

      if (redis && redis.status === "ready") {
        try {
          const rawRes = (await redis.eval(
            LUA_FINALIZE_SESSION,
            1,
            sessionKey,
            String(deltaToAdd),
            String(params.user.monthlyTokenLimit || 100_000_000),
          )) as [number, number];
          finalConsumed = Number(rawRes[0]);
          actualDelta = Number(rawRes[1]);
        } catch (e: any) {
          console.warn("[TokenBudgetGuard] Redis finalize error:", e.message);
        }
      }

      const { sessionStates, sessions } = await import("./sessionStore");
      const state = sessionStates.get(stateKey);
      const sessionObj = sessions.get(sessionCode);
      const budget =
        sessionObj?.defaultTokenBudget ||
        params.user.monthlyTokenLimit ||
        100_000_000;

      if (state) {
        if (!finalConsumed) {
          const remaining = Math.max(0, budget - state.tokensConsumed);
          actualDelta = Math.min(deltaToAdd, remaining);
          state.tokensConsumed += actualDelta;
          finalConsumed = state.tokensConsumed;
        } else {
          state.tokensConsumed = finalConsumed;
        }
        sessionStates.set(stateKey, state); // Persists to SQLite
      }

      params.user.tokensConsumed =
        finalConsumed || params.user.tokensConsumed + deltaToAdd;
      const totalCharged = params.reservedTokens + actualDelta;

      return {
        finalConsumed: params.user.tokensConsumed,
        additionalCharged: actualDelta,
        totalCharged,
      };
    }

    // Normal mode
    const budget = params.user.monthlyTokenLimit || 100_000_000;
    const remaining = Math.max(0, budget - params.user.tokensConsumed);
    const actualDelta = Math.min(deltaToAdd, remaining);
    params.user.tokensConsumed += actualDelta;

    if (redis && redis.status === "ready" && params.keyId) {
      try {
        await redis.incrby(`budget:consumed:${params.keyId}`, actualDelta);
        if (params.token) {
          await redis.set(
            `key:auth:${params.token}`,
            JSON.stringify(params.user),
            "EX",
            600,
          );
        }
      } catch {}
    }

    return {
      finalConsumed: params.user.tokensConsumed,
      additionalCharged: actualDelta,
      totalCharged: params.reservedTokens + actualDelta,
    };
  }

  static async rollbackReservation(params: RollbackParams): Promise<void> {
    if (params.reservedTokens <= 0) return;

    if (
      params.authMode === "session" &&
      params.sessionCode &&
      params.studentId
    ) {
      const sessionCode = params.sessionCode.toUpperCase();
      const studentId = params.studentId.toUpperCase();
      const sessionKey = `session:user:${sessionCode}:${studentId}`;
      const stateKey = `${sessionCode}:${studentId}`;

      if (redis && redis.status === "ready") {
        try {
          await redis.eval(
            LUA_ROLLBACK_SESSION,
            1,
            sessionKey,
            String(params.reservedTokens),
          );
        } catch (e: any) {
          console.warn("[TokenBudgetGuard] Redis rollback error:", e.message);
        }
      }

      const { sessionStates } = await import("./sessionStore");
      const state = sessionStates.get(stateKey);
      if (state) {
        state.tokensConsumed = Math.max(
          0,
          state.tokensConsumed - params.reservedTokens,
        );
        sessionStates.set(stateKey, state);
      }
      params.user.tokensConsumed = Math.max(
        0,
        params.user.tokensConsumed - params.reservedTokens,
      );
      return;
    }

    params.user.tokensConsumed = Math.max(
      0,
      params.user.tokensConsumed - params.reservedTokens,
    );
    if (redis && redis.status === "ready" && params.keyId) {
      try {
        const key = `budget:consumed:${params.keyId}`;
        const val = await redis.get(key);
        const current = parseInt(val || "0", 10);
        const nextVal = Math.max(0, current - params.reservedTokens);
        await redis.set(key, String(nextVal));
        if (params.token) {
          await redis.set(
            `key:auth:${params.token}`,
            JSON.stringify(params.user),
            "EX",
            600,
          );
        }
      } catch {}
    }
  }
}
