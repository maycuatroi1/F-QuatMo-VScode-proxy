/**
 * Computes the Longest Common Subsequence (LCS) ratio between two code files
 * based on line-by-line comparison.
 * To protect the Node event loop under high CCU, it trims whitespace, hashes lines,
 * and runs LCS on hash arrays (O(L1 * L2)), capping at 500 lines.
 */
export function fastLineLCS(aiCode: string, studentCode: string): number {
  const prep = (code: string): string[] => {
    return code
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const aiLines = prep(aiCode);
  const studentLines = prep(studentCode);

  if (aiLines.length === 0) return 0;
  if (studentLines.length === 0) return 0;

  const MAX_LINES = 500;
  const L1 = Math.min(aiLines.length, MAX_LINES);
  const L2 = Math.min(studentLines.length, MAX_LINES);

  const lineToId = new Map<string, number>();
  let nextId = 1;
  const getId = (line: string): number => {
    let id = lineToId.get(line);
    if (id === undefined) {
      id = nextId++;
      lineToId.set(line, id);
    }
    return id;
  };

  const aiIds = aiLines.slice(0, L1).map(getId);
  const studentIds = studentLines.slice(0, L2).map(getId);

  const dp: number[] = new Array(L2 + 1).fill(0);

  for (let i = 1; i <= L1; i++) {
    let prev = 0;
    for (let j = 1; j <= L2; j++) {
      const temp = dp[j];
      if (aiIds[i - 1] === studentIds[j - 1]) {
        dp[j] = prev + 1;
      } else {
        dp[j] = Math.max(dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  const lcsLength = dp[L2];
  return lcsLength / L1;
}

/**
 * Computes Levenshtein Distance between two small strings.
 * Caps at MAX_CHARS to prevent CPU blocking on single-threaded JS.
 */
export function boundedLevenshtein(
  str1: string,
  str2: string,
  maxChars = 2000,
): number {
  if (str1.length > maxChars || str2.length > maxChars) {
    return -1;
  }

  const m = str1.length;
  const n = str2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let currRow: number[] = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,
        prevRow[j] + 1,
        prevRow[j - 1] + cost,
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[n];
}
