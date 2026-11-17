export type SummaryProgressStage = "preparing" | "validating" | "generating" | "saving" | "completed" | "failed";
export type SummaryProgressUpdate = { stage: SummaryProgressStage; completed?: number; total?: number };
export type SummaryProgressCallback = (update: SummaryProgressUpdate) => void;

type Job = { owner: string; stage: SummaryProgressStage; completed: number; total: number | null; updatedAt: number };
const jobs = new Map<string, Job>();
const retentionMs = 10 * 60 * 1000;

function prune() {
  for (const [id, job] of jobs) {
    if ((job.stage === "completed" || job.stage === "failed") && Date.now() - job.updatedAt > retentionMs) jobs.delete(id);
  }
  while (jobs.size >= 64) {
    const oldest = [...jobs].find(([, job]) => job.stage === "completed" || job.stage === "failed");
    if (!oldest) break;
    jobs.delete(oldest[0]);
  }
}

export function startSummaryProgress(id: string, owner: string): boolean {
  prune();
  if (jobs.has(id) || jobs.size >= 64) return false;
  jobs.set(id, { owner, stage: "preparing", completed: 0, total: null, updatedAt: Date.now() });
  return true;
}

export function updateSummaryProgress(id: string, update: SummaryProgressUpdate): void {
  const job = jobs.get(id);
  if (!job || job.stage === "completed" || job.stage === "failed") return;
  const total = update.total ?? job.total;
  if (update.total !== undefined) {
    if (!Number.isSafeInteger(update.total) || update.total < 0) return;
    if (job.total !== null && job.total !== update.total) return;
  }
  if (update.completed !== undefined) {
    if (!Number.isSafeInteger(update.completed) || update.completed < job.completed || total === null || update.completed > total) return;
    job.completed = update.completed;
  }
  job.total = total;
  job.stage = update.stage;
  job.updatedAt = Date.now();
}

export function getSummaryProgress(id: string, owner: string) {
  prune();
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return null;
  // Count completed archive/validation/report/save units; never estimate elapsed time.
  const percent = job.stage === "completed" ? 100 : job.total === null ? null
    : Math.floor(100 * (2 + job.completed) / (job.total + 3));
  return { stage: job.stage, completed: job.completed, total: job.total, percent };
}
