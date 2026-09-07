import { expect, test } from "bun:test";
import { classifyCurrentPrompt } from "../src/services/classifier/currentPromptClassifier";
import { validateIemResponse } from "../src/services/classifier/iemResponsePolicy";
import {
  calculateProgrammaticFeatures,
  calculateSessionSignalScore,
  deriveIemLabel,
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
    validateIemResponse(
      "executive",
      "```python\nprint('solution')\n```",
    )?.code,
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
  expect(validateIemResponse("mixed", sixLines)?.code).toBe(
    "IEM_CODE_LIMIT",
  );
  expect(validateIemResponse("instrumental", elevenLines)?.code).toBe(
    "IEM_CODE_LIMIT",
  );
});

test("one opposite strong turn is not diluted by four same-type turns", () => {
  const instrumental = calculateSessionSignalScore([0.8, 0.75, 0.7, 0.8, 0]);
  const executive = calculateSessionSignalScore([0, 0, 0, 0, 0.8]);

  expect(instrumental).toBe(1);
  expect(executive).toBeCloseTo(0.8);
  expect(deriveIemLabel(instrumental, executive)).toBe("mixed");
});

test("session aggregation follows max-dominant SignalScore", () => {
  expect(calculateSessionSignalScore([0.87, 0.68, 0.61])).toBe(1);
  expect(calculateSessionSignalScore([0, 0, 0, 0.75])).toBeCloseTo(0.75);
});

test("IEM gates use HIGH 0.55, MID 0.45, and MARGIN 0.15", () => {
  expect(deriveIemLabel(0.7, 0.2)).toBe("instrumental");
  expect(deriveIemLabel(0.2, 0.7)).toBe("executive");
  expect(deriveIemLabel(0.7, 0.5)).toBe("mixed");
  expect(deriveIemLabel(0.5, 0.2)).toBe("ambiguous");
});

test("t10 requires delegation to recur across turns", () => {
  const priorTurns: TurnLog[] = [
    {
      timestamp: 1,
      prompt: "write it for me",
      response: "",
      I_score: 0,
      E_score: 0.8,
    },
  ];
  const features = calculateProgrammaticFeatures(
    "do the assignment for me",
    "",
    null,
    priorTurns[0],
    30,
    priorTurns,
  );

  expect(features.t10).toBe(0.75);
});
