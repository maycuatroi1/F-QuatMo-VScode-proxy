import { fastLineLCS } from "./algorithms";
import type { ClientContext, TurnLog } from "./redisStore";

// Define feature lists and their weights
export const INSTRUMENTAL_WEIGHTS: Record<string, number> = {
  // Prompt features (i1 - i8)
  i1: 0.60, // asks conceptual explanation
  i2: 0.65, // asks API/syntax usage details
  i3: 0.70, // asks debugging hint or error root cause
  i4: 0.50, // asks documentation reference
  i5: 0.75, // provides own code and asks for diagnostics
  i6: 0.60, // requests structural architectural advice
  i7: 0.55, // asks validation of a solution step
  i8: 0.70, // explicitly requests code review comments

  // Response features (r1 - r6)
  r1: 0.65, // conceptual explanation without full code solution
  r2: 0.60, // narrow syntax reference snippet
  r3: 0.70, // diagnostic explanation or hint
  r4: 0.55, // documentation reference
  r5: 0.75, // code review feedback (no replacement code)
  r6: 0.50, // step-by-step logic pseudocode

  // Trajectory features (t1 - t5)
  t1: 0.70, // sustained_inquiry_pattern
  t2: 0.80, // self_correction_after_hint
  t3: 0.65, // increasing_specificity_own_reasoning
  t4: 0.70, // verification_loop
  t5: 0.85, // rejection_of_full_solution_offer

  // Code-diff features (c1 - c5)
  c1: 0.85, // high_student_modification_ratio
  c2: 0.75, // incremental_small_step_changes
  c3: 0.70, // structural_divergence_from_ai_suggestion
  c4: 0.80, // test_driven_iteration
  c5: 0.75, // own_algorithm_signature
};

export const EXECUTIVE_WEIGHTS: Record<string, number> = {
  // Prompt features (e1 - e6)
  e1: 0.80, // copy-pastes assignment text demanding solution
  e2: 0.85, // asks AI to write whole file or rewrite it completely
  e3: 0.75, // demands replacement code without explanation
  e4: 0.70, // asks AI to fix errors directly on their behalf
  e5: 0.65, // asks for boilerplate setup script
  e6: 0.60, // expresses helplessness ("make it work", "do it for me")

  // Response features (r7 - r8)
  r7: 0.85, // provides complete copy-pasteable full script/file
  r8: 0.80, // provides direct patch edits rewriting massive chunks

  // Trajectory features (t6 - t10)
  t6: 0.85, // repeated_copy_paste_pattern
  t7: 0.80, // escalation_to_full_solution
  t8: 0.60, // abandon_after_code_received
  t9: 0.55, // minimal_effort_between_turns
  t10: 0.75, // recurring_delegate_across_session

  // Code-diff features (c6 - c10)
  c6: 0.90, // exact_copy_ratio
  c7: 0.90, // single_large_jump
  c8: 0.85, // structural_identity_with_ai_output
  c9: 0.80, // no_intermediate_edits
  c10: 0.65, // zero_own_test_activity
};

export const IEM_WINDOW_SIZE = 5;

export const IEM_HIGH_THRESHOLD = 0.55;
export const IEM_MID_THRESHOLD = 0.45;
export const IEM_MARGIN_THRESHOLD = 0.15;

/**
 * Calculates the SignalScore for a list of weighted activation values.
 * Formula: min(1, v_1 + 0.35 * v_2 + 0.15 * sum(v_j for j >= 3))
 * where values are sorted descending.
 */
export function calculateSignalScore(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const v1 = sorted[0];
  const v2 = sorted[1] || 0;
  let sumRest = 0;
  for (let i = 2; i < sorted.length; i++) {
    sumRest += sorted[i];
  }
  return Math.min(1.0, v1 + 0.35 * v2 + 0.15 * sumRest);
}

export function calculateSessionSignalScore(scores: number[]): number {
  const validScores = scores
    .filter((score) => Number.isFinite(score))
    .slice(-IEM_WINDOW_SIZE);
  if (validScores.length === 0) return 0;

  return calculateSignalScore(
    validScores.map((score) => Math.max(0, Math.min(1, score))),
  );
}

export function deriveIemLabel(
  instrumentalScore: number,
  executiveScore: number,
): "instrumental" | "executive" | "mixed" | "ambiguous" {
  const delta = instrumentalScore - executiveScore;

  if (
    instrumentalScore >= IEM_HIGH_THRESHOLD &&
    executiveScore < IEM_MID_THRESHOLD &&
    delta >= IEM_MARGIN_THRESHOLD
  ) {
    return "instrumental";
  }

  if (
    executiveScore >= IEM_HIGH_THRESHOLD &&
    instrumentalScore < IEM_MID_THRESHOLD &&
    -delta >= IEM_MARGIN_THRESHOLD
  ) {
    return "executive";
  }

  if (
    instrumentalScore >= IEM_MID_THRESHOLD &&
    executiveScore >= IEM_MID_THRESHOLD
  ) {
    return "mixed";
  }

  return "ambiguous";
}

export function calculateIemConfidence(
  label: "instrumental" | "executive" | "mixed" | "ambiguous",
  instrumentalScore: number,
  executiveScore: number,
): number {
  const strongestSignal = Math.max(instrumentalScore, executiveScore);
  const weakestSignal = Math.min(instrumentalScore, executiveScore);
  const separation = Math.abs(instrumentalScore - executiveScore);

  if (label === "ambiguous") {
    return Math.max(
      0,
      Math.min(1, 1 - strongestSignal / IEM_MID_THRESHOLD),
    );
  }

  if (label === "mixed") {
    return Math.min(1, weakestSignal / IEM_MID_THRESHOLD);
  }

  const evidence = Math.min(1, strongestSignal / IEM_HIGH_THRESHOLD);
  const dominance = Math.min(1, separation / IEM_MARGIN_THRESHOLD);
  return Math.min(1, evidence * 0.55 + dominance * 0.45);
}

/**
 * Helper to extract code snippets wrapped in markdown backticks
 */
export function extractCodeBlocks(text: string): string {
  const regex = /```(?:[a-zA-Z0-9+#-]+)?\r?\n([\s\S]*?)```/g;
  let match;
  const blocks: string[] = [];
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  if (blocks.length === 0) {
    // If no backticks, check if there is raw code-like content
    return "";
  }
  return blocks.join("\n");
}

/**
 * Extracts active code snapshot from either body payload, Fvscode active file header,
 * or markdown code fences in prompt text.
 */
export function extractCodeSnapshot(
  body?: any,
  promptText?: string,
): {
  content: string;
  path: string;
  languageId: string;
} {
  if (body?.activeFile?.content) {
    return {
      content: body.activeFile.content,
      path: body.activeFile.path || "",
      languageId: body.activeFile.languageId || "",
    };
  }
  if (body?.codeSnapshot) {
    return {
      content: body.codeSnapshot,
      path: body.activeFilePath || "",
      languageId: body.activeFileLanguageId || "",
    };
  }
  const text = promptText || "";
  // 1. Match Fvscode active file pattern:
  // --- (ACTIVE OPEN EDITOR FILE|ATTACHED TARGET FILE): rel (Path: abs) ---\ncontent\n---------------------
  const activeMatch = text.match(
    /--- (?:ACTIVE OPEN EDITOR FILE|ATTACHED TARGET FILE): ([^\n]+?) \(Path: ([^\n]+?)\) ---\r?\n([\s\S]*?)\r?\n---------------------/,
  );
  if (activeMatch) {
    const filePath = activeMatch[1].trim();
    const content = activeMatch[3];
    const ext = filePath.includes(".")
      ? filePath.split(".").pop() || "python"
      : "python";
    return {
      content,
      path: filePath,
      languageId: ext,
    };
  }
  // 2. Match markdown code blocks: ```python ... ```
  const codeBlockMatch = text.match(/```(?:([a-zA-Z0-9_-]+))?\r?\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    return {
      content: codeBlockMatch[2],
      path: "",
      languageId: codeBlockMatch[1] || "python",
    };
  }
  return { content: "", path: "", languageId: "" };
}

/**
 * Extracts Python/JS function and class signatures from a code string.
 * Used for structural divergence (c3) and structural identity (c8) computation.
 */
export function extractFunctionSignatures(code: string): string[] {
  const sigs: string[] = [];
  // Python: def func_name(...) and async def
  const pyDef = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  // Python: class ClassName(...)
  const pyCls = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/gm;
  // JS/TS: named function declaration
  const jsFn = /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  // JS/TS: arrow function — MUST have => to avoid false-positive on (a + b) * c
  // Pattern: const name = (...) => or const name = async (...) =>
  const jsArrow = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/gm;
  // TS/JS: method shorthand in object/class: methodName(...) {
  const jsMethod = /^\s{2,}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/gm;

  let m: RegExpExecArray | null;
  while ((m = pyDef.exec(code)) !== null) sigs.push(`def:${m[1]}`);
  while ((m = pyCls.exec(code)) !== null) sigs.push(`cls:${m[1]}`);
  while ((m = jsFn.exec(code)) !== null) sigs.push(`fn:${m[1]}`);
  while ((m = jsArrow.exec(code)) !== null) sigs.push(`arr:${m[1]}`);
  while ((m = jsMethod.exec(code)) !== null) sigs.push(`method:${m[1]}`);

  return sigs;
}

/**
 * Python/JS structural keywords preserved during code normalization.
 * All other identifiers become "VAR" to expose the control-flow skeleton.
 */
const LANG_KEYWORDS = new Set([
  // Python keywords
  "def", "class", "if", "elif", "else", "for", "while", "try", "except",
  "finally", "with", "return", "yield", "import", "from", "as", "pass",
  "break", "continue", "and", "or", "not", "in", "is", "lambda", "None",
  "True", "False", "del", "global", "nonlocal", "raise", "assert", "async", "await",
  // Python common builtins (structural relevance)
  "print", "range", "len", "int", "str", "float", "bool", "list", "dict",
  "set", "tuple", "self", "type", "input", "open", "sum", "max", "min",
  "abs", "sorted", "reversed", "enumerate", "zip", "map", "filter", "any", "all",
  // JS/TS keywords
  "function", "const", "let", "var", "new", "this", "typeof", "instanceof",
  "null", "undefined", "true", "false", "export", "default", "throw",
  "switch", "case", "import",
]);

/**
 * Normalizes code structure for structural skeleton comparison (c8).
 *
 * Critically, this preserves INDENTATION DEPTH as a prefix on each line.
 * This prevents false positives where two different algorithms with the same
 * keywords but different nesting depth (e.g. bubble_sort vs insertion_sort)
 * would otherwise be mistaken for structurally identical.
 *
 * Pipeline per line:
 *   1. Measure indent depth (each 4-space / 1-tab = 1 level)
 *   2. Strip inline comments
 *   3. Collapse strings → STR, numbers → NUM
 *   4. Replace non-keyword identifiers → VAR
 *   5. Prefix normalized line with depth: "2:for VAR in range(VAR):"
 */
export function normalizeCodeStructure(code: string): string {
  // Pre-process: collapse multiline docstrings first (before line-splitting)
  const noDocstrings = code
    .replace(/\"\"\"[\s\S]*?\"\"\"/g, '"""STR"""')
    .replace(/'''[\s\S]*?'''/g, "'''STR'''");

  return noDocstrings
    .split(/\r?\n/)
    .map((line) => {
      // Measure indentation depth: 4 spaces or 1 tab = 1 level
      const indentMatch = line.match(/^([ \t]*)/);
      const rawIndent = indentMatch ? indentMatch[1] : "";
      const depth = rawIndent.replace(/\t/g, "    ").length >> 2; // integer division by 4

      // Strip inline comments (after string collapse to avoid stripping # inside strings)
      const noComment = line.replace(/#[^'"]*$/, "").replace(/\/\/[^'"]*$/, "");

      // Collapse remaining string literals
      const noStrings = noComment
        .replace(/"(?:[^"\\]|\\.)*"/g, "STR")
        .replace(/'(?:[^'\\]|\\.)*'/g, "STR")
        .replace(/`(?:[^`\\]|\\.)*`/g, "STR");

      // Collapse numeric literals
      const noNums = noStrings.replace(/\b\d+(?:\.\d+)?([eE][+-]?\d+)?\b/g, "NUM");

      // Replace non-keyword identifiers with VAR
      const normalized = noNums
        .replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (word) =>
          LANG_KEYWORDS.has(word) ? word : "VAR",
        )
        .trim();

      if (!normalized) return null;
      // Prefix with depth so nesting structure is preserved in the LCS comparison
      return `${depth}:${normalized}`;
    })
    .filter((line): line is string => line !== null && line.length > 0)
    .join("\n");
}

/**
 * Computes the programmatic (algorithmic) features for a given turn.
 * These features are derived purely from deterministic measurements:
 * clock time, LCS ratios, and line counts — no natural language processing.
 *
 * Features computed here:
 *   Trajectory : t9  (minimal_effort_between_turns — clock measurement)
 *                t10 (recurring_delegate_across_session — explicit delegation directives)
 *   Code-diff  : c1  (student modification ratio — 1 - max LCS)
 *                c2  (incremental small changes — snapshot line deltas)
 *                c3  (structural divergence — function signature set diff)
 *                c6  (exact copy ratio — LCS against last AI response)
 *                c7  (single large jump — sudden line count increase)
 *                c8  (structural identity — normalized skeleton LCS)
 *                c9  (no intermediate edits — stasis + copy heuristic)
 *                c10 (zero test activity — high-precision prompt scan)
 *
 * NOTE: For t10, programmatic detection identifies explicit delegation phrasing across
 * the sliding window as a deterministic anchor, which is then blended with the LLM
 * evaluator's semantic understanding (PROG_TRUST[t10] = 0.35).
 */
export function calculateProgrammaticFeatures(
  prompt: string,
  response: string,
  clientContext: ClientContext | null,
  lastTurn: TurnLog | null,
  timeDeltaSeconds: number,
  recentTurns: TurnLog[] = [],
): Record<string, number> {
  const features: Record<string, number> = {};

  // ─────────────────────────────────────────────────────────────────
  // TRAJECTORY FEATURES
  // ─────────────────────────────────────────────────────────────────

  // t9: minimal_effort_between_turns (weight: 0.55)
  let t9Activation = 0;
  if (timeDeltaSeconds > 0 && timeDeltaSeconds < 15) {
    const hasAiCode =
      lastTurn && extractCodeBlocks(lastTurn.response).trim().length > 0;
    if (hasAiCode) {
      t9Activation = timeDeltaSeconds < 8 ? 1.0 : 0.5;
    }
  }
  features["t9"] = t9Activation;

  // t10: recurring_delegate_across_session (weight: 0.75)
  // Programmatic detection of explicit delegation directives across the sliding window.
  // Blended with LLM semantic evaluation via PROG_TRUST[t10] = 0.35.
  const delegatePatterns = [
    /\b(write|generate|create|implement)\b.{0,30}\b(for me|code for me|it for me|solution for me)\b/i,
    /\bwrite (?:it|this|the code|a solution|the solution) for me\b/i,
    /\bdo (?:it|this|the assignment|the homework|the whole thing|everything) for me\b/i,
    /\bfix (?:it|this|the code|my code|the error) for me\b/i,
    /\b(solve|complete)\b.{0,20}\bfor me\b/i,
    /\b(give|provide|send) me (the )?(code|solution|answer)\b/i,
    /\bjust (write|code|fix|give me the) (the |it|code)\b/i,
  ];
  const windowPrompts = [
    ...recentTurns.slice(-(IEM_WINDOW_SIZE - 1)).map((turn) => turn.prompt),
    prompt,
  ];
  const delegatedTurnCount = windowPrompts.filter((turnPrompt) =>
    delegatePatterns.some((pattern) => pattern.test(turnPrompt)),
  ).length;
  const t10Activation =
    delegatedTurnCount >= 3 ? 1.0 : delegatedTurnCount === 2 ? 0.75 : delegatedTurnCount === 1 ? 0.25 : 0;
  features["t10"] = t10Activation;

  // ─────────────────────────────────────────────────────────────────
  // CODE-DIFF FEATURES — EXECUTIVE (c6, c7, c8, c9, c10)
  // ─────────────────────────────────────────────────────────────────

  // c6: exact_copy_ratio (weight: 0.90)
  let c6Activation = 0;
  if (lastTurn && clientContext?.activeFile?.content) {
    const lastAiCode = extractCodeBlocks(lastTurn.response);
    if (lastAiCode.trim().length > 0) {
      const ratio = fastLineLCS(lastAiCode, clientContext.activeFile.content);
      if (ratio >= 0.85) c6Activation = 1.0;
      else if (ratio >= 0.50) c6Activation = 0.5;
      else if (ratio >= 0.20) c6Activation = 0.25;
    }
  }
  features["c6"] = c6Activation;

  // c7: single_large_jump (weight: 0.90)
  // Signal: code went from nearly empty to nearly complete in one turn
  let c7Activation = 0;
  if (clientContext?.activeFile?.content) {
    const studentLines = clientContext.activeFile.content
      .split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const prevLines = (lastTurn?.codeSnapshot || "")
      .split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const linesAdded = studentLines - prevLines;
    if (linesAdded > 40 && prevLines < 15) {
      c7Activation = linesAdded > 80 ? 1.0 : 0.75;
    }
  }
  features["c7"] = c7Activation;

  // c8: structural_identity_with_ai (weight: 0.85)
  // Signal: after stripping identifiers/values, student code skeleton matches AI output
  // Catches copy-with-renaming: same logic, different variable names
  let c8Activation = 0;
  if (lastTurn && clientContext?.activeFile?.content) {
    const lastAiCode8 = extractCodeBlocks(lastTurn.response);
    if (lastAiCode8.trim().length > 20) {
      const normAi = normalizeCodeStructure(lastAiCode8);
      const normStudent = normalizeCodeStructure(clientContext.activeFile.content);
      if (normAi.length > 0 && normStudent.length > 0) {
        const structRatio = fastLineLCS(normAi, normStudent);
        if (structRatio >= 0.80) c8Activation = 1.0;
        else if (structRatio >= 0.60) c8Activation = 0.75;
        else if (structRatio >= 0.40) c8Activation = 0.50;
        else if (structRatio >= 0.20) c8Activation = 0.25;
      }
    }
  }
  features["c8"] = c8Activation;

  // c9: no_intermediate_edits (weight: 0.80)
  // Signal: current code ≈ last snapshot + AI paste, no real student editing in between
  // Two-signal heuristic: stasis (code barely changed) + high exact-copy ratio
  let c9Activation = 0;
  const c6Val = features["c6"] ?? 0;
  if (lastTurn?.codeSnapshot && clientContext?.activeFile?.content) {
    const stasisRatio = fastLineLCS(lastTurn.codeSnapshot, clientContext.activeFile.content);
    if (stasisRatio >= 0.90 && c6Val >= 0.70) {
      // Code nearly unchanged from last snapshot AND matches AI closely
      c9Activation = 1.0;
    } else if (stasisRatio >= 0.75 && c6Val >= 0.50) {
      c9Activation = 0.75;
    } else if (c6Val >= 0.70 && timeDeltaSeconds < 20) {
      // High copy + very short time between turns
      c9Activation = timeDeltaSeconds < 10 ? 0.75 : 0.50;
    }
  } else if (c6Val >= 0.85 && timeDeltaSeconds > 0 && timeDeltaSeconds < 10) {
    // Fallback: near-perfect copy + nearly instant re-prompt
    c9Activation = 0.50;
  }
  features["c9"] = c9Activation;

  // c10: zero_own_test_activity (weight: 0.65)
  // Signal: no evidence of test/execution output in any window prompt or IDE terminal.
  // Ground truth: When IDE terminal telemetry is present, actual script executions and test
  // runs are directly tracked.
  const testEvidencePatterns = [
    // Python full traceback — very specific, almost never false-positive
    /traceback \(most recent call last\)/i,
    // Python exception lines with file/line context (only appears in real tracebacks)
    /File "[^"]+", line \d+/,
    // Pytest/unittest result summary (specific format: "X failed", "X passed")
    /\b\d+\s+(?:failed|passed|error)(?:\s+in\s+[\d.]+s)?\b/i,
    // Python assertion output: "AssertionError: X != Y"
    /\bassertionerror:\s*.+/i,
    // Python REPL prompt at START of line only (prevents matching inside strings)
    /^\s*>>>\s+\S/m,
    // Output section explicitly labeled (e.g. "Output:\n5\n")
    /\boutput\s*:\s*\n\s*\S/i,
    // Test case format used in competitive programming judges
    /\btest case \d+:\s*(?:passed|failed|wrong)/i,
  ];

  const terminalExecutionPatterns = [
    // Commands running scripts or tests:
    /(?:^|\n|\$|>)\s*(?:python[0-9.]*|py|pytest|unittest|node|bun|ts-node|npm test|cargo test|go test|javac|java)\b/i,
    // Python traceback:
    /traceback \(most recent call last\)/i,
    /File "[^"]+", line \d+/,
    // Test execution summary:
    /\b\d+\s+(?:failed|passed|error)(?:\s+in\s+[\d.]+s)?\b/i,
    /\bRan \d+ tests? in [\d.]+s/i,
    /\bOK(?:\s*\(.*?\))?$/m,
    /\bFAILED\s*\(.*?\)/i,
    // Assertion or common runtime exceptions:
    /\bassertionerror:\s*.+/i,
    /\b(?:syntaxerror|nameerror|typeerror|indexerror|valueerror|zerodivisionerror|attributeerror):\s*.+/i,
    // Process exit indicator from TerminalTracker:
    /\[Process exited with code \d+\]/i,
    /\btest case \d+:\s*(?:passed|failed|wrong)/i,
  ];

  const allWindowPrompts = [...recentTurns.map((t) => t.prompt), prompt];
  const hasPromptTestEvidence = allWindowPrompts.some((p) =>
    testEvidencePatterns.some((pattern) => pattern.test(p)),
  );

  const hasTerminalTelemetry =
    Boolean(clientContext?.recentTerminal) ||
    recentTurns.some((t) => Boolean(t.terminalOutput || t.lastTerminalCommand));

  const isTerminalRunEvidence = (output?: string, cmd?: string, exitCode?: number): boolean => {
    if (cmd && /(?:^|\s)(?:python[0-9.]*|py|pytest|unittest|node|bun|npm test|javac|java)\b/i.test(cmd)) {
      return true;
    }
    if (output && (terminalExecutionPatterns.some((p) => p.test(output)) || testEvidencePatterns.some((p) => p.test(output)))) {
      return true;
    }
    if (exitCode !== undefined && output && output.trim().length > 0) {
      return true;
    }
    return false;
  };

  const currentTerminalActive = isTerminalRunEvidence(
    clientContext?.recentTerminal?.output,
    clientContext?.recentTerminal?.lastCommand,
    clientContext?.recentTerminal?.exitCode,
  );

  const priorTerminalActive = recentTurns.some((t) =>
    isTerminalRunEvidence(t.terminalOutput, t.lastTerminalCommand),
  );

  const hasTestEvidence = hasPromptTestEvidence || currentTerminalActive || priorTerminalActive;

  if (hasTerminalTelemetry) {
    features["_hasTerminalTelemetry"] = 1;
    // With IDE telemetry, confirmation of zero test activity across turns is ground truth.
    features["c10"] = hasTestEvidence
      ? 0
      : recentTurns.length >= 3
        ? 1.0
        : recentTurns.length >= 2
          ? 0.75
          : recentTurns.length >= 1
            ? 0.50
            : 0.25;
  } else {
    // Legacy prompt-scan fallback without IDE telemetry (capped at 0.75)
    features["c10"] = hasTestEvidence
      ? 0
      : recentTurns.length >= 3
        ? 0.75
        : recentTurns.length >= 1
          ? 0.50
          : 0.25;
  }

  // ─────────────────────────────────────────────────────────────────
  // CODE-DIFF FEATURES — INSTRUMENTAL (c1, c2, c3)
  // ─────────────────────────────────────────────────────────────────

  // c1: high_student_modification_ratio (weight: 0.85)
  // Signal: current code has significant portions NOT from any AI response in window
  // Computation: 1 - max(LCS(aiResponse_i, currentCode)) over all window AI responses
  let c1Activation = 0;
  if (clientContext?.activeFile?.content) {
    const studentCode = clientContext.activeFile.content;
    const allAiCodeBlocks = recentTurns
      .map((t) => extractCodeBlocks(t.response))
      .filter((code) => code.trim().length > 10);

    if (allAiCodeBlocks.length > 0) {
      const maxLcsRatio = Math.max(
        ...allAiCodeBlocks.map((aiCode) => fastLineLCS(aiCode, studentCode)),
      );
      const studentOwnRatio = 1 - maxLcsRatio;
      if (studentOwnRatio >= 0.75) c1Activation = 1.0;
      else if (studentOwnRatio >= 0.50) c1Activation = 0.75;
      else if (studentOwnRatio >= 0.30) c1Activation = 0.50;
      else if (studentOwnRatio >= 0.10) c1Activation = 0.25;
    } else {
      // No AI code in window → all student's own work
      c1Activation = 1.0;
    }
  }
  features["c1"] = c1Activation;

  // c2: incremental_small_step_changes (weight: 0.75)
  // Signal: code grows in small, steady increments → consistent with guided effort
  // Computation: average absolute line-delta between consecutive turn snapshots
  let c2Activation = 0;
  const snapshots = recentTurns
    .filter((t) => t.codeSnapshot && t.codeSnapshot.trim().length > 0)
    .map((t) => t.codeSnapshot!.split(/\r?\n/).filter((l) => l.trim().length > 0).length);

  if (snapshots.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      deltas.push(Math.abs(snapshots[i] - snapshots[i - 1]));
    }
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (avgDelta <= 8) c2Activation = 1.0;
    else if (avgDelta <= 15) c2Activation = 0.75;
    else if (avgDelta <= 25) c2Activation = 0.50;
    else if (avgDelta <= 40) c2Activation = 0.25;
    // avgDelta > 40 → 0 (large jumps, not incremental)
  }
  features["c2"] = c2Activation;

  // c3: structural_divergence_from_ai (weight: 0.70)
  // Signal: student's function/class signatures differ from the last AI suggestion
  // Indicates student restructured the solution rather than copying structure verbatim
  let c3Activation = 0;
  if (lastTurn && clientContext?.activeFile?.content) {
    const lastAiCode3 = extractCodeBlocks(lastTurn.response);
    if (lastAiCode3.trim().length > 0) {
      const aiSigs = extractFunctionSignatures(lastAiCode3);
      const studentSigs = extractFunctionSignatures(clientContext.activeFile.content);
      if (aiSigs.length > 0 && studentSigs.length > 0) {
        const aiSet = new Set(aiSigs.map((s) => s.toLowerCase()));
        const studentSet = new Set(studentSigs.map((s) => s.toLowerCase()));
        const intersection = [...aiSet].filter((s) => studentSet.has(s)).length;
        const unionSize = Math.max(aiSet.size, studentSet.size);
        const divergenceRatio = unionSize > 0 ? 1 - intersection / unionSize : 0;
        if (divergenceRatio >= 0.70) c3Activation = 1.0;
        else if (divergenceRatio >= 0.45) c3Activation = 0.75;
        else if (divergenceRatio >= 0.25) c3Activation = 0.50;
        else if (divergenceRatio >= 0.10) c3Activation = 0.25;
      } else if (aiSigs.length === 0 && studentSigs.length > 0) {
        // AI gave no named functions but student has own structure → diverged
        c3Activation = 0.50;
      }
    }
  }
  features["c3"] = c3Activation;

  return features;
}

/**
 * Per-feature programmatic trust level [0.0 .. 1.0].
 * Controls how much the algorithmic (programmatic) value outweighs the LLM semantic value
 * when both sources produce an activation for the same feature.
 * llmTrust = 1 - PROG_TRUST[key].
 *
 * Calibration rationale:
 *  1.00 — pure deterministic truth (clock, LCS ratio): LLM adds nothing
 *  0.80-0.90 — highly reliable algorithmic signal, LLM provides minor nuance
 *  0.55-0.65 — decent structural heuristic; LLM and programmatic are complementary
 *  0.25-0.45 — proxy/heuristic signal; LLM semantic understanding dominates
 */
export const PROG_TRUST: Record<string, number> = {
  // ── Trajectory ──────────────────────────────────────────────────
  t9: 1.00,  // exact clock measurement: LLM is irrelevant
  t10: 0.35, // recurring delegation: LLM dominates (0.65) because true delegation
             // is semantic intent, but programmatic regex provides a deterministic anchor (0.35).

  // ── Code-diff: pure algorithmic (LCS + arithmetic) ──────────────
  c6: 1.00,  // exact copy ratio: fastLineLCS ground truth
  c7: 1.00,  // single large jump: line count arithmetic truth
  c1: 0.85,  // student modification ratio: 1−max(LCS), very reliable
  c2: 0.80,  // incremental steps: snapshot line-count deltas, reliable

  // ── Code-diff: structural heuristic ─────────────────────────────
  c8: 0.60,  // structural identity via normalized LCS + indent-depth.
             // Solid, but misses semantic equiv (e.g. loop vs comprehension).
             // LLM catches these remaining 40%.
  c3: 0.55,  // function signature divergence via regex.
             // Accurate for Python def/class; weaker for complex JS closures.
             // LLM handles anonymous patterns and renamed-but-equivalent structures.

  // ── Code-diff: heuristic combination (proxy signals) ────────────
  c9: 0.40,  // no-intermediate-edits: (stasis × c6) heuristic.
             // LLM is better at detecting no-edit intent from phrasing.
  c10: 0.25, // zero test activity: prompt-scan has high false-negative rate
             // (student ran code but didn't paste output). LLM understands
             // absence of testing behavior from conversational cues.
};

/**
 * Blends programmatic and LLM semantic feature activations using PROG_TRUST weights.
 *
 * Merge strategy (replaces the previous naive { ...semantic, ...programmatic } overwrite):
 *  • Feature ONLY in programmatic (c6, c7, t9):              pass through as-is
 *  • Feature ONLY in LLM (i1–i8, e1–e6, r1–r8, t1–t8, c4, c5): pass through as-is
 *  • Feature in BOTH (c1–c3, c8–c10, t10):                   weighted blend:
 *      blended = progTrust × programmatic + (1 − progTrust) × semantic
 *
 * The blend achieves:
 *  - Consensus amplification: when both sources agree (both 1.0 or both 0.0), result stays at extreme
 *  - Disagreement dampening: when sources conflict, result moves to a moderate value reflecting uncertainty
 *  - Explainability: the PROG_TRUST table makes the weighting auditable and tunable
 *
 * @param semantic     Feature map from LLM evaluator
 * @param programmatic Feature map from calculateProgrammaticFeatures
 * @param debugLog     Optional callback for logging per-feature blend (research/debugging)
 */
export function blendFeatures(
  semantic: Record<string, number>,
  programmatic: Record<string, number>,
  debugLog?: (key: string, prog: number, llm: number, blended: number) => void,
): Record<string, number> {
  const allKeys = new Set([
    ...Object.keys(semantic),
    ...Object.keys(programmatic),
  ]);
  const result: Record<string, number> = {};

  for (const key of allKeys) {
    const hasS = key in semantic;
    const hasP = key in programmatic;

    if (hasP && !hasS) {
      // Programmatic-only (c6, c7, t9) — pass through
      result[key] = programmatic[key];
    } else if (hasS && !hasP) {
      // LLM-only (i1–i8, e1–e6, r1–r8, t1–t8, c4, c5) — pass through
      result[key] = semantic[key];
    } else {
      // Both sources available — weighted blend
      let progTrust = PROG_TRUST[key] ?? 0.50; // default 50/50 for unknown features
      if (key === "c10" && programmatic["_hasTerminalTelemetry"]) {
        progTrust = 0.85; // High confidence when terminal telemetry is present
      }
      const pVal = programmatic[key];
      const sVal = semantic[key];
      const blended = Math.min(1.0, Math.max(0.0, progTrust * pVal + (1 - progTrust) * sVal));
      result[key] = blended;
      debugLog?.(key, pVal, sVal, blended);
    }
  }

  delete result["_hasTerminalTelemetry"];
  return result;
}
