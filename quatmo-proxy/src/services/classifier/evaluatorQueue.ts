import { evaluateTurnAndSession } from "./index";

export interface EvaluationJob {
  sessionCode: string;
  studentId: string;
  token: string;
  prompt: string;
  response: string;
  history: Array<{ role: string; content: string }>;
  queuedAt: number;
}

const MAX_CONCURRENT_EVALUATIONS = 15;
const activeJobs = new Map<string, Promise<void>>(); // studentKey -> Promise
const pendingJobs = new Map<string, EvaluationJob>(); // studentKey -> latest Job
let runningCount = 0;

function getStudentKey(sessionCode: string, studentId: string): string {
  return `${(sessionCode || "DEFAULT").toUpperCase()}:${(studentId || "DEFAULT_USER").toUpperCase()}`;
}

async function processQueue() {
  if (runningCount >= MAX_CONCURRENT_EVALUATIONS || pendingJobs.size === 0) {
    return;
  }

  for (const [studentKey, job] of pendingJobs.entries()) {
    if (runningCount >= MAX_CONCURRENT_EVALUATIONS) {
      break;
    }

    if (activeJobs.has(studentKey)) {
      // Student already has an active evaluation running. Let pending job wait for it to finish.
      continue;
    }

    pendingJobs.delete(studentKey);
    runningCount++;

    const taskPromise = (async () => {
      const start = Date.now();
      try {
        console.log(
          `[EvaluatorQueue] Running evaluation for ${studentKey} (Queue size: ${pendingJobs.size}, Active: ${runningCount}/${MAX_CONCURRENT_EVALUATIONS})`,
        );

        // Run evaluateTurnAndSession with 15s timeout protection
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Evaluator timeout after 15s")), 15000),
        );

        await Promise.race([
          evaluateTurnAndSession(
            job.sessionCode,
            job.studentId,
            job.token,
            job.prompt,
            job.response,
            job.history,
          ),
          timeoutPromise,
        ]);

        console.log(
          `[EvaluatorQueue] Evaluation finished for ${studentKey} in ${Date.now() - start}ms`,
        );
      } catch (err: any) {
        console.error(
          `[EvaluatorQueue] Evaluation error for ${studentKey}:`,
          err.message,
        );
      } finally {
        activeJobs.delete(studentKey);
        runningCount--;
        // Check if a new job was enqueued for this student while it was running
        setImmediate(processQueue);
      }
    })();

    activeJobs.set(studentKey, taskPromise);
  }
}

/**
 * Enqueue an evaluation task for a student turn.
 * Debounces and coalesces multiple calls for the same student.
 */
export function enqueueEvaluation(job: EvaluationJob): void {
  const studentKey = getStudentKey(job.sessionCode, job.studentId);
  pendingJobs.set(studentKey, job);
  setImmediate(processQueue);
}

export function getQueueStats() {
  return {
    runningCount,
    pendingCount: pendingJobs.size,
    maxConcurrency: MAX_CONCURRENT_EVALUATIONS,
  };
}
