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

export function toMs(ts: any): number | null {
  const n = Number(ts);
  if (!n || isNaN(n)) return null;
  return n < 1e11 ? n * 1000 : n;
}

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
  const existingStr = existingBuf.toString("utf-8");
  const newStr = newBuf.toString("utf-8");
  const existingLines = existingStr
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const newLines = newStr.split("\n").filter((l) => l.trim().length > 0);

  const parsedRecords: Array<{
    record: JsonlRecord;
    raw?: string;
    isRaw: boolean;
  }> = [];
  const seenFingerprints = new Set<string>();

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as JsonlRecord;
      if (
        typeof obj === "object" &&
        obj !== null &&
        typeof obj.timestamp === "number"
      ) {
        // Construct semantic fingerprint ignoring transient groupId counter
        const fp = `${obj.type || ""}_${obj.timestamp}_${JSON.stringify(obj.payload ?? "")}`;
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          parsedRecords.push({ record: obj, isRaw: false });
        }
        return;
      }
    } catch {
      // JSON parse failed; fall back to raw string preservation
    }

    if (!seenFingerprints.has(trimmed)) {
      seenFingerprints.add(trimmed);
      parsedRecords.push({
        record: { timestamp: 0 },
        raw: trimmed,
        isRaw: true,
      });
    }
  };

  for (const l of existingLines) {
    processLine(l);
  }
  for (const l of newLines) {
    processLine(l);
  }

  // Strictly sort chronologically by timestamp ascending
  parsedRecords.sort((a, b) => {
    if (a.isRaw && !b.isRaw) return -1;
    if (!a.isRaw && b.isRaw) return 1;
    return a.record.timestamp - b.record.timestamp;
  });

  // Re-index groupId monotonically across the unified timeline (0, 1, 2, ...)
  let currentGroupId = 0;
  const mergedLines: string[] = [];

  for (const item of parsedRecords) {
    if (item.isRaw && item.raw) {
      mergedLines.push(item.raw);
    } else {
      item.record.groupId = currentGroupId++;
      mergedLines.push(JSON.stringify(item.record));
    }
  }

  return Buffer.from(mergedLines.join("\n") + "\n", "utf-8");
}

export function mergeMetadataBuffers(existingBuf: Buffer, newBuf: Buffer): Buffer {
  try {
    const existingMeta = JSON.parse(existingBuf.toString("utf-8"));
    const newMeta = JSON.parse(newBuf.toString("utf-8"));

    const merged = {
      ...existingMeta,
      ...newMeta,
      // Preserve earliest exam start time across all machines
      examStartAt: Math.min(
        Number(existingMeta.examStartAt) || Date.now(),
        Number(newMeta.examStartAt) || Date.now(),
      ),
      // Set to latest end time if present
      examEndAt:
        Math.max(
          Number(existingMeta.examEndAt) || 0,
          Number(newMeta.examEndAt) || 0,
        ) || undefined,
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
  } catch {
    return newBuf;
  }
}
