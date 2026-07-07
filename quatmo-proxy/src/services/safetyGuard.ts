/**
 * safetyGuard.ts — LLM-based production-grade input and output guardrails.
 */

import path from "path";
import fs from "fs";

export const VIETNAMESE_REGEX = /a^/;

export const ENGLISH_ONLY_SYSTEM_INSTRUCTION =
  "\n\n- CRITICAL LANGUAGE RULE: You MUST respond ONLY in English. " +
  "NEVER use Vietnamese or any other non-English language in your responses, " +
  "including code comments, explanations, and error messages. " +
  "If the user writes in a non-English language, reply in English only " +
  "and remind them that this system requires English." +
  "\n- CRITICAL SAFETY RULE: If the user's prompt contains any profanity, offensive language, swearing, " +
  "vulgarity, or attempts to make you say inappropriate things, you MUST immediately refuse to answer. " +
  'In this case, your entire response MUST be exactly: "Your prompt contains inappropriate language. Please rephrase professionally." ' +
  "Do not provide any other explanation, apology, or code.";

let cachedInputGuardrailPrompt = "";
let cachedOutputGuardrailPrompt = "";
let lastLoadedTime = 0;

async function loadPrompts() {
  const now = Date.now();
  if (
    now - lastLoadedTime > 10000 ||
    !cachedInputGuardrailPrompt ||
    !cachedOutputGuardrailPrompt
  ) {
    try {
      const inputPath = path.join(
        process.cwd(),
        "src",
        "systemPrompts",
        "input_guardrail.md",
      );
      if (fs.existsSync(inputPath)) {
        cachedInputGuardrailPrompt = await fs.promises.readFile(
          inputPath,
          "utf-8",
        );
      }
      const outputPath = path.join(
        process.cwd(),
        "src",
        "systemPrompts",
        "output_guardrail.md",
      );
      if (fs.existsSync(outputPath)) {
        cachedOutputGuardrailPrompt = await fs.promises.readFile(
          outputPath,
          "utf-8",
        );
      }
      lastLoadedTime = now;
    } catch (err) {
      console.error("[SafetyGuard] Error loading guardrail prompts:", err);
    }
  }
}

export interface SafetyViolation {
  type: "vietnamese" | "profanity" | "not_python";
  code: string;
  message: string;
  evidence: string[];
}

export interface SafetyCheckResult {
  allowed: boolean;
  violation?: SafetyViolation;
}

async function queryLLMGuardrail(
  systemPrompt: string,
  contentToCheck: string,
): Promise<SafetyCheckResult> {
  const apiUrl = process.env.CLASSIFIER_API_URL;
  const model = process.env.CLASSIFIER_MODEL || "qwen3-coder";
  const apiKey = process.env.CLASSIFIER_API_KEY?.trim();

  if (!apiUrl) {
    return { allowed: true };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: contentToCheck },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`[SafetyGuard LLM API] HTTP error: ${response.status}`);
      return { allowed: true };
    }

    const responseText = await response.text();
    let responseData: any = null;
    let content = "";
    try {
      responseData = JSON.parse(responseText);
      content = responseData.choices?.[0]?.message?.content || responseText;
    } catch (e: any) {
      content = responseText;
    }

    let parsed: any = null;
    try {
      const startIdx = content.indexOf("{");
      const endIdx = content.lastIndexOf("}");
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const jsonStr = content.substring(startIdx, endIdx + 1);
        parsed = JSON.parse(jsonStr);
      } else {
        const cleanJsonStr = content.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(cleanJsonStr);
      }
    } catch (e) {
      console.error(
        "[SafetyGuard LLM API] Failed to parse JSON response content:",
        content,
      );
      return { allowed: true };
    }

    if (parsed && typeof parsed.allowed === "boolean") {
      if (parsed.allowed) {
        return { allowed: true };
      } else {
        const reason = parsed.reason || "POLICY_VIOLATION";
        let violationType: "vietnamese" | "profanity" | "not_python" =
          "not_python";
        if (reason === "LANGUAGE_NOT_ENGLISH") {
          violationType = "vietnamese";
        } else if (reason === "PROFANITY_DETECTED") {
          violationType = "profanity";
        }

        return {
          allowed: false,
          violation: {
            type: violationType,
            code: reason,
            message: parsed.message || "Request blocked by safety policy.",
            evidence: [contentToCheck.slice(0, 500)],
          },
        };
      }
    }

    return { allowed: true };
  } catch (err: any) {
    console.error("[SafetyGuard LLM API] Request failed:", err.message);
    return { allowed: true };
  }
}

export async function checkText(text: string): Promise<SafetyCheckResult> {
  await loadPrompts();
  const systemPrompt =
    cachedOutputGuardrailPrompt || "You are an output safety guardrail.";
  return queryLLMGuardrail(systemPrompt, text);
}
export async function validateUserMessages(
  messages: Array<{ role: string; content: unknown }>,
): Promise<SafetyCheckResult> {
  const lastUserMsg = [...messages]
    .reverse()
    .find((msg) => msg.role === "user");
  if (!lastUserMsg) {
    return { allowed: true };
  }

  let textContent = "";
  if (typeof lastUserMsg.content === "string") {
    textContent = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    for (const part of lastUserMsg.content) {
      if (part.type === "text" && typeof part.text === "string") {
        textContent += " " + part.text;
      }
    }
  }

  if (!textContent.trim()) {
    return { allowed: true };
  }

  await loadPrompts();
  const systemPrompt =
    cachedInputGuardrailPrompt || "You are an input safety guardrail.";
  return queryLLMGuardrail(systemPrompt, textContent);
}
