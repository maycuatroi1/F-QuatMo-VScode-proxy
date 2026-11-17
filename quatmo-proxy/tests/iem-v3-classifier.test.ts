import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { redisStore, type TurnLog } from "../src/services/classifier/redisStore";
import {
  evaluateTurnAndSession,
  getStudentTopNClassification,
} from "../src/services/classifier/index";
import { evaluateTurnSemanticFeatures } from "../src/services/classifier/llmEvaluator";
import { s3Storage } from "../src/services/s3Storage";
import { chatRouter } from "../src/routes/chat";
import { getJwtSecret } from "../src/services/jwtKey";
import {
  ONLINE_FEATURE_KEYS,
  FEATURE_SCHEMA,
} from "../src/services/classifier/features";

describe("IEM v3 Proxy Classifier Integration & Parity", () => {
  it("runs single-pass LLM BEFORE programmatic features so semantic e2 drives t10, and persists telemetry metadata", async () => {
    const sessionCode = "V3_ORDER_TEST";
    const studentId = "SE_V3_01";
    const convId = "conv_v3_order_01";
    const token = "v3-token-01";

    const priorTurn: TurnLog = {
      timestamp: 1000,
      prompt: "please write task 1 for me",
      response: "```python\ndef solve():\n    return 42\n```",
      activeFilePath: "main.py",
      lastTerminalCommand: "ls",
      terminalOutput: "main.py",
      I_score: 0,
      E_score: 0.83,
      featureVector: { e2: 0.83 },
      schemaVersion: FEATURE_SCHEMA,
    };
    await redisStore.pushTurnAtomic(sessionCode, studentId, priorTurn, 5, convId);

    await redisStore.saveClientContext(sessionCode, studentId, {
      activeFile: {
        path: "main.py",
        content: "def solve():\n    return 42",
        languageId: "python",
      },
      recentTerminal: {
        lastCommand: "pytest -q",
        output: "1 passed in 0.01s",
        commandType: "EXECUTION",
        timestamp: 2000,
      },
    });

    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.CLASSIFIER_API_URL;
    let sentPayload: any = null;
    process.env.CLASSIFIER_API_URL = "http://127.0.0.1:9999/mock-v3";

    globalThis.fetch = (async (_url: any, opts: any) => {
      const reqBody = JSON.parse(opts.body);
      sentPayload = JSON.parse(reqBody.messages[1].content);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                // Deliberately include semantic e2 + c5 + removed c9;
                // exact copy programmatic veto must clear c5, LLM->Prog must trigger t10,
                // whitelist must drop c9, and fresh pytest must set t4.
                content: '["e2","c5","c9"]',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as any;

    try {
      const result = await evaluateTurnAndSession(
        sessionCode,
        studentId,
        token,
        "continue now",
        "Check your solution.",
        [],
        false,
        convId,
      );

      expect(result).not.toBeNull();
      expect(result!.featureSchema).toBe(FEATURE_SCHEMA);
      expect(sentPayload.history.length).toBe(1);
      expect(sentPayload.current.activeFile.path).toBe("main.py");
      expect(sentPayload.current.terminal.commandType).toBe("EXECUTION");

      const turns = await redisStore.getTurns(sessionCode, studentId, convId);
      const latest = turns[turns.length - 1];
      expect(latest.activeFilePath).toBe("main.py");
      expect(latest.commandType).toBe("EXECUTION");
      expect(latest.schemaVersion).toBe(FEATURE_SCHEMA);
      expect(latest.featureVector?.t10).toBeGreaterThan(0);
      expect(latest.featureVector?.t4).toBeGreaterThan(0);
      expect(latest.featureVector?.c5).toBe(0);
      expect(latest.featureVector?.c9).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.CLASSIFIER_API_URL;
      else process.env.CLASSIFIER_API_URL = prevUrl;
    }
  });

  it("keeps write path and getStudentTopNClassification identical when raw session score exceeds 1.0", async () => {
    const sessionCode = "V3_RAW_GATE_TEST";
    const studentId = "SE_V3_02";
    const convId = "conv_v3_raw_02";

    // Window [I=0.95, I=0.95, E=0.89]:
    // Clamped session I=1.0, E=0.89 (delta=0.11 -> mixed if mistakenly clamped)
    // Raw session I=0.95 + 0.35*0.95 = 1.2825, E=0.89 -> delta=0.3925 (< 0.60 -> mixed)
    // Window [I=0.95, I=0.95, I=0.95, E=0.80]:
    // Raw session I=0.95 + 0.35*0.95 + 0.15*0.95 = 1.425, E=0.80 -> delta=0.625 (>= 0.60 -> instrumental!)
    const turns: TurnLog[] = [
      { timestamp: 1, prompt: "p1", response: "r1", I_score: 0.95, E_score: 0 },
      { timestamp: 2, prompt: "p2", response: "r2", I_score: 0.95, E_score: 0 },
      { timestamp: 3, prompt: "p3", response: "r3", I_score: 0.95, E_score: 0 },
      { timestamp: 4, prompt: "p4", response: "r4", I_score: 0, E_score: 0.8 },
    ];
    await redisStore.saveTurns(sessionCode, studentId, turns, convId);

    const decision = await getStudentTopNClassification(
      sessionCode,
      studentId,
      undefined,
      convId,
    );
    expect(decision.iScoreSRaw).toBeCloseTo(1.425);
    expect(decision.eScoreSRaw).toBeCloseTo(0.8);
    expect(decision.iScoreS).toBe(1.0);
    expect(decision.eScoreS).toBeCloseTo(0.8);
    expect(decision.label).toBe("instrumental");
  });

  it("ensures systemPrompts/session_evaluation.md advertises the 32-key schema and zero chain/ dependencies", () => {
    const promptPath = path.resolve(
      process.cwd(),
      "src/systemPrompts/session_evaluation.md",
    );
    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toContain(`Schema: \`${FEATURE_SCHEMA}\``);
    expect(content).toContain(JSON.stringify(ONLINE_FEATURE_KEYS));
    expect(
      fs.existsSync(path.resolve(process.cwd(), "src/systemPrompts/chain")),
    ).toBe(false);
  });

  it("accepts every online feature and rejects excluded legacy keys", async () => {
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.CLASSIFIER_API_URL;
    process.env.CLASSIFIER_API_URL = "http://127.0.0.1:9999/mock-schema";
    const excluded = ["t2", "t6", "t8", "t9", "c2", "c4", "c6", "c7", "c9", "c10"];

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify([...ONLINE_FEATURE_KEYS, ...excluded]) } }] }),
      { status: 200 },
    )) as any;

    try {
      const vector = await evaluateTurnSemanticFeatures("explain", "explanation", undefined, []);
      for (const key of ONLINE_FEATURE_KEYS) expect(vector[key]).toBeGreaterThan(0);
      for (const key of excluded) expect(vector[key]).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.CLASSIFIER_API_URL;
      else process.env.CLASSIFIER_API_URL = prevUrl;
    }
  });

  it("bounds oversized file snapshots and terminal output in LLM evaluator payloads", async () => {
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.CLASSIFIER_API_URL;
    let sentPayload: any = null;
    process.env.CLASSIFIER_API_URL = "http://127.0.0.1:9999/mock-bound";

    globalThis.fetch = (async (_url: any, opts: any) => {
      const reqBody = JSON.parse(opts.body);
      sentPayload = JSON.parse(reqBody.messages[1].content);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '["i3"]' } }] }),
        { status: 200 },
      );
    }) as any;

    try {
      const giantCode = "def f():\n" + "x = 1\n".repeat(4000);
      const giantTerminal = "SETUP\n".repeat(500) + "AssertionError: trailing_marker\n";
      const otherFiles = [
        { path: "main.py", content: giantCode, languageId: "python" },
        ...Array.from({ length: 6 }, (_, idx) => ({
          path: `mod${idx}.py`,
          content: `line_${idx}\n`.repeat(1000),
          languageId: "python",
        })),
      ];

      await evaluateTurnSemanticFeatures(
        "explain why it failed",
        "Check AssertionError.",
        giantCode,
        [],
        otherFiles,
        { path: "main.py", content: giantCode },
        [],
        { output: giantTerminal, lastCommand: "pytest -q", timestamp: 1234 },
      );

      expect(sentPayload.current.activeFile.content.length).toBeLessThan(12200);
      expect(sentPayload.current.activeFile.content).toContain("...[truncated ");
      expect(sentPayload.current.otherFiles.length).toBeLessThanOrEqual(4);
      expect(
        sentPayload.current.otherFiles.some((f: any) => f.path === "main.py"),
      ).toBe(false);
      expect(sentPayload.current.terminal.output.length).toBeLessThan(3100);
      expect(sentPayload.current.terminal.output).toContain("trailing_marker");
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.CLASSIFIER_API_URL;
      else process.env.CLASSIFIER_API_URL = prevUrl;
    }
  });

  it("never overwrites prior turn JSON on unmatched prompt and syncs S3 when target entry matches", async () => {
    const sessionCode = "V3_JSON_GUARD_TEST";
    const studentId = "SE_V3_JSON";
    const sessionDir = path.resolve(process.cwd(), "logs", "sessions", sessionCode);
    const jsonPath = path.resolve(sessionDir, `${studentId}.json`);
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.CLASSIFIER_API_URL;
    const prevS3Avail = s3Storage.isAvailable;
    const prevS3Upload = s3Storage.uploadStudentPromptLog;
    const uploadedPayloads: any[] = [];

    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(
      jsonPath,
      JSON.stringify(
        [
          {
            timestamp: new Date(1000).toISOString(),
            conversationId: "conv_guard",
            prompt: "turn 1 conceptual question",
            classification: { label: "instrumental", currentLabel: "instrumental" },
            featureVector: { i3: 0.65 },
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    process.env.CLASSIFIER_API_URL = "http://127.0.0.1:9999/mock-sync";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '["e2","r8"]' } }] }),
        { status: 200 },
      )) as any;

    (s3Storage as any).isAvailable = () => true;
    (s3Storage as any).uploadStudentPromptLog = async (
      sCode: string,
      sId: string,
      turns: any[],
    ) => {
      uploadedPayloads.push({ sCode, sId, turns: JSON.parse(JSON.stringify(turns)) });
      return true;
    };

    try {
      // 1. Unmatched prompt must NOT corrupt Turn 1
      await evaluateTurnAndSession(
        sessionCode,
        studentId,
        "tok-guard-1",
        "turn 2 unlogged yet",
        "full solution here",
        [],
        false,
        "conv_guard",
      );
      const afterMismatch = JSON.parse(await fs.promises.readFile(jsonPath, "utf-8"));
      expect(afterMismatch.length).toBe(1);
      expect(afterMismatch[0].classification.label).toBe("instrumental");
      expect(afterMismatch[0].featureVector).toEqual({ i3: 0.65 });
      expect(uploadedPayloads.length).toBe(0);

      // 2. Append Turn 2 entry, evaluate matching prompt -> enriches ONLY Turn 2 and re-syncs S3
      afterMismatch.push({
        timestamp: new Date(2000).toISOString(),
        conversationId: "conv_guard",
        prompt: "turn 2 write code for me",
        classification: { label: "instrumental", currentLabel: "instrumental" },
      });
      await fs.promises.writeFile(jsonPath, JSON.stringify(afterMismatch, null, 2), "utf-8");

      await evaluateTurnAndSession(
        sessionCode,
        studentId,
        "tok-guard-2",
        "turn 2 write code for me",
        "```python\nprint(1)\n```",
        [],
        false,
        "conv_guard",
      );
      await new Promise((r) => setTimeout(r, 20));

      const afterMatch = JSON.parse(await fs.promises.readFile(jsonPath, "utf-8"));
      expect(afterMatch[0].featureVector).toEqual({ i3: 0.65 });
      expect(afterMatch[1].classification.featureSchema).toBe(FEATURE_SCHEMA);
      expect(typeof afterMatch[1].classification.iScoreSRaw).toBe("number");
      expect(afterMatch[1].featureVector.e2).toBeGreaterThan(0);
      expect(uploadedPayloads.length).toBe(1);
      expect(uploadedPayloads[0].turns[1].featureVector.e2).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = prevFetch;
      (s3Storage as any).isAvailable = prevS3Avail;
      (s3Storage as any).uploadStudentPromptLog = prevS3Upload;
      if (prevUrl === undefined) delete process.env.CLASSIFIER_API_URL;
      else process.env.CLASSIFIER_API_URL = prevUrl;
      await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("clears eval-pending on upstream error and tool_calls, and writes JSON before V3 enrichment on plain non-stream turns", async () => {
    const app = new Hono();
    app.route("/v1/chat", chatRouter);

    const prevFetch = globalThis.fetch;
    const prevAllowed = process.env.ALLOWED_MODES;
    const prevClsUrl = process.env.CLASSIFIER_API_URL;
    const prevCustomUrl = process.env.CUSTOM_BASE_URL;

    process.env.ALLOWED_MODES = "AGENT";
    process.env.CLASSIFIER_API_URL = "http://127.0.0.1:9999/mock-cls";
    process.env.CUSTOM_BASE_URL = "http://127.0.0.1:9999/mock-upstream/v1";

    const guestId = "SE_V3_ROUTE_CLEANUP";
    const guestJson = path.resolve(process.cwd(), "logs", "guests", `${guestId}.json`);
    const guestLog = path.resolve(process.cwd(), "logs", "guests", `${guestId}.log`);
    const token = await sign(
      {
        studentId: guestId,
        type: "user",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      getJwtSecret(),
    );

    let mode: "upstream_502" | "tool_calls" | "plain_ok" = "upstream_502";
    globalThis.fetch = (async (url: any, opts: any) => {
      const target = String(url);
      if (target.includes("mock-cls")) {
        const bodyStr = opts?.body ? String(opts.body) : "";
        if (bodyStr.includes("while loop") || bodyStr.includes("session_evaluation") || bodyStr.includes("Turn Feature Extractor")) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '["i3", "r2"]' } }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ allowed: true }) } }],
          }),
          { status: 200 },
        );
      }
      if (mode === "upstream_502") {
        return new Response("upstream down", { status: 502 });
      }
      if (mode === "tool_calls") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "tc1",
                      type: "function",
                      function: { name: "read", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "A loop repeats statements." } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
        { status: 200 },
      );
    }) as any;

    try {
      // 1. Upstream 502 must clear eval-pending immediately
      mode = "upstream_502";
      const res502 = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "quatmo-code",
        },
        body: JSON.stringify({
          model: "qwen3-coder",
          stream: false,
          messages: [{ role: "user", content: "explain recursion" }],
        }),
      });
      expect(res502.status).toBe(502);
      expect(await redisStore.isEvaluationPending(token)).toBe(false);

      // 2. tool_calls response skips queueEvaluation and must clear eval-pending immediately
      mode = "tool_calls";
      const resTool = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "quatmo-code",
        },
        body: JSON.stringify({
          model: "qwen3-coder",
          stream: false,
          messages: [{ role: "user", content: "read main.py for me" }],
        }),
      });
      expect(resTool.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(await redisStore.isEvaluationPending(token)).toBe(false);

      // 3. Plain response writes Turn 1 log BEFORE enriching it (no lost Turn 1 V3 metadata)
      mode = "plain_ok";
      globalThis.fetch = (async (url: any, opts: any) => {
        const target = String(url);
        if (target.includes("mock-cls")) {
          const body = JSON.parse(opts.body);
          const sys = body.messages?.[0]?.content || "";
          const content = sys.includes("fvs-codexgold-online-v3")
            ? '["i3","r2"]'
            : JSON.stringify({ allowed: true });
          return new Response(
            JSON.stringify({ choices: [{ message: { content } }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "A loop repeats statements." } }],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          }),
          { status: 200 },
        );
      }) as any;

      const resOk = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "quatmo-code",
        },
        body: JSON.stringify({
          model: "qwen3-coder",
          stream: false,
          messages: [{ role: "user", content: "what is a while loop in python?" }],
        }),
      });
      expect(resOk.status).toBe(200);

      // Poll briefly for background logStudentInteraction -> queueEvaluation completion
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(guestJson)) {
          const parsed = JSON.parse(await fs.promises.readFile(guestJson, "utf-8"));
          const last = parsed[parsed.length - 1];
          if (last?.prompt === "what is a while loop in python?" && (last?.featureVector?.i3 ?? 0) > 0) break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(guestJson)).toBe(true);
      const written = JSON.parse(await fs.promises.readFile(guestJson, "utf-8"));
      const lastWritten = written[written.length - 1];
      expect(lastWritten.prompt).toBe("what is a while loop in python?");
      expect(lastWritten.classification.featureSchema).toBe(FEATURE_SCHEMA);
      expect(lastWritten.featureVector.i3).toBeGreaterThan(0);
      expect(await redisStore.isEvaluationPending(token)).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAllowed === undefined) delete process.env.ALLOWED_MODES;
      else process.env.ALLOWED_MODES = prevAllowed;
      if (prevClsUrl === undefined) delete process.env.CLASSIFIER_API_URL;
      else process.env.CLASSIFIER_API_URL = prevClsUrl;
      if (prevCustomUrl === undefined) delete process.env.CUSTOM_BASE_URL;
      else process.env.CUSTOM_BASE_URL = prevCustomUrl;
      await fs.promises.rm(guestJson, { force: true }).catch(() => {});
      await fs.promises.rm(guestLog, { force: true }).catch(() => {});
    }
  });
});

