import { IEM_WINDOW_SIZE } from "./weights";
import type { ClientContext as ClientContextData, TurnLog as TurnEvaluationState } from "./redisStore";
import { codeLines, matchedCurrentLines, isDelegationRequest, isExecutionEvidence } from "./telemetryEvidence";
export { isDelegationRequest, isExecutionEvidence } from "./telemetryEvidence";

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
 */
export function extractFunctionSignatures(code: string): string[] {
  const sigs: string[] = [];
  const pyDef = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  const pyCls = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/gm;
  const jsFn = /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  const jsArrow = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/gm;
  const jsMethod = /^\s{2,}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/gm;

  let m: RegExpExecArray | null;
  while ((m = pyDef.exec(code)) !== null) sigs.push(`def:${m[1]}`);
  while ((m = pyCls.exec(code)) !== null) sigs.push(`cls:${m[1]}`);
  while ((m = jsFn.exec(code)) !== null) sigs.push(`fn:${m[1]}`);
  while ((m = jsArrow.exec(code)) !== null) sigs.push(`arr:${m[1]}`);
  while ((m = jsMethod.exec(code)) !== null) sigs.push(`method:${m[1]}`);

  return sigs;
}

const LANG_KEYWORDS = new Set([
  "def", "class", "if", "elif", "else", "for", "while", "try", "except",
  "finally", "with", "return", "yield", "import", "from", "as", "pass",
  "break", "continue", "and", "or", "not", "in", "is", "lambda", "None",
  "True", "False", "del", "global", "nonlocal", "raise", "assert", "async", "await",
  "print", "range", "len", "int", "str", "float", "bool", "list", "dict",
  "set", "tuple", "self", "type", "input", "open", "sum", "max", "min",
  "abs", "sorted", "reversed", "enumerate", "zip", "map", "filter", "any", "all",
  "function", "const", "let", "var", "new", "this", "typeof", "instanceof",
  "null", "undefined", "true", "false", "export", "default", "throw",
  "switch", "case", "import",
]);

export function normalizeCodeStructure(code: string): string {
  const noDocstrings = code
    .replace(/\"\"\"[\s\S]*?\"\"\"/g, '"""STR"""')
    .replace(/'''[\s\S]*?'''/g, "'''STR'''");

  return noDocstrings
    .split(/\r?\n/)
    .map((line) => {
      const indentMatch = line.match(/^([ \t]*)/);
      const rawIndent = indentMatch ? indentMatch[1] : "";
      const depth = rawIndent.replace(/\t/g, "    ").length >> 2;

      const noComment = line.replace(/#[^'"]*$/, "").replace(/\/\/[^'"]*$/, "");
      const noStrings = noComment
        .replace(/"(?:[^"\\]|\\.)*"/g, "STR")
        .replace(/'(?:[^'\\]|\\.)*'/g, "STR")
        .replace(/`(?:[^`\\]|\\.)*`/g, "STR");
      const noNums = noStrings.replace(/\b\d+(?:\.\d+)?([eE][+-]?\d+)?\b/g, "NUM");
      const normalized = noNums
        .replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (word) =>
          LANG_KEYWORDS.has(word) ? word : "VAR",
        )
        .trim();

      if (!normalized) return null;
      return `${depth}:${normalized}`;
    })
    .filter((line): line is string => line !== null && line.length > 0)
    .join("\n");
}

/** Online detectors return binary observations. Missing keys are explicit abstentions. */
export function calculateProgrammaticFeatures(
  prompt: string,
  response: string,
  clientContext: ClientContextData | null,
  lastTurn: TurnEvaluationState | null,
  timeDeltaSeconds: number,
  recentTurns: TurnEvaluationState[] = [],
  currentSemantic: Record<string, number> = {},
): Record<string, number> {
  const features: Record<string, number> = {};
  // Caller partitions by conversation. Never read future turns or an unbounded session.
  const prior = (recentTurns.length ? recentTurns : lastTurn ? [lastTurn] : [])
    .slice(-(IEM_WINDOW_SIZE - 1));
  const lexicalDelegation = isDelegationRequest(prompt);
  const currentDelegation = lexicalDelegation || (currentSemantic.e2 ?? 0) > 0;
  if (lexicalDelegation) features.e2 = 1;
  const delegationCount = prior.filter(t => isDelegationRequest(t.prompt) ||
    (t.featureVector?.e2 ?? 0) > 0).length + Number(currentDelegation);
  features.t10 = Number(delegationCount >= 2);

  const terminal = clientContext?.recentTerminal;
  if (terminal && (terminal.output || terminal.lastCommand || terminal.commandType || terminal.exitCode !== undefined)) {
    const previous = prior.at(-1);
    const stale = previous && terminal.lastCommand === previous.lastTerminalCommand &&
      terminal.output === previous.terminalOutput &&
      (terminal.timestamp === undefined || terminal.timestamp <= previous.timestamp);
    features.t4 = Number(isExecutionEvidence(terminal) && !stale);
  }
  // Pasted prompt logs need semantic interpretation (e.g. quotation vs observed
  // output). Only structured terminal records receive programmatic authority.

  const snapshot = clientContext?.activeFile;
  if (!snapshot?.content?.trim()) return features;
  const current = codeLines(snapshot.content);
  if (!current.length) return features;
  const comparable = prior.filter(t => snapshot.path && t.activeFilePath &&
    snapshot.path.replace(/\\/g, "/") === t.activeFilePath.replace(/\\/g, "/"));
  const proposals = comparable.map(t => codeLines(extractCodeBlocks(t.response)))
    .filter(lines => lines.length);
  // Without an earlier AI proposal there is no denominator for this comparison.
  // Even an observed edit alone cannot establish a >=65% student-side ratio.
  if (!proposals.length) return features;

  // Exact copies need only linear work, even above the bounded LCS budget.
  if (proposals.some(ai => ai.length === current.length &&
      ai.every((line, index) => line === current[index]))) {
    features.c1 = 0;
    features.c5 = 0;
    features._exactCopyOnly = 1;
    return features;
  }

  const matched = new Set<number>();
  for (const ai of proposals) {
    const indices = matchedCurrentLines(current, ai);
    if (!indices) return features; // bounded work: leave c1 unknown, never approximate silently
    for (const index of indices) matched.add(index);
  }
  // Correct denominator: current snapshot lines. Union coverage prevents a file
  // assembled from multiple earlier AI blocks from masquerading as student work.
  const ownRatio = 1 - matched.size / current.length;
  features.c1 = Number(ownRatio >= 0.65 - 1e-12);
  if (matched.size === current.length) features._exactCopyOnly = 1;
  if (features._exactCopyOnly === 1) features.c5 = 0;
  // Otherwise c5 deliberately abstains: line novelty/signature renaming cannot
  // prove algorithmic novelty. The semantic extractor compares actual approaches.
  return features;
}

