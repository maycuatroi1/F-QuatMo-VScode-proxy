import { redisStore } from "../../services/classifier/redisStore";

export async function resolveTerminalActivity(
  sessionCode: string,
  studentId: string,
  recentTerminal: any,
  terminalOutput: any,
) {
  if (recentTerminal) {
    if (recentTerminal.timestamp !== undefined) {
      return recentTerminal;
    }
    const existing = await redisStore
      .getClientContext(sessionCode, studentId)
      .catch(() => null);
    if (
      existing?.recentTerminal &&
      existing.recentTerminal.output === recentTerminal.output &&
      existing.recentTerminal.lastCommand === recentTerminal.lastCommand
    ) {
      return {
        ...recentTerminal,
        timestamp: existing.recentTerminal.timestamp,
      };
    }
    return recentTerminal;
  }
  if (!terminalOutput) return undefined;
  const existing = await redisStore
    .getClientContext(sessionCode, studentId)
    .catch(() => null);
  if (
    existing?.recentTerminal &&
    existing.recentTerminal.output === terminalOutput
  ) {
    return existing.recentTerminal;
  }
  return { output: terminalOutput, timestamp: Date.now() };
}
