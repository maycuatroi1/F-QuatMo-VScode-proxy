import { expect, test, describe } from "bun:test";
import { isInlineCompletionRequest } from "../src/routes/chat";
import { isGhostPromptTurn } from "../src/services/promptLogService";

describe("Inline Completion & Ghost-Text Guardrails", () => {
  test("identifies completion headers as inline completion requests", () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-quatmo-mode") return "completion";
          return "";
        },
      },
    };
    const body = { messages: [{ role: "user", content: "some text" }] };
    expect(isInlineCompletionRequest(body, mockContext)).toBe(true);
  });

  test("identifies Text before cursor: in prompt as inline completion", () => {
    const mockContext = { req: { header: () => "" } };
    const body = {
      messages: [
        {
          role: "user",
          content:
            "Language: python\nFile: starter/config.py\nText before cursor:\nimport os\nText after cursor:",
        },
      ],
    };
    expect(isInlineCompletionRequest(body, mockContext)).toBe(true);
  });

  test("identifies legacy inline prompt template as inline completion", () => {
    const mockContext = { req: { header: () => "" } };
    const body = {
      messages: [
        {
          role: "user",
          content: "Complete:\ndef solve():",
        },
      ],
    };
    expect(isInlineCompletionRequest(body, mockContext)).toBe(true);
  });

  test("allows genuine student questions and commands", () => {
    const mockContext = { req: { header: () => "" } };
    const body = {
      messages: [
        {
          role: "user",
          content: "giúp tôi sửa lại thành SQL server trong starter/config.py",
        },
      ],
    };
    expect(isInlineCompletionRequest(body, mockContext)).toBe(false);
  });

  test("isGhostPromptTurn accurately isolates ghost turns from human turns", () => {
    const ghostTurn = {
      timestamp: "2026-10-27T04:27:50.598Z",
      prompt:
        "Language: python\nFile: starter/config.py\nText before cursor:\nDEFAULT_CONN = '...'\nText after cursor:",
    };
    const realTurn = {
      timestamp: "2026-10-27T04:26:03.082Z",
      prompt: "giúp tôi sửa lại thành SQL server",
    };

    expect(isGhostPromptTurn(ghostTurn as any)).toBe(true);
    expect(isGhostPromptTurn(realTurn as any)).toBe(false);
  });
});
