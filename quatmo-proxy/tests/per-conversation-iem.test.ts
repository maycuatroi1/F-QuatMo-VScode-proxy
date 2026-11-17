import { describe, expect, it } from "bun:test";
import { redisStore, type TurnLog } from "../src/services/classifier/redisStore";
import { getStudentTopNClassification } from "../src/services/classifier/index";
import { eventBus } from "../src/services/eventBus";

describe("Per-Conversation IEM Isolation & Reset Lifecycle", () => {
  const sessionCode = "CONV_TEST_SESSION";
  const studentId = "SE_CONV_999";
  const convA = "chat_session_alpha_111";
  const convB = "chat_session_beta_222";

  it("should isolate sliding window turns strictly by conversationId", async () => {
    // 1. Push 3 turns into Conversation A (simulate heavy executive requests)
    for (let i = 1; i <= 3; i++) {
      const turn: TurnLog = {
        prompt: `Executive prompt ${i}: write code for me`,
        response: `Solution code ${i}`,
        timestamp: 1000 + i,
        I_score: 0.1,
        E_score: 0.9,
      };
      await redisStore.pushTurnAtomic(sessionCode, studentId, turn, 5, convA);
    }

    const turnsA = await redisStore.getTurns(sessionCode, studentId, convA);
    expect(turnsA.length).toBe(3);
    expect(turnsA[0].prompt).toBe("Executive prompt 1: write code for me");

    // 2. Query Conversation B before any messages are sent (New Chat created)
    const turnsB = await redisStore.getTurns(sessionCode, studentId, convB);
    expect(turnsB.length).toBe(0);

    // 3. Verify getStudentTopNClassification for Conversation A returns executive with windowSize: 3
    const classA = await getStudentTopNClassification(sessionCode, studentId, undefined, convA);
    expect(classA.label).toBe("executive");
    expect(classA.windowSize).toBe(3);
    expect(classA.source).toBe("window_turns(3)");

    // 4. Verify getStudentTopNClassification for Conversation B starts FRESH ("đánh lại từ đầu")
    // It must NOT inherit Conversation A's executive label or window turns!
    const classB = await getStudentTopNClassification(sessionCode, studentId, undefined, convB);
    expect(classB.label).toBe("mixed");
    expect(classB.overallLabel).toBe("mixed");
    expect(classB.windowSize).toBe(0);
    expect(classB.source).toBe("new_conversation");
  });

  it("should evaluate Turn 1 of a new conversation independently from scratch", async () => {
    // Student sends Turn 1 in Conversation B (Conceptual/Instrumental question: "explain recursion")
    const turnB1: TurnLog = {
      prompt: "Explain the theoretical mechanics of recursion without code",
      response: "Recursion is a method where the solution depends on solutions to smaller instances...",
      timestamp: 2000,
      I_score: 0.85,
      E_score: 0.05,
    };

    const windowB = await redisStore.pushTurnAtomic(sessionCode, studentId, turnB1, 5, convB);
    expect(windowB.length).toBe(1);
    expect(windowB[0].prompt).toContain("recursion");

    // Top-N classification for Conversation B must evaluate strictly on this 1 turn (Instrumental)
    const classBAfterTurn1 = await getStudentTopNClassification(sessionCode, studentId, undefined, convB);
    expect(classBAfterTurn1.label).toBe("instrumental");
    expect(classBAfterTurn1.windowSize).toBe(1);
    expect(classBAfterTurn1.source).toBe("window_turns(1)");

    // Verify Conversation A remains intact with its 3 turns and executive classification
    const classAUnchanged = await getStudentTopNClassification(sessionCode, studentId, undefined, convA);
    expect(classAUnchanged.label).toBe("executive");
    expect(classAUnchanged.windowSize).toBe(3);
  });

  it("should deliver conversationId via EventBus and SSE stream payload", async () => {
    const sCode = "CONV_SSE_SESSION";
    const sId = "SE_CONV_SSE";
    const convTarget = "conv_tab_xyz_789";

    let receivedPayload: any = null;
    const unsubscribe = eventBus.subscribeIemUpdate(
      { sessionCode: sCode, studentId: sId },
      (payload) => {
        receivedPayload = payload;
      }
    );

    eventBus.publishIemUpdate({
      sessionCode: sCode,
      studentId: sId,
      token: "mock-token",
      label: "instrumental",
      confidence: 0.92,
      iScoreS: 0.8,
      eScoreS: 0.2,
      iScoreTurn: 0.85,
      eScoreTurn: 0.15,
      windowSize: 1,
      timestamp: Date.now(),
      conversationId: convTarget,
    });

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload.conversationId).toBe(convTarget);
    expect(receivedPayload.label).toBe("instrumental");

    unsubscribe();
  });

  it("should maintain backward compatibility when conversationId is not provided", async () => {
    const legacyStudent = "SE_LEGACY_USER";
    const legacyTurn: TurnLog = {
      prompt: "Legacy prompt without conversationId",
      response: "Legacy response",
      timestamp: 3000,
      I_score: 0.5,
      E_score: 0.5,
    };

    await redisStore.pushTurnAtomic(sessionCode, legacyStudent, legacyTurn, 5);
    const turns = await redisStore.getTurns(sessionCode, legacyStudent);
    expect(turns.length).toBe(1);

    const legacyClass = await getStudentTopNClassification(sessionCode, legacyStudent);
    expect(legacyClass.windowSize).toBe(1);
  });

  it("should accurately save and retrieve turns via saveTurns roundtrip", async () => {
    const sId = "SE_ROUNDTRIP_USER";
    const convId = "conv_roundtrip_test";
    const turnsToSave: TurnLog[] = [
      { prompt: "p1", response: "r1", timestamp: 100, I_score: 0.9, E_score: 0.1 },
      { prompt: "p2", response: "r2", timestamp: 200, I_score: 0.8, E_score: 0.2 },
    ];

    await redisStore.saveTurns(sessionCode, sId, turnsToSave, convId);
    const retrieved = await redisStore.getTurns(sessionCode, sId, convId);
    expect(retrieved.length).toBe(2);
    expect(retrieved[0].prompt).toBe("p1");
    expect(retrieved[1].prompt).toBe("p2");
  });
});

