import { toMs } from "../../shared/sessionTime";
export { toMs };

export function sliceRecordsByTimeRange<T extends { timestamp?: any }>(
  records: T[],
  startMs: number | null,
  endMs: number | null,
  allowedDates?: Set<string>,
): {
  sliced: T[];
  totalRaw: number;
  preCount: number;
  postCount: number;
  outsideDateCount: number;
} {
  if (!records || records.length === 0) {
    return {
      sliced: [],
      totalRaw: 0,
      preCount: 0,
      postCount: 0,
      outsideDateCount: 0,
    };
  }

  // Ensure chronological sort (stable check)
  let isSorted = true;
  for (let i = 1; i < records.length; i++) {
    const prev = toMs(records[i - 1].timestamp) || 0;
    const curr = toMs(records[i].timestamp) || 0;
    if (curr < prev) {
      isSorted = false;
      break;
    }
  }

  const sorted = isSorted
    ? records
    : [...records].sort(
        (a, b) => (toMs(a.timestamp) || 0) - (toMs(b.timestamp) || 0),
      );

  // Binary search to find startIdx (first record >= startMs)
  let startIdx = 0;
  if (startMs !== null) {
    let low = 0;
    let high = sorted.length - 1;
    startIdx = sorted.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = toMs(sorted[mid].timestamp);
      if (t !== null && t >= startMs) {
        startIdx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  // Binary search to find endIdx (first record > endMs)
  let endIdx = sorted.length;
  if (endMs !== null) {
    let low = startIdx;
    let high = sorted.length - 1;
    endIdx = sorted.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = toMs(sorted[mid].timestamp);
      if (t !== null && t > endMs) {
        endIdx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  const candidateSlice = sorted.slice(startIdx, endIdx);
  let outsideDateCount = 0;
  let finalSlice: T[] = candidateSlice;

  if (allowedDates && allowedDates.size > 0) {
    finalSlice = candidateSlice.filter((item) => {
      const t = toMs(item.timestamp);
      if (!t) return false;
      const dateStr = new Date(t).toISOString().slice(0, 10);
      if (!allowedDates.has(dateStr)) {
        outsideDateCount++;
        return false;
      }
      return true;
    });
  }

  return {
    sliced: finalSlice,
    totalRaw: sorted.length,
    preCount: startIdx,
    postCount: sorted.length - endIdx,
    outsideDateCount,
  };
}
