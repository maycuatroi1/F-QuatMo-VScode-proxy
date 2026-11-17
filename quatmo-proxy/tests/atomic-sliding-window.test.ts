import { describe, expect, it } from "bun:test";
import { redisStore, type TurnLog } from "../src/services/classifier/redisStore";

describe("Atomic Sliding Window & Event Cache", () => {
  const sessionCode = "LUA_TEST_SESSION";
  const studentId = "SE12399";

  it("should maintain strictly bounded sliding window when turns are pushed", async () => {
    // Push 15 turns into window of max 10
    let lastTurns: TurnLog[] = [];
    for (let i = 1; i <= 15; i++) {
      const turn: TurnLog = {
        prompt: `Test prompt ${i}`,
        response: `Test response ${i}`,
        timestamp: 1000 + i,
        clientContext: { activeFile: `main_${i}.py` },
      };
      lastTurns = await redisStore.pushTurnAtomic(sessionCode, studentId, turn, 10);
    }

    expect(lastTurns.length).toBe(10);
    // Oldest turn in window must be prompt 6 (1 to 5 trimmed)
    expect(lastTurns[0].prompt).toBe("Test prompt 6");
    // Newest turn must be prompt 15
    expect(lastTurns[9].prompt).toBe("Test prompt 15");

    // Double check via getTurns
    const fetchedTurns = await redisStore.getTurns(sessionCode, studentId);
    expect(fetchedTurns.length).toBe(10);
    expect(fetchedTurns[0].prompt).toBe("Test prompt 6");
    expect(fetchedTurns[9].prompt).toBe("Test prompt 15");
  });

  it("should handle rapid concurrent pushes without race condition or window overflow", async () => {
    const sId = "SE_RACE_CONCURRENT";
    const promises: Promise<TurnLog[]>[] = [];

    // 25 concurrent pushes
    for (let i = 0; i < 25; i++) {
      const turn: TurnLog = {
        prompt: `Concurrent prompt ${i}`,
        response: `Concurrent response ${i}`,
        timestamp: Date.now() + i,
      };
      promises.push(redisStore.pushTurnAtomic(sessionCode, sId, turn, 10));
    }

    await Promise.all(promises);

    const finalTurns = await redisStore.getTurns(sessionCode, sId);
    expect(finalTurns.length).toBe(10);
    for (const t of finalTurns) {
      expect(t.prompt).toContain("Concurrent prompt");
    }
  });

  it("should cache and retrieve latest event for Last-Event-ID recovery", async () => {
    const sId = "SE_CACHE_TEST";
    const event = {
      id: `${sessionCode}-${sId}-9999`,
      label: "instrumental",
      confidence: 0.92,
      iScoreS: 0.81,
      eScoreS: 0.19,
      timestamp: Date.now(),
    };

    await redisStore.cacheLatestEvent(sessionCode, sId, event);

    const retrieved = await redisStore.getLatestEvent(sessionCode, sId);
    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe(event.id);
    expect(retrieved.label).toBe("instrumental");
    expect(retrieved.confidence).toBe(0.92);
  });
});
