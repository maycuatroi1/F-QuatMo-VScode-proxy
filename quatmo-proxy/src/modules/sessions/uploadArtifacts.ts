export function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

interface JsonlRecord {
  timestamp: number;
  type?: string;
  payload?: any;
  groupId?: number;
  [key: string]: any;
}

import { toMs } from "../../shared/sessionTime";
export { toMs };

interface SanitizeResult {
  buffer: Buffer;
  totalLines: number;
  inWindowLines: number;
  droppedPreSigninLines: number;
  droppedPostExpireLines: number;
  droppedOutsideDateLines: number;
}

export function sanitizeJsonlBuffer(
  buf: Buffer,
  minTimestampMs?: number | null,
  maxTimestampMs?: number | null,
  allowedDates?: Set<string>,
): SanitizeResult {
  const str = buf.toString("utf-8");
  const lines = str.split("\n");
  const keptLines: string[] = [];
  let totalLines = 0;
  let droppedPreSigninLines = 0;
  let droppedPostExpireLines = 0;
  let droppedOutsideDateLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;
    try {
      const obj = JSON.parse(trimmed);
      if (
        typeof obj === "object" &&
        obj !== null &&
        typeof obj.timestamp === "number"
      ) {
        const t = toMs(obj.timestamp);
        if (t) {
          if (allowedDates && allowedDates.size > 0) {
            const evDate = new Date(t).toISOString().slice(0, 10);
            if (!allowedDates.has(evDate)) {
              droppedOutsideDateLines++;
              continue; // Drop event from outside allowed session dates
            }
          }
          if (minTimestampMs && t < minTimestampMs) {
            droppedPreSigninLines++;
            continue; // Drop event prior to session boundary
          }
          if (maxTimestampMs && t > maxTimestampMs) {
            droppedPostExpireLines++;
            continue; // Drop event after session expiry boundary
          }
        }
      }
      keptLines.push(trimmed);
    } catch {
      keptLines.push(trimmed);
    }
  }

  return {
    buffer: Buffer.from(
      keptLines.join("\n") + (keptLines.length > 0 ? "\n" : ""),
      "utf-8",
    ),
    totalLines,
    inWindowLines: keptLines.length,
    droppedPreSigninLines,
    droppedPostExpireLines,
    droppedOutsideDateLines,
  };
}

export function mergeJsonlBuffers(existingBuf: Buffer, newBuf: Buffer): Buffer {
  const seen = new Set(existingBuf.toString("utf8").split("\n").filter((l) => l.trim()));
  const additions = newBuf.toString("utf8").split("\n").filter((line) => {
    if (!line.trim() || seen.has(line)) return false;
    seen.add(line);
    return true;
  });
  if (!additions.length) return existingBuf;
  const separator = existingBuf.length && existingBuf[existingBuf.length - 1] !== 10 ? "\n" : "";
  return Buffer.concat([existingBuf, Buffer.from(separator + additions.join("\n") + "\n")]);
}

export function mergeMetadataBuffers(existingBuf: Buffer, newBuf: Buffer): Buffer {
  try {
    const existingMeta = JSON.parse(existingBuf.toString("utf-8"));
    const newMeta = JSON.parse(newBuf.toString("utf-8"));

    const merged = {
      ...existingMeta,
      ...newMeta,
      // Preserve earliest exam start time across all machines
      examStartAt: [existingMeta.examStartAt, newMeta.examStartAt]
        .filter((v) => toMs(v) !== null).sort((a, b) => toMs(a)! - toMs(b)!)[0],
      // Set to latest end time if present
      examEndAt: [existingMeta.examEndAt, newMeta.examEndAt]
        .filter((v) => toMs(v) !== null).sort((a, b) => toMs(b)! - toMs(a)!)[0],
      conversations: [
        ...(Array.isArray(existingMeta.conversations)
          ? existingMeta.conversations
          : []),
        ...(Array.isArray(newMeta.conversations) ? newMeta.conversations : []),
      ],
    };

    if (Array.isArray(merged.conversations)) {
      const seenConv = new Set<string>();
      merged.conversations = merged.conversations.filter((c: any) => {
        const id = c?.id || c?.conversationId || JSON.stringify(c);
        if (seenConv.has(id)) return false;
        seenConv.add(id);
        return true;
      });
    }

    return Buffer.from(JSON.stringify(merged, null, 2), "utf-8");
  } catch (error) {
    throw new Error("Cannot merge invalid metadata without losing evidence.", { cause: error });
  }
}
