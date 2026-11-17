let activeSummaryJobs = 0;

/** Bound upload parsing, archive inspection and engine work together. */
export async function limitSummaryGeneration(c: any, next: any) {
  const maximum = Number(process.env.SUMMARY_MAX_CONCURRENT_JOBS || "1");
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    return c.json({ ok: false, error: "Summary service configuration is invalid." }, 503);
  }
  if (activeSummaryJobs >= maximum) {
    return c.json({ ok: false, error: "Summary generation is busy. Retry after the current job finishes." }, 429);
  }
  activeSummaryJobs++;
  try {
    await next();
  } finally {
    activeSummaryJobs--;
  }
}
