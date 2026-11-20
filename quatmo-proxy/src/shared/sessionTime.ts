export function toMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function sessionEndMs(session: any): number | null {
  const created = toMs(session?.createdAt) ?? toMs(session?.startTime);
  const duration = Number(session?.durationMinutes);
  if (!created || !Number.isFinite(duration) || (duration <= 0 && duration !== -1)) return null;
  return created + (duration === -1 ? 1440 : duration) * 60000;
}

export function resolveSessionWindow(session: any, signinValues: unknown[]) {
  const created = toMs(session?.createdAt) ?? toMs(session?.startTime);
  const end = sessionEndMs(session);
  const supplied = signinValues.filter((v) => v !== undefined && v !== null);
  const times = supplied.map(toMs);
  const signin = times[0] ?? null;
  const resolved = !!created && !!end && !!signin && times.length > 0 &&
    times.every((t) => t === signin) && signin >= created && signin <= end;
  return {
    status: resolved ? "resolved" : "unresolved",
    signinTimestamp: resolved ? signin : null,
    expireTimestamp: end,
    durationMinutes: session?.durationMinutes,
    graceSeconds: 0,
    ruleVersion: "scheduled-signin-v1",
  };
}

export function inSessionWindow(timestamp: unknown, window: ReturnType<typeof resolveSessionWindow>): boolean {
  const t = toMs(timestamp);
  return window.status === "resolved" && t !== null &&
    t >= window.signinTimestamp! && t <= window.expireTimestamp!;
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

export function deduplicateRecords<T>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = JSON.stringify(canonical(record));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
