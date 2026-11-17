import path from "path";

export interface GuestLogSource {
  filePath: string;
  lastActivity: number;
}

export function prefersGuestLogSource(candidate: GuestLogSource, current?: GuestLogSource): boolean {
  if (!current) return true;
  if (candidate.lastActivity !== current.lastActivity) return candidate.lastActivity > current.lastActivity;
  const candidateDir = path.basename(path.dirname(candidate.filePath));
  const currentDir = path.basename(path.dirname(current.filePath));
  if (candidateDir !== currentDir) return candidateDir === "guests";
  return candidate.filePath.endsWith(".json") && !current.filePath.endsWith(".json");
}
