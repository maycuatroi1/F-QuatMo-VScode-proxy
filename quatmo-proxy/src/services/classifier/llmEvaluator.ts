import fs from "fs";
import path from "path";
import {
  INSTRUMENTAL_WEIGHTS,
  EXECUTIVE_WEIGHTS,
  ONLINE_FEATURE_KEYS,
} from "./features";
import type { TurnLog } from "./redisStore";

let cachedEvalPrompt = "";
let lastPromptLoadedTime = 0;

async function getEvaluationSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (now - lastPromptLoadedTime > 30000 || !cachedEvalPrompt) {
    const candidatePaths = [
      path.join(process.cwd(), "src", "systemPrompts", "session_evaluation.md"),
      path.resolve(__dirname, "../../systemPrompts/session_evaluation.md"),
      path.resolve(process.cwd(), "session_evaluation.md"),
    ];
    for (const filePath of candidatePaths) {
      if (fs.existsSync(filePath)) {
        try {
          cachedEvalPrompt = await fs.promises.readFile(filePath, "utf-8");
          lastPromptLoadedTime = now;
          return cachedEvalPrompt;
        } catch (e) {
          console.error(
            "[Classifier Eval] Error reading session_evaluation.md:",
            e,
          );
        }
      }
    }
    throw new Error(
      "Required session_evaluation.md is missing; cannot silently use an incompatible schema.",
    );
  }
  return cachedEvalPrompt;
}

const MAX_CURRENT_CODE_CHARS = 12000;
const MAX_OTHER_FILES = 4;
const MAX_OTHER_FILE_CHARS = 4000;
const MAX_CURRENT_TERMINAL_CHARS = 3000;
const MAX_HISTORY_MSG_CHARS = 2500;
const MAX_HISTORY_CODE_CHARS = 4000;
const MAX_HISTORY_TERMINAL_CHARS = 1500;

function truncateHeadTail(text: string | undefined, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.max(0, maxChars - headChars);
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n...[truncated ${omitted} chars]...\n${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

function truncateTail(text: string | undefined, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `...[truncated ${omitted} chars]...\n${text.slice(-maxChars)}`;
}

export interface LLMEvalOptions {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fallbackModel?: string;
  verbose?: boolean;
}

export async function evaluateTurnSemanticFeatures(
  prompt: string,
  response: string,
  codeSnapshot: string,
  history: Array<{ role: string; content: string }>,
  codeSnapshots?: Array<{ path: string; content: string; languageId?: string }>,
  activeFile?: { path: string; content: string },
  recentTurns: TurnLog[] = [],
  recentTerminal?: {
    output: string;
    lastCommand?: string;
    exitCode?: number;
    commandType?: string;
    timestamp?: number;
  },
  options: LLMEvalOptions = {},
): Promise<Record<string, number>> {
  const defaultFeatures: Record<string, number> = {};
  const allKeys = ONLINE_FEATURE_KEYS;
  for (const k of allKeys) {
    defaultFeatures[k] = 0;
  }

  try {
    const systemPrompt = await getEvaluationSystemPrompt();
    const apiUrl =
      options.apiUrl ||
      process.env.CLASSIFIER_EVAL_API_URL ||
      process.env.CLASSIFIER_API_URL ||
      "https://api.openai.com/v1/chat/completions";
    const apiKey =
      options.apiKey ||
      process.env.CLASSIFIER_EVAL_API_KEY ||
      process.env.CLASSIFIER_API_KEY ||
      "";
    const model =
      options.model ||
      process.env.CLASSIFIER_EVAL_MODEL ||
      process.env.CLASSIFIER_MODEL ||
      "qwen3-coder";

    if (!apiUrl) {
      console.warn(
        "[Classifier LLM] CLASSIFIER_API_URL not set. Semantic extraction abstaining.",
      );
      return {};
    }

    const prior = recentTurns.slice(-4);
    const activePath = activeFile?.path || "";
    const boundedActiveContent = truncateHeadTail(
      codeSnapshot,
      MAX_CURRENT_CODE_CHARS,
    );
    const boundedOtherFiles = (codeSnapshots || [])
      .filter((file) => !activePath || file.path !== activePath)
      .slice(0, MAX_OTHER_FILES)
      .map((file) => ({
        path: file.path,
        content: truncateHeadTail(file.content, MAX_OTHER_FILE_CHARS),
        ...(file.languageId ? { languageId: file.languageId } : {}),
      }));
    const boundedTerminal = recentTerminal
      ? {
          ...recentTerminal,
          ...(recentTerminal.output !== undefined
            ? {
                output: truncateTail(
                  recentTerminal.output,
                  MAX_CURRENT_TERMINAL_CHARS,
                ),
              }
            : {}),
        }
      : null;

    const payload = JSON.stringify({
      current: {
        studentMessage: prompt,
        aiResponse: response
          ? truncateHeadTail(response, MAX_HISTORY_MSG_CHARS * 2)
          : null,
        responseKind: "delivered",
        activeFile: activeFile
          ? { path: activeFile.path, content: boundedActiveContent }
          : codeSnapshot
            ? { path: "", content: boundedActiveContent }
            : null,
        otherFiles: boundedOtherFiles,
        terminal: boundedTerminal,
      },
      history: prior.map((turn) => ({
        studentMessage: truncateHeadTail(turn.prompt, MAX_HISTORY_MSG_CHARS),
        aiResponse: truncateHeadTail(turn.response, MAX_HISTORY_MSG_CHARS),
        activeFile: {
          path: turn.activeFilePath || "",
          content: truncateHeadTail(turn.codeSnapshot, MAX_HISTORY_CODE_CHARS),
        },
        terminal: {
          lastCommand: turn.lastTerminalCommand,
          output: truncateTail(turn.terminalOutput, MAX_HISTORY_TERMINAL_CHARS),
          commandType: turn.commandType,
        },
      })),
      referenceHistory: prior.length
        ? []
        : history.slice(-8).map((msg) => ({
            role: msg.role,
            content: truncateHeadTail(msg.content, MAX_HISTORY_MSG_CHARS),
          })),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const timeoutMs =
      options.timeoutMs ||
      parseInt(process.env.CLASSIFIER_TIMEOUT_MS || "60000", 10);
    const maxAttempts =
      options.maxAttempts ||
      Math.max(1, parseInt(process.env.CLASSIFIER_MAX_RETRIES || "2", 10));
    const fallbackModel = (
      options.fallbackModel ??
      process.env.CLASSIFIER_FALLBACK_MODEL ??
      "qwen3-coder"
    ).trim();

    let lastError: any = null;
    let responseText = "";
    let activeModel = model;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: activeModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: payload },
            ],
            temperature: 0,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`LLM API returned status ${res.status}: ${errBody}`);
        }

        responseText = await res.text();
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[Classifier LLM] Attempt ${attempt}/${maxAttempts} failed for '${activeModel}' (${err.message}).`,
        );

        if (
          attempt === maxAttempts - 1 &&
          fallbackModel &&
          activeModel !== fallbackModel
        ) {
          console.warn(
            `[Classifier LLM] Switching to fallback model '${fallbackModel}' on final attempt.`,
          );
          activeModel = fallbackModel;
        }

        if (attempt < maxAttempts) {
          const delayMs = attempt * 1500;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    if (!responseText && lastError) {
      throw lastError;
    }

    let parsed: any = null;
    try {
      const responseJson = JSON.parse(responseText);
      const content = responseJson.choices?.[0]?.message?.content || "";

      const arrayStart = content.indexOf("[");
      const arrayEnd = content.lastIndexOf("]");
      const objStart = content.indexOf("{");
      const objEnd = content.lastIndexOf("}");

      if (
        arrayStart !== -1 &&
        arrayEnd !== -1 &&
        (objStart === -1 || arrayStart < objStart)
      ) {
        parsed = JSON.parse(content.substring(arrayStart, arrayEnd + 1));
      } else if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        parsed = JSON.parse(content.substring(objStart, objEnd + 1));
      } else {
        parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
      }
    } catch {
      console.error(
        "[Classifier LLM] Failed to parse JSON response:",
        responseText,
      );
      return {};
    }

    if (parsed && (Array.isArray(parsed) || typeof parsed === "object")) {
      const result: Record<string, number> = { ...defaultFeatures };
      const activeKeys: string[] = [];

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            const k = item.toLowerCase().trim();
            if (k in defaultFeatures) {
              const weight =
                INSTRUMENTAL_WEIGHTS[k] ?? EXECUTIVE_WEIGHTS[k] ?? 1.0;
              result[k] = weight;
              activeKeys.push(k);
            }
          }
        }
      } else {
        const list = Array.isArray(parsed.active_features)
          ? parsed.active_features
          : Array.isArray(parsed.features)
            ? parsed.features
            : null;

        if (list) {
          for (const item of list) {
            if (typeof item === "string") {
              const k = item.toLowerCase().trim();
              if (k in defaultFeatures) {
                const weight =
                  INSTRUMENTAL_WEIGHTS[k] ?? EXECUTIVE_WEIGHTS[k] ?? 1.0;
                result[k] = weight;
                activeKeys.push(k);
              }
            }
          }
        } else {
          for (const [key, value] of Object.entries(parsed)) {
            const k = key.toLowerCase().trim();
            if (k in defaultFeatures) {
              const weight =
                INSTRUMENTAL_WEIGHTS[k] ?? EXECUTIVE_WEIGHTS[k] ?? 1.0;
              if (typeof value === "number" && value > 0) {
                result[k] = weight;
                activeKeys.push(k);
              } else if (typeof value === "boolean" && value) {
                result[k] = weight;
                activeKeys.push(k);
              } else if (typeof value === "string") {
                const s = value.toLowerCase().trim();
                if (s !== "none" && s !== "false" && s !== "0" && s !== "") {
                  result[k] = weight;
                  activeKeys.push(k);
                }
              }
            }
          }
        }
      }

      if (options.verbose) {
        console.log(
          `[Classifier LLM] Active Features (${activeKeys.length}):`,
          activeKeys.join(", "),
        );
      }

      if (!response.trim()) {
        for (const key of allKeys) {
          if (key.startsWith("r")) result[key] = 0;
        }
      }
      return result;
    }
  } catch (err: any) {
    console.error(
      "[Classifier LLM] Error during semantic evaluation:",
      err.message,
    );
    console.warn(
      "[Classifier LLM] Semantic extraction unavailable; retaining only observed programmatic evidence.",
    );
    return {};
  }

  return {};
}
