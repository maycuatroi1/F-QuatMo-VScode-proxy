/**
 * Bounded Concurrency Semaphore & Adaptive Circuit Breaker for Deep IEM Classification.
 * Prevents cascading timeouts and resource exhaustion under high CCU exam conditions.
 */

export interface ConcurrencyLimiterStats {
  active: number;
  queued: number;
  circuitBreakerTripped: boolean;
  totalProcessed: number;
  fastTrackProcessed: number;
}

export class ClassifierConcurrencyController {
  private activeCount = 0;
  private queue: Array<{
    task: (isFastTrack: boolean) => Promise<any>;
    resolve: (val: any) => void;
    reject: (err: any) => void;
    enqueuedAt: number;
  }> = [];

  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly maxQueueWaitMs: number;

  private totalProcessed = 0;
  private fastTrackProcessed = 0;
  private circuitBreakerTripped = false;

  constructor(
    maxConcurrent = parseInt(process.env.CLASSIFIER_MAX_CONCURRENT || "25", 10),
    maxQueue = parseInt(process.env.CLASSIFIER_MAX_QUEUE || "200", 10),
    maxQueueWaitMs = parseInt(process.env.CLASSIFIER_MAX_QUEUE_WAIT_MS || "1500", 10),
  ) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(1, maxQueue);
    this.maxQueueWaitMs = Math.max(50, maxQueueWaitMs);
  }

  public enqueue<T>(task: (isFastTrack: boolean) => Promise<T>): Promise<T> {
    const enqueuedAt = Date.now();

    // Check circuit breaker condition: queue overflow
    if (this.queue.length >= this.maxQueue) {
      this.circuitBreakerTripped = true;
      console.warn(
        `[ConcurrencyLimiter] Queue limit reached (${this.queue.length}/${this.maxQueue}). Running in Fast-Track fallback mode immediately.`,
      );
      this.fastTrackProcessed++;
      return task(true);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject,
        enqueuedAt,
      });

      this.drain();
    });
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      const waitTime = Date.now() - item.enqueuedAt;
      const isFastTrack = waitTime > this.maxQueueWaitMs || this.circuitBreakerTripped;

      if (isFastTrack) {
        this.fastTrackProcessed++;
        console.log(
          `[ConcurrencyLimiter] Task waited ${waitTime}ms > threshold (${this.maxQueueWaitMs}ms). Dispatched via Fast-Track Heuristics.`,
        );
      }

      this.activeCount++;

      item
        .task(isFastTrack)
        .then(
          (res) => {
            this.totalProcessed++;
            this.activeCount--;
            if (this.queue.length < this.maxQueue / 2) {
              this.circuitBreakerTripped = false;
            }
            this.drain();
            item.resolve(res);
          },
          (err) => {
            console.error("[ConcurrencyLimiter] Task execution error:", err);
            this.activeCount--;
            if (this.queue.length < this.maxQueue / 2) {
              this.circuitBreakerTripped = false;
            }
            this.drain();
            item.reject(err);
          },
        );
    }
  }

  public getStats(): ConcurrencyLimiterStats {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      circuitBreakerTripped: this.circuitBreakerTripped,
      totalProcessed: this.totalProcessed,
      fastTrackProcessed: this.fastTrackProcessed,
    };
  }
}

export const classifierConcurrencyController = new ClassifierConcurrencyController();
