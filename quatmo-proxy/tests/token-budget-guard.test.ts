import { describe, test, expect, beforeEach } from "bun:test";
import { TokenBudgetGuard } from "../src/services/tokenBudgetGuard";
import { sessionStates, sessions } from "../src/services/sessionStore";
import type { UserSession } from "../src/middleware/auth";

describe("TokenBudgetGuard - Strict Zero-Overshoot & Concurrency Gate", () => {
  const sessionCode = "SS-TEST-BUDGET";
  const studentId = "HS_TEST_01";
  const stateKey = `${sessionCode}:${studentId}`;

  const mockSession: any = {
    sessionCode,
    startTime: Math.floor(Date.now() / 1000),
    durationMinutes: 60,
    aiOption: "chatbot",
    aiValidityMinutes: 60,
    defaultTokenBudget: 1000, // Budget 1,000 tokens
    allowedStudentIds: new Set([studentId]),
    createdAt: Date.now(),
    createdBy: "admin",
  };

  beforeEach(() => {
    sessions.set(sessionCode, mockSession);
    sessionStates.set(stateKey, {
      sessionCode,
      studentId,
      hasLoggedIn: true,
      loginTimestamp: Date.now(),
      tokensConsumed: 0,
      reassigned: false,
      latestClassification: "none",
    });
  });

  test("1. Successfully pre-reserves input tokens when budget is ample", async () => {
    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 0,
    };

    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 150,
    });

    expect(res.allowed).toBe(true);
    expect(res.reservedTokens).toBe(150);
    expect(res.consumed).toBe(150);
    expect(res.allowedOutputTokens).toBe(850); // 1000 - 150 = 850
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(150);
  });

  test("2. Rejects request when prompt itself exceeds remaining budget", async () => {
    // Student already used 900 tokens (100 remaining)
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 900;
    sessionStates.set(stateKey, st);

    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 900,
    };

    // Prompt requires 150 tokens (> 100 remaining)
    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 150,
    });

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("prompt_exceeds_budget");
    expect(res.remainingBefore).toBe(100);
    // Tokens must NOT be deducted
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(900);
  });

  test("3. Rejects request when budget is already exhausted", async () => {
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 1000;
    sessionStates.set(stateKey, st);

    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 1000,
    };

    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 10,
    });

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("budget_exceeded");
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(1000);
  });

  test("4. Eliminates concurrency race conditions: second parallel request is blocked", async () => {
    // 400 tokens remaining
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 600;
    sessionStates.set(stateKey, st);

    const userA: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 600,
    };
    const userB: UserSession = { ...userA };

    // Request A arrives with 250 tokens
    const resA = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user: userA,
      inputTokens: 250,
    });

    expect(resA.allowed).toBe(true);
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(850); // 600 + 250

    // Request B arrives 1ms later with 200 tokens
    // Remaining is now 150, so Request B (200 tokens) MUST be blocked!
    const resB = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user: userB,
      inputTokens: 200,
    });

    expect(resB.allowed).toBe(false);
    expect(resB.reason).toBe("prompt_exceeds_budget");
    // Ensure no token bleed
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(850);
  });

  test("5. Finalizes token usage cleanly at or below max ceiling (Zero Overshoot)", async () => {
    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 900,
    };
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 900;
    sessionStates.set(stateKey, st);

    // Pre-reserve 30 tokens -> remaining for output is 70 tokens
    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 30,
    });

    expect(res.allowed).toBe(true);
    expect(res.allowedOutputTokens).toBe(70);
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(930);

    // Case A: Model outputs 40 tokens (<= 70)
    const finA = await TokenBudgetGuard.finalizeUsage({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      reservedTokens: res.reservedTokens,
      actualOutputTokens: 40,
      allowedOutputTokens: res.allowedOutputTokens,
    });

    expect(finA.additionalCharged).toBe(40);
    expect(finA.totalCharged).toBe(70); // 30 input + 40 output
    expect(finA.finalConsumed).toBe(970);
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(970);
  });

  test("6. Hard Clamping: Even if model returns huge output, usage is clamped to exact ceiling", async () => {
    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 950,
    };
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 950;
    sessionStates.set(stateKey, st);

    // Pre-reserve 20 tokens -> remaining allowed output is 30 tokens
    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 20,
    });
    expect(res.allowedOutputTokens).toBe(30);

    // Model attempts to return 500 output tokens!
    const fin = await TokenBudgetGuard.finalizeUsage({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      reservedTokens: res.reservedTokens,
      actualOutputTokens: 500, // Overshoot attempt
      allowedOutputTokens: res.allowedOutputTokens,
    });

    // Must be clamped to exactly 30!
    expect(fin.additionalCharged).toBe(30);
    expect(fin.totalCharged).toBe(50); // 20 input + 30 output
    expect(fin.finalConsumed).toBe(1000); // EXACT CEILING!
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(1000);
  });

  test("7. Rollback: refunds pre-reserved tokens on upstream error or guardrail rejection", async () => {
    const user: UserSession = {
      keyId: `session-${sessionCode}`,
      userId: studentId,
      monthlyTokenLimit: 1000,
      tokensConsumed: 200,
    };
    const st = sessionStates.get(stateKey)!;
    st.tokensConsumed = 200;
    sessionStates.set(stateKey, st);

    // Pre-reserve 100 tokens
    const res = await TokenBudgetGuard.preReserveTokens({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      inputTokens: 100,
    });
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(300);

    // Upstream fails (e.g. 502 or blocked by Guardrail) -> Rollback
    await TokenBudgetGuard.rollbackReservation({
      authMode: "session",
      sessionCode,
      studentId,
      user,
      reservedTokens: res.reservedTokens,
    });

    // Must be restored back to 200!
    expect(sessionStates.get(stateKey)?.tokensConsumed).toBe(200);
    expect(user.tokensConsumed).toBe(200);
  });
});

