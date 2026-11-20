import fs from "fs";
import path from "path";
import { decryptLogFile } from "./secureLogger";

const LOG_ENCRYPT_KEY = (process.env.LOG_ENCRYPT_KEY || "").trim();

interface PromptTurnRecord {
  timestamp: string;
  createdAt?: string;
  completedAt?: string;
  responseDurationMs?: number;
  conversationId?: string;
  prompt: string;
  output?: string;
  classification?: any;
  aiOption?: string;
  tokenLimit?: number;
  tokensConsumedTotal?: number;
  agentLoops?: any[];
  history?: any[];
  codeSnapshot?: string;
  activeFilePath?: string;
  activeFileLanguageId?: string;
  codeSnapshots?: any[];
  terminalOutput?: string;
  lastTerminalCommand?: string;
  commandType?: string;
  [key: string]: any;
}

const fileLocks = new Map<string, Promise<void>>();
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const current = fileLocks.get(key) || Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  const queued = current.then(() => next);
  fileLocks.set(key, queued);
  await current;
  try {
    return await fn();
  } finally {
    release!();
    if (fileLocks.get(key) === queued) {
      fileLocks.delete(key);
    }
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: any,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

export function safeParseJson<T = any>(raw: string): T | null {
  if (!raw) return null;
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export function isGhostPromptTurn(turn: PromptTurnRecord): boolean {
  if (!turn) return false;
  const p = (turn.prompt || "").toString();
  return (
    p.includes("Text before cursor:") ||
    p.includes("Text after cursor:") ||
    p.includes("You complete code. Return ONLY the completion") ||
    p.startsWith("Complete:\n")
  );
}

export async function reconcileStudentPromptTurns(
  sessionCode: string,
  studentId: string,
  sessionDir: string,
): Promise<{ turns: PromptTurnRecord[]; wasRepaired: boolean; source: string }> {
  const { reconcilePromptTurns } = await import("../shared/promptTurns");
  const id = studentId.toUpperCase();
  const entries = fs.existsSync(sessionDir) ? await fs.promises.readdir(sessionDir) : [];
  const find = (name: string) => path.join(sessionDir, entries.find((e) => e.toUpperCase() === name.toUpperCase()) || name);
  let rawTurns: any[] = [];
  const jsonPath = find(id + ".json");
  if (fs.existsSync(jsonPath)) {
    const parsed = safeParseJson(await fs.promises.readFile(jsonPath, "utf8"));
    if (Array.isArray(parsed)) rawTurns = parsed.filter((t) => !isGhostPromptTurn(t));
  }
  if (!rawTurns.length && fs.existsSync(find(id + ".log"))) {
    for (const key of [LOG_ENCRYPT_KEY, (process.env.CUSTOM_API_KEY || "").trim(), "1234", "secret"].filter(Boolean)) {
      try {
        const parsed = decryptLogFile(find(id + ".log"), key) as any[];
        rawTurns = parsed.filter((t) => t && !t._error && !isGhostPromptTurn(t));
        if (rawTurns.length) break;
      } catch {}
    }
  }
  const interactions: any[] = [];
  const legacyFile = path.join(find(id), "ai_interactions.jsonl");
  if (fs.existsSync(legacyFile)) {
    for (const line of (await fs.promises.readFile(legacyFile, "utf8")).split("\n")) {
      const parsed = safeParseJson(line);
      if (parsed) interactions.push(parsed);
    }
  }
  const recordsDir = path.join(find(id), "exam_records");
  if (fs.existsSync(recordsDir)) {
    for (const record of await fs.promises.readdir(recordsDir, { withFileTypes: true })) {
      if (!record.isDirectory()) continue;
      const file = path.join(recordsDir, record.name, "ai_interactions.jsonl");
      if (!fs.existsSync(file)) continue;
      for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const parsed = safeParseJson(line);
        if (parsed) interactions.push(parsed);
      }
    }
  }
  return { turns: reconcilePromptTurns(rawTurns, interactions), wasRepaired: false,
    source: fs.existsSync(jsonPath) || fs.existsSync(find(id + ".log")) ? "local_proxy_log" : "client_read_only" };
}
