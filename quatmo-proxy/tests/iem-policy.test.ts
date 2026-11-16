import { expect, test } from "bun:test";
import { classifyCurrentPrompt } from "../src/services/classifier/currentPromptClassifier";
import { validateIemResponse } from "../src/services/classifier/iemResponsePolicy";
import {
  blendFeatures,
  calculateProgrammaticFeatures,
  calculateRawSessionSignalScore,
  calculateSessionSignalScore,
  deriveIemLabel,
  deriveSessionIemLabel,
  ONLINE_FEATURE_KEYS,
} from "../src/services/classifier/features";
import type { TurnLog } from "../src/services/classifier/redisStore";

test("current executive request cannot be hidden by prior instrumental turns", () => {
  const decision = classifyCurrentPrompt(
    "Write me a complete bubble sort function in Python",
  );
  expect(decision.label).toBe("executive");
});

test("conceptual current request selects instrumental mode", () => {
  const decision = classifyCurrentPrompt(
    "Explain why bubble sort has quadratic complexity",
  );
  expect(decision.label).toBe("instrumental");
});

test("implementation inquiry without delegation selects instrumental mode", () => {
  const decision1 = classifyCurrentPrompt(
    "How can I implement a binary search algorithm in Python?",
  );
  expect(decision1.label).toBe("instrumental");

  const decision2 = classifyCurrentPrompt(
    "Hướng dẫn cách cài đặt thuật toán quicksort bằng Python",
  );
  expect(decision2.label).toBe("instrumental");
});

test("conceptual questions without terminal telemetry abstain on t4 and never invent c10", () => {
  const features = calculateProgrammaticFeatures(
    "Explain what a deadlock is in operating systems",
    "",
    null,
    null,
    30,
    [],
  );
  expect(features.t4).toBeUndefined();
  expect(features.c10).toBeUndefined();
});

test("vietnamese executive prompt is accurately classified as executive", () => {
  const decision1 = classifyCurrentPrompt(
    "Viết code cho tôi bài tập tạo web django này",
  );
  expect(decision1.label).toBe("executive");

  const decision2 = classifyCurrentPrompt("giải bài này giúp tôi với");
  expect(decision2.label).toBe("executive");
});

test("unclear current request fails safely to mixed mode", () => {
  const decision = classifyCurrentPrompt("Help me with Python");
  expect(decision.label).toBe("mixed");
});

test("executive mode blocks code but permits conceptual prose", () => {
  expect(
    validateIemResponse(
      "executive",
      "Start by identifying the input and expected output.",
    ),
  ).toBeNull();
  expect(
    validateIemResponse("executive", "```python\nprint('solution')\n```")?.code,
  ).toBe("IEM_CODE_LIMIT");
});

test("executive mode permits inline syntax references in conceptual prose", () => {
  expect(
    validateIemResponse(
      "executive",
      "Start with file access and look into the `open()` function before attempting the first step.",
    ),
  ).toBeNull();

  expect(validateIemResponse("executive", "open('answer.txt')")?.code).toBe(
    "IEM_CODE_LIMIT",
  );
});

test("mixed and instrumental modes enforce their line limits", () => {
  const fiveLines =
    "```python\n" +
    [1, 2, 3, 4, 5].map((n) => `x${n} = ${n}`).join("\n") +
    "\n```";
  const sixLines =
    "```python\n" +
    [1, 2, 3, 4, 5, 6].map((n) => `x${n} = ${n}`).join("\n") +
    "\n```";
  const elevenLines =
    "```python\n" +
    Array.from({ length: 11 }, (_, n) => `x${n} = ${n}`).join("\n") +
    "\n```";

  expect(validateIemResponse("mixed", fiveLines)).toBeNull();
  expect(validateIemResponse("mixed", sixLines)?.code).toBe("IEM_CODE_LIMIT");
  expect(validateIemResponse("instrumental", elevenLines)?.code).toBe(
    "IEM_CODE_LIMIT",
  );
});

test("one opposite strong turn prevents uncontested instrumental dominance", () => {
  const instrumentalRaw = calculateRawSessionSignalScore([0.8, 0.75, 0.7, 0.8, 0]);
  const executiveRaw = calculateRawSessionSignalScore([0, 0, 0, 0, 0.8]);

  expect(instrumentalRaw).toBeCloseTo(1.2975);
  expect(executiveRaw).toBeCloseTo(0.8);
  expect(deriveSessionIemLabel(instrumentalRaw, executiveRaw)).toBe("mixed");
});

test("session aggregation follows max-dominant SignalScore", () => {
  expect(calculateSessionSignalScore([0.87, 0.68, 0.61])).toBe(1);
  expect(calculateSessionSignalScore([0, 0, 0, 0.75])).toBeCloseTo(0.75);
});

test("IEM v3 gates use inclusive margin M_I=0.60 and M_E=0.30 with no ambiguous output", () => {
  expect(deriveIemLabel(0.8, 0.2)).toBe("instrumental");
  expect(deriveIemLabel(0.6, 0)).toBe("instrumental");
  expect(deriveIemLabel(0.2, 0.5)).toBe("executive");
  expect(deriveIemLabel(0, 0.3)).toBe("executive");
  expect(deriveIemLabel(0.7, 0.2)).toBe("mixed");
  expect(deriveIemLabel(0.5, 0.2)).toBe("mixed");
  expect(deriveIemLabel(0.5, 0.9)).toBe("executive");
  expect(deriveIemLabel(0.9, 0.5)).toBe("mixed");
  expect(deriveSessionIemLabel(1.5, 0.9)).toBe("instrumental");
});

test("t10 requires delegation to recur across turns (lexical or semantic e2)", () => {
  const priorTurns: TurnLog[] = [
    {
      timestamp: 1,
      prompt: "write it for me",
      response: "",
      I_score: 0,
      E_score: 0.8,
    },
  ];
  const lexicalRepeat = calculateProgrammaticFeatures(
    "do the assignment for me",
    "",
    null,
    priorTurns[0],
    30,
    priorTurns,
  );
  expect(lexicalRepeat.t10).toBe(1);

  const semanticRepeat = calculateProgrammaticFeatures(
    "continue please",
    "",
    null,
    priorTurns[0],
    30,
    priorTurns,
    { e2: 0.83 },
  );
  expect(semanticRepeat.t10).toBe(1);
});

test("t4 activates on execution evidence and rejects stale repeated terminal buffer", () => {
  const freshFeatures = calculateProgrammaticFeatures(
    "how do I fix the loop condition?",
    "",
    {
      recentTerminal: {
        lastCommand: "python test_solution.py",
        output: "Ran 3 tests in 0.002s\nOK\n[Process exited with code 0]",
        timestamp: 200,
      },
    },
    null,
    30,
    [],
  );
  expect(freshFeatures.t4).toBe(1);

  const priorTurn: TurnLog = {
    timestamp: 150,
    prompt: "first run",
    response: "",
    lastTerminalCommand: "pytest",
    terminalOutput: "1 passed",
    I_score: 0.5,
    E_score: 0,
  };
  const staleFeatures = calculateProgrammaticFeatures(
    "unrelated follow-up",
    "",
    {
      recentTerminal: {
        lastCommand: "pytest",
        output: "1 passed",
        timestamp: 100,
      },
    },
    priorTurn,
    20,
    [priorTurn],
  );
  expect(staleFeatures.t4).toBe(0);
});

test("r8 subsumes generic pedagogy while preserving r5 and enforcing exact-copy c5 veto", () => {
  const blended = blendFeatures(
    { r8: 1, r5: 1, r1: 1, r2: 1, r3: 1, r4: 1, r6: 1, c5: 1 },
    { _exactCopyOnly: 1 },
  );
  expect(blended.r8).toBeGreaterThan(0);
  expect(blended.r7).toBeGreaterThan(0);
  expect(blended.r5).toBeGreaterThan(0);
  expect(blended.r1).toBe(0);
  expect(blended.r2).toBe(0);
  expect(blended.r3).toBe(0);
  expect(blended.r4).toBe(0);
  expect(blended.r6).toBe(0);
  expect(blended.c5).toBe(0);
  expect(ONLINE_FEATURE_KEYS.length).toBe(32);
});
