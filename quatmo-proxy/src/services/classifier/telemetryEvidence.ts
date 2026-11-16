/** Shared evidence contract. Omitted numeric entries mean unobservable, not false. */
export function normalizeLanguage(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** Strip quoted material and automatic attachments before lexical intent detection. */
export function authoredRequest(text: string): string {
  return normalizeLanguage(text
    .replace(/--- (?:ACTIVE OPEN EDITOR FILE|ATTACHED TARGET FILE):[^\n]*\n[\s\S]*?\n---------------------/g, " ")
    .replace(/\[TARGET FILE DIRECTIVE\]:[^\n]*/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”/g, " "));
}

export function isDelegationRequest(text: string): boolean {
  return authoredRequest(text).split(/[,.!?;\n]+|\b(?:nhung|but)\b/).some((clause) => {
    // Scope negatives to their clause; an independent later command can survive.
    if (/\b(?:khong|dung|chua can)\s+(?:can\s+)?(?:viet|code|lam|sua|fix|giai|them|thay)|\b(?:do not|don't|never)\s+(?:write|code|solve|fix|implement)/.test(clause)) return false;
    if (/\b(?:giai thich|explain|review|kiem tra|danh gia)\b/.test(clause) &&
        !/\b(?:viet|code|lam ho|lam giup|sua|fix|implement|write|thay|them vao)\b/.test(clause)) return false;
    return [
      /\b(?:viet|lam|sua|fix|tao|hoan thanh|thay|them)\b.{0,55}\b(?:ho|giup|cho em|cho minh|cho toi|cho anh|cho tui)\b/,
      /\b(?:sua|fix)\s+cho\b/,
      /\bgiup\s+(?:(?:minh|em|toi|tui)\s+)?(?:viet|lam|sua|fix|tao|hoan thanh|thay|them|giai bai)\b/,
      /\b(?:code not|code tiep|code cho|code giup|code ho|lam not|them vao code|giai bai nay|giai giup|giai ho)\b/,
      // A general request for code is e1. Require a task target to rescue e2.
      /\b(?:cho|gui)\s+(?:(?:minh|em|toi|tui)\s+)?(?:xin\s+)?(?:full\s+)?code\s+(?:bai|task|ham|phan)\b/,
      /\b(?:write|generate|create|implement|solve|complete|fix)\b.{0,70}\bfor me\b/,
      /\b(?:give|provide|send) me\s+(?:the\s+)?(?:solution|answer)\b/,
      /\bdo\s+(?:it|this|the assignment|the homework|everything)\s+for me\b/,
    ].some((pattern) => pattern.test(clause));
  });
}

export interface ObservedTerminal {
  output?: string;
  lastCommand?: string;
  exitCode?: number;
  commandType?: string;
  timestamp?: number;
}

export function isExecutionEvidence(terminal?: ObservedTerminal): boolean {
  if (!terminal) return false;
  const command = terminal.lastCommand || "";
  // Match executable positions, not `echo python app.py`, `cat pytest.log`, or pip install.
  const executable = /(?:^|&&|;|\||\n)\s*(?:&\s*)?(?:"[^"\r\n]*[/\\]|'[^'\r\n]*[/\\]|[^\s"']*[/\\])?(?:python[\d.]*|py|pytest|unittest|flask|node|bun|ts-node|java|javac)(?:\.exe)?["']?(?=\s|$)/i;
  const knownCommand = executable.test(command) && !/(?:-m\s+pip\b|--version\b|--help\b|\binstall\b)/i.test(command) ||
    /(?:^|&&|;|\n)\s*(?:npm\s+(?:test|run\s+(?:test|build|start))|cargo\s+(?:test|run|build)|go\s+(?:test|run|build))\b/i.test(command);
  const output = terminal.output || "";
  const executionOutput = /traceback \(most recent call last\)|\b(?:AssertionError|SyntaxError|NameError|TypeError|IndexError|ValueError|ZeroDivisionError|AttributeError):|\b\d+\s+(?:passed|failed|errors?)\b|\btests?\s*[:=]\s*(?:pass(?:ed)?|fail(?:ed)?)\b|\bRan \d+ tests?\b|Running on https?:\/\/|Debugger (?:PIN|is active)|HTTP\/1\.[01]|\b(?:returncode|exit\s*code)\s*[:=]?\s*-?\d+/i.test(output);
  const observedType = /^(?:EXECUTION|TEST|BUILD|RUN)$/i.test(terminal.commandType || "");
  return Boolean(knownCommand || executionOutput || observedType &&
    (command.trim() || output.trim() || terminal.exitCode !== undefined));
}

export function codeLines(code: string): string[] {
  return code.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^(?:#|\/\/)/.test(line));
}

/** Full line LCS with current-side matched indices; never silently truncate to 500 lines. */
export function matchedCurrentLines(current: string[], proposed: string[]): Set<number> | undefined {
  const n = current.length, m = proposed.length;
  if ((n + 1) * (m + 1) > 4_000_000) return undefined; // explicit abstention
  const table = new Uint32Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    table[i * width + j] = current[i - 1] === proposed[j - 1]
      ? table[(i - 1) * width + j - 1] + 1
      : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
  }
  const indices = new Set<number>();
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (current[i - 1] === proposed[j - 1]) { indices.add(--i); j--; }
    else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) i--;
    else j--;
  }
  return indices;
}

