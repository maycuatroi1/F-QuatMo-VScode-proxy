import { requireCaller } from "../../shared/http/adminCaller";
import { getSummaryProgress, startSummaryProgress, updateSummaryProgress } from "../../services/summaryProgress";

let activeSummaryJobs = 0;

function owner(c: any): string {
  const caller = requireCaller(c);
  return `${caller.role}:${caller.username.toLowerCase()}`;
}

export function reportSummaryProgress(c: any) {
  const id = c.get("summaryJobId") as string | undefined;
  return id ? (update: Parameters<typeof updateSummaryProgress>[1]) => updateSummaryProgress(id, update) : undefined;
}

export async function getSummaryJobProgress(c: any) {
  const progress = getSummaryProgress(c.req.param("jobId").toLowerCase(), owner(c));
  return progress ? c.json({ ok: true, ...progress }) : c.json({ ok: false, error: "Summary job not found." }, 404);
}

/** Bound upload parsing, archive inspection and engine work together. */
export async function limitSummaryGeneration(c: any, next: any) {
  const maximum = Number(process.env.SUMMARY_MAX_CONCURRENT_JOBS || "1");
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    return c.json({ ok: false, error: "Summary service configuration is invalid." }, 503);
  }
  if (activeSummaryJobs >= maximum) {
    return c.json({ ok: false, error: "Summary generation is busy. Retry after the current job finishes." }, 429);
  }
  const jobId = c.req.query("jobId")?.toLowerCase();
  if (jobId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(jobId)) return c.json({ ok: false, error: "Invalid summary job ID." }, 400);
    if (!startSummaryProgress(jobId, owner(c))) return c.json({ ok: false, error: "Summary job ID is already in use." }, 409);
    c.set("summaryJobId", jobId);
  }
  activeSummaryJobs++;
  let succeeded = false;
  try {
    await next();
    succeeded = c.res.status < 400;
  } finally {
    if (jobId) updateSummaryProgress(jobId, { stage: succeeded ? "completed" : "failed" });
    activeSummaryJobs--;
  }
}
