/** Parse JSONL without allocating a second full-size line array for large telemetry logs. */
export function appendJsonLines(content: string, target: any[]): void {
  let lineStart = 0;
  for (let index = 0; index <= content.length; index++) {
    if (index !== content.length && content.charCodeAt(index) !== 10) continue;
    const line = content.slice(lineStart, index).trim();
    lineStart = index + 1;
    if (!line) continue;
    try {
      target.push(JSON.parse(line));
    } catch {
      // Logs are best-effort: retain valid telemetry around malformed lines.
    }
  }
}

export function hasNonEmptyLine(content: string): boolean {
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) > 32) return true;
  }
  return false;
}

export function countNonEmptyLines(content: string): number {
  let count = 0;
  let lineStart = 0;
  for (let index = 0; index <= content.length; index++) {
    if (index !== content.length && content.charCodeAt(index) !== 10) continue;
    if (content.slice(lineStart, index).trim()) count++;
    lineStart = index + 1;
  }
  return count;
}
