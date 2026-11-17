import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { chatRouter, latestClassifications } = await import("../src/routes/chat");
const { redisStore } = await import("../src/services/classifier/redisStore");
const { getJwtSecret } = await import("../src/services/jwtKey");
const app = new Hono();
app.route("/v1/chat", chatRouter);
const userToken = (id: string) => sign({ studentId: id, type: "user", exp: Math.floor(Date.now() / 1000) + 3600 }, getJwtSecret(), "HS256");

test("chat context keeps terminal timestamps across identical context updates", async () => {
  const id = "SECHATCONTEXT";
  const token = await userToken(id);
  const post = (body: object) => app.request("/v1/chat/client-context", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await app.request("/v1/chat/client-context", { method: "POST", body: "{}" })).status).toBe(401);
  expect((await post({ activeFile: { path: "main.py", content: "print(1)" }, recentTerminal: { output: "ok", lastCommand: "python main.py", timestamp: 1234 } })).status).toBe(200);
  expect((await post({ recentTerminal: { output: "ok", lastCommand: "python main.py" } })).status).toBe(200);
  expect((await redisStore.getClientContext("DEFAULT", id))?.recentTerminal).toMatchObject({ output: "ok", lastCommand: "python main.py", timestamp: 1234 });
});

test("latest classification preserves cached result, fallback map and empty result", async () => {
  const token = await userToken("SECHATCLASSIFICATION");
  const pending = spyOn(redisStore, "isEvaluationPending").mockResolvedValue(false);
  const cached = spyOn(redisStore, "getCachedClassification").mockResolvedValue(null);
  const get = () => app.request("/v1/chat/latest-classification", { headers: { Authorization: `Bearer ${token}` } });
  try {
    expect(await (await get()).json()).toEqual({ label: "none", confidence: 0 });
    latestClassifications.set(token, { label: "mixed", confidence: 0.6 });
    expect(await (await get()).json()).toEqual({ label: "mixed", confidence: 0.6 });
    cached.mockResolvedValue({ label: "executive", confidence: 0.9 } as any);
    expect(await (await get()).json()).toEqual({ label: "executive", confidence: 0.9 });
  } finally { latestClassifications.delete(token); pending.mockRestore(); cached.mockRestore(); }
});

test("chat plain/stream responses preserve upstream configuration and SSE wire format", async () => {
  const names = ["ALLOWED_MODES", "CUSTOM_BASE_URL", "CLASSIFIER_API_URL", "CUSTOM_MODEL_NAME", "MAX_OUTPUT_TOKENS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  process.env.ALLOWED_MODES = "AGENT";
  process.env.CUSTOM_BASE_URL = "http://chat-fixture.test/v1";
  process.env.CLASSIFIER_API_URL = "http://classifier-fixture.test/v1";
  process.env.CUSTOM_MODEL_NAME = "gemma-fixture";
  process.env.MAX_OUTPUT_TOKENS = "256";
  const seen: any[] = [];
  globalThis.fetch = (async (url: any, options: any) => {
    const body = JSON.parse(options.body);
    if (String(url).includes("classifier-fixture")) return Response.json({ choices: [{ message: { content: JSON.stringify({ allowed: true }) } }] });
    expect(String(url)).toBe("http://chat-fixture.test/v1/chat/completions");
    seen.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "A while loop repeats statements." } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
    const chunks = ["A while loop ", "repeats statements."].map((content) => 'data: ' + JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
    chunks.push('data: ' + JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const token = await userToken("SECHATWIRE");
  try {
    for (const stream of [false, true]) {
      const response = await app.request("/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-client-type": "quatmo-code" },
        body: JSON.stringify({ model: "client-model", stream, max_tokens: 100000, messages: [{ role: "user", content: "Explain a while loop in Python." }] }) });
      expect(response.status).toBe(200);
      if (stream) {
        expect(response.headers.get("Content-Type")).toContain("text/event-stream");
        const text = await response.text();
        expect(text).toContain("data: [DONE]");
        expect(text).toContain("A while loop");
      } else expect((await response.json()).choices[0].message.content).toContain("A while loop");
      for (let i = 0; i < 80 && await redisStore.isEvaluationPending(token); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await redisStore.isEvaluationPending(token)).toBe(false);
    }
    expect(seen).toHaveLength(2);
    for (const body of seen) { expect(body.model).toBe("gemma-fixture"); expect(body.max_tokens).toBeLessThanOrEqual(256); }
  } finally {
    globalThis.fetch = oldFetch;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
