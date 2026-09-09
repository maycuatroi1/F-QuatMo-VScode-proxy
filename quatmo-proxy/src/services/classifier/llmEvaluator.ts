import fs from "fs";
import path from "path";
import type { TurnLog } from "./redisStore";

let cachedEvalPrompt = "";
let lastPromptLoadedTime = 0;

const ACTIVATION_VALUES: Record<string, number> = {
  none: 0.0,
  weak: 0.25,
  partial: 0.5,
  clear: 0.75,
  strong: 1.0,
};

async function getEvaluationSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (now - lastPromptLoadedTime > 30000 || !cachedEvalPrompt) {
    try {
      const filePath = path.join(
        process.cwd(),
        "src",
        "systemPrompts",
        "session_evaluation.md",
      );
      if (fs.existsSync(filePath)) {
        cachedEvalPrompt = await fs.promises.readFile(filePath, "utf-8");
        lastPromptLoadedTime = now;
      }
    } catch (e) {
      console.error(
        "[Classifier Eval] Error reading session_evaluation.md:",
        e,
      );
    }
  }
  return (
    cachedEvalPrompt || "You are a student session evaluator. Return JSON."
  );
}

export async function evaluateTurnSemanticFeatures(
  prompt: string,
  response: string,
  codeSnapshot: string,
  history: Array<{ role: string; content: string }>,
  codeSnapshots?: Array<{ path: string; content: string; languageId: string }>,
  activeFile?: { path: string; content: string },
  recentTurns: TurnLog[] = [],
  recentTerminal?: { output: string; lastCommand?: string; exitCode?: number },
): Promise<Record<string, number>> {
  const defaultFeatures: Record<string, number> = {};

  const allKeys = [
    "i1",
    "i2",
    "i3",
    "i4",
    "i5",
    "i6",
    "i7",
    "i8",
    "e1",
    "e2",
    "e3",
    "e4",
    "e5",
    "e6",
    "r1",
    "r2",
    "r3",
    "r4",
    "r5",
    "r6",
    "r7",
    "r8",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "t7",
    "t8",
    "t10",
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c8",
    "c9",
    "c10",
  ];
  for (const k of allKeys) {
    defaultFeatures[k] = 0;
  }

  try {
    const systemPrompt = await getEvaluationSystemPrompt();
    const apiUrl =
      process.env.CLASSIFIER_EVAL_API_URL ||
      process.env.CLASSIFIER_API_URL ||
      "https://api.openai.com/v1/chat/completions";
    const apiKey =
      process.env.CLASSIFIER_EVAL_API_KEY || process.env.CLASSIFIER_API_KEY || "";
    const model =
      process.env.CLASSIFIER_EVAL_MODEL || process.env.CLASSIFIER_MODEL || "gpt-4o-mini";

    if (!apiUrl) {
      console.warn(
        "[Classifier LLM] CLASSIFIER_API_URL not set. Skipping LLM evaluation.",
      );
      return defaultFeatures;
    }

    const formattedHistory =
      recentTurns.length > 0
        ? recentTurns
            .map((turn, idx) => {
              const turnNumber = idx + 1;
              const turnParts = [
                `Turn ${turnNumber}:`,
                `Student Prompt: ${turn.prompt}`,
                `AI Response: ${turn.response}`,
                turn.codeSnapshot
                  ? `Code Snapshot:\n\`\`\`\n${turn.codeSnapshot}\n\`\`\``
                  : "Code Snapshot: None",
              ];
              if (turn.terminalOutput) {
                turnParts.push(
                  `Terminal Activity: ${turn.lastTerminalCommand ? `(Command: ${turn.lastTerminalCommand}) ` : ""}\n\`\`\`\n${turn.terminalOutput.slice(-500)}\n\`\`\``,
                );
              }
              return turnParts.join("\n");
            })
            .join("\n\n")
        : history
            .map(
              (msg) => `[${msg.role.toUpperCase()}]: ${msg.content.slice(0, 1000)}`,
            )
            .join("\n\n");

    let codeSection = "";
    if (codeSnapshot) {
      codeSection += `Active Code Snapshot:\n\`\`\`\n${codeSnapshot}\n\`\`\``;
    } else {
      codeSection += "Active Code Snapshot: None";
    }

    if (codeSnapshots && codeSnapshots.length > 0) {
      const activePath = activeFile?.path;
      const otherFiles = codeSnapshots.filter(
        (f) => !activePath || f.path !== activePath,
      );
      if (otherFiles.length > 0) {
        codeSection +=
          "\n\nOther Changed Files Snapshots:\n" +
          otherFiles
            .map(
              (f) =>
                `File: ${f.path}\n\`\`\`${f.languageId || ""}\n${f.content}\n\`\`\``,
            )
            .join("\n\n");
      }
    }

    let terminalSection = "Recent Terminal Activity: None";
    if (recentTerminal?.output || recentTerminal?.lastCommand) {
      terminalSection = [
        "Recent Terminal Activity:",
        recentTerminal.lastCommand ? `Last Command: ${recentTerminal.lastCommand}` : "",
        recentTerminal.exitCode !== undefined ? `Exit Code: ${recentTerminal.exitCode}` : "",
        recentTerminal.output
          ? `Output:\n\`\`\`\n${recentTerminal.output.slice(-1500)}\n\`\`\``
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const payload = [
      "## RECENT 5-TURN WINDOW HISTORY",
      formattedHistory || "None (First Turn)",
      "\n## CURRENT TURN",
      `Student Prompt: ${prompt}`,
      `AI Response: ${response}`,
      codeSection,
      terminalSection,
    ].join("\n\n");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: payload },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (!res.ok) {
      throw new Error(`LLM API returned status ${res.status}`);
    }

    const responseText = await res.text();
    console.log("[Classifier LLM] Raw Response Text:", responseText);
    let parsed: any = null;

    try {
      const responseJson = JSON.parse(responseText);
      const content = responseJson.choices?.[0]?.message?.content || "";
      console.log("[Classifier LLM] Assistant Message Content:", content);

      const startIdx = content.indexOf("{");
      const endIdx = content.lastIndexOf("}");
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        parsed = JSON.parse(content.substring(startIdx, endIdx + 1));
      } else {
        parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
      }
      console.log("[Classifier LLM] Parsed JSON Object:", JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error(
        "[Classifier LLM] Failed to parse JSON response:",
        responseText,
      );
      return defaultFeatures;
    }

    if (parsed) {
      const result: Record<string, number> = { ...defaultFeatures };
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          const valNormalized = value.toLowerCase().trim();
          if (ACTIVATION_VALUES[valNormalized] !== undefined) {
            result[key] = ACTIVATION_VALUES[valNormalized];
          }
        }
      }
      console.log("[Classifier LLM] Mapped Features:", JSON.stringify(result, null, 2));
      return result;
    }
  } catch (err: any) {
    console.error(
      "[Classifier LLM] Error calling classifier LLM:",
      err.message,
    );
  }

  return defaultFeatures;
}
