

export function getUpstreamConfig(
  model: string,
  token?: string,
): {
  url: string;
  key: string;
  actualModel: string;
  provider: "lmstudio" | "custom" | "openrouter" | "openai";
} {
  const customBaseUrl =
    process.env.CUSTOM_BASE_URL || "https://quatmo-api.iahn.hanoi.vn/v1";
  const customKey = process.env.CUSTOM_API_KEY || "FORWARD_USER_KEY";
  const isTestMode = process.env.PROXY_TEST_MODE === "true";
  const customUrl = isTestMode
    ? "http://localhost:3002/v1/chat/completions"
    : `${customBaseUrl}/chat/completions`;

  const configuredCustomModel = (
    process.env.CUSTOM_MODEL_NAME || "gemma-4"
  ).trim();

  // Always return Quat Mo LLM configuration
  return {
    url: customUrl,
    key: customKey,
    actualModel: configuredCustomModel,
    provider: "custom",
  };
}

export function normalizeUpstreamBody(
  body: any,
  upstream: ReturnType<typeof getUpstreamConfig>,
) {
  const upstreamBody: any = {
    ...body,
    model: upstream.actualModel,
  };

  // Cost/DoS guard: clients cannot request unbounded output or many completions.
  const maxOut = parseInt(process.env.MAX_OUTPUT_TOKENS || "8192", 10);
  for (const k of ["max_tokens", "max_completion_tokens"]) {
    if (upstreamBody[k] !== undefined) {
      const v = Number(upstreamBody[k]);
      upstreamBody[k] =
        Number.isFinite(v) && v > 0 ? Math.min(v, maxOut) : maxOut;
    }
  }
  if (upstreamBody.n !== undefined) upstreamBody.n = 1;

  if (upstreamBody.messages && Array.isArray(upstreamBody.messages)) {
    upstreamBody.messages = upstreamBody.messages.map((msg: any) => {
      if (typeof msg.content === "string") {
        return {
          ...msg,
          content: msg.content.replace(
            /__CLASSIFIER_RESULT__:\{.*?\}(?:\r?\n)*/g,
            "",
          ),
        };
      }
      return msg;
    });
  }

  if (upstream.provider === "custom") {
    const modelLower = upstream.actualModel.toLowerCase();
    // Always strip parallel_tool_calls: most custom/iahn models don't support it
    delete upstreamBody.parallel_tool_calls;

    if (modelLower.startsWith("gemma")) {
      // Gemma has no native OpenAI function calling – strip tools entirely
      delete upstreamBody.tools;
      delete upstreamBody.tool_choice;
      console.log(
        `\x1b[33m[Proxy]\x1b[0m Gemma: stripped tools (no native function calling) | ${upstream.actualModel}`,
      );
    } else {
      // qwen3-coder and others: keep tools, keep tool_choice
      console.log(
        `\x1b[32m[Proxy]\x1b[0m Custom: ${upstream.actualModel} | tools: ${upstreamBody.tools?.length ?? 0} | tool_choice: ${upstreamBody.tool_choice ?? "none"}`,
      );
    }
    return upstreamBody;
  }

  if (upstream.provider === "lmstudio") {
    delete upstreamBody.parallel_tool_calls;
    if (upstreamBody.tool_choice === "auto") {
      delete upstreamBody.tool_choice;
    }
  }

  return upstreamBody;
}
