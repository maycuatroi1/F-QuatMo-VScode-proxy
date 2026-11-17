import { type SessionPromptMode } from "../../services/sessionStore";
import path from "path";
import fs from "fs";
import type { IemLabel } from "../../services/classifier/currentPromptClassifier";

const cachedPrompts = new Map<string, string>();

export async function getSystemPromptForIem(
  label: IemLabel,
  mode: SessionPromptMode = "scaffolded_code",
): Promise<string> {
  const cacheKey = `${mode}:${label}`;
  if (process.env.NODE_ENV === "production" && cachedPrompts.has(cacheKey)) {
    return cachedPrompts.get(cacheKey)!;
  }

  const baseDir = path.join(process.cwd(), "src", "systemPrompts");

  if (mode === "standard") {
    const standardPath = path.join(baseDir, "standard", "chatbot.md");
    try {
      if (fs.existsSync(standardPath)) {
        const content = await fs.promises.readFile(standardPath, "utf-8");
        if (process.env.NODE_ENV === "production")
          cachedPrompts.set(cacheKey, content);
        return content;
      }
    } catch (err) {
      console.error("[StandardPrompt] Error reading standard/chatbot.md:", err);
    }
    return "You are a professional, helpful, and pragmatic software engineering assistant.";
  }

  const folderName =
    mode === "socratic_tutor" ? "socratic_tutor" : "scaffolded_code";
  const fallbackFile =
    mode === "socratic_tutor" ? "socratic_tutor.md" : "python_tutor.md";

  let filename = "mixed.md";
  if (label === "instrumental") {
    filename = "instrumental.md";
  } else if (label === "executive") {
    filename = "executive.md";
  }

  try {
    let targetPath = path.join(baseDir, folderName, filename);
    if (!fs.existsSync(targetPath)) {
      targetPath = path.join(baseDir, folderName, fallbackFile);
    }

    if (fs.existsSync(targetPath)) {
      const prompt = await fs.promises.readFile(targetPath, "utf-8");
      if (process.env.NODE_ENV === "production") {
        cachedPrompts.set(cacheKey, prompt);
      }
      return prompt;
    }
  } catch (err) {
    console.error(
      `[IemPrompt] Error reading prompt for ${mode}/${label}:`,
      err,
    );
  }

  if (filename !== "mixed.md") {
    return getSystemPromptForIem("mixed", mode);
  }

  return mode === "socratic_tutor"
    ? "You are Quạt Mo, an expert Socratic programming tutor. Never provide direct code solutions; guide the student conceptually through inquiry."
    : "You are Quạt Mo, an intelligent, helpful, and supportive AI programming tutor at FPT University.";
}

export const CLIENT_COMMAND_PRECEDENCE_DIRECTIVE =
  "\n\n================================================================================\n" +
  "UNIVERSAL SYSTEM DIRECTIVE: CLIENT COMMAND PRECEDENCE OVER ATTACHED CONTEXT\n" +
  "================================================================================\n" +
  "1. PRIORITIZE CLIENT PROMPT OVER ATTACHED FILES:\n" +
  "   - Your highest priority is to attend strictly to the student's/client's explicit command.\n" +
  "   - Attached files, active editor contents, and workspace tabs are PASSIVE BACKGROUND REFERENCE MATERIAL only.\n" +
  "   - Do NOT proactively dissect, solve, rewrite, or debug attached files unless the client's explicit command directly instructs you to do so.\n" +
  "   - If the client's message is a greeting, conceptual question, vague, or unrelated to editing the attached file, respond directly to their message and DO NOT touch or regenerate the attached file.\n" +
  "2. STRICT SCOPE BOUNDING (ZERO PROACTIVE EXTRAPOLATION):\n" +
  "   - Adhere strictly to the requested scope with 100% fidelity.\n" +
  "   - If an attached file contains multiple questions, exercises, or tasks (e.g., Question 1, Question 2, Question 3) and the client asks ONLY about a specific item (e.g., 'Question 1' or 'câu 1'):\n" +
  "     * You MUST address ONLY that specific requested question or task.\n" +
  "     * You are STRICTLY FORBIDDEN from proactively solving, implementing, answering, or referencing Question 2, Question 3, or any unrequested parts in the file.\n" +
  "     * Never extrapolate or solve ahead.\n" +
  "3. SEPARATION OF SCOPE VS. TUTOR POLICY:\n" +
  "   - The client's command determines the active TOPIC and SCOPE (e.g., focusing on Question 1).\n" +
  "   - The active Tutor Policy strictly governs your RESPONSE METHOD (e.g., in Socratic mode, you guide conceptually and refuse runnable code; in Scaffolded mode, you provide modular assistance upon request).\n" +
  "================================================================================\n";
