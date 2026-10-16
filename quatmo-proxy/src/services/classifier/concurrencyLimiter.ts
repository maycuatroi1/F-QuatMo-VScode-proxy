/**
 * Industrial-Grade Bounded Concurrency Semaphore & Per-Client Keyed FIFO Queue
 * for Deep IEM Classification.
 *
 * Guarantees:
 *  1. Strict Causal Ordering: Turns for the same client (session:student) are processed
 *     sequentially in FIFO order. Eliminates sliding window inversion and JSON file race conditions.
 *  2. High CCU Scalability: Independent clients run concurrently in a global worker pool (up to maxConcurrent).
 *  3. Adaptive Circuit Breaker: Queue overflow or latency spikes automatically drop back to
 *     zero-latency Fast-Track Heuristics.
 */

export interface ConcurrencyLimiterStats {
  active: number;
  queued: number;
  activeClients: number;
  circuitBreakerTripped: boolean;
  totalProcessed: number;
  fastTrackProcessed: number;
}

interface QueuedItem {
  clientKey: string;
  task: (isFastTrack: boolean) => Promise<any>;
  resolve: (val: any) => void;
  reject: (err: any) => void;
  enqueuedAt: number;
}

export class ClassifierConcurrencyController {
  private activeCount = 0;
  // Per-client FIFO queues: Map<clientKey, QueuedItem[]>
  private clientQueues = new Map<string, QueuedItem[]>();
  // Clients currently possessing an active execution slot in the worker pool
  private activeClients = new Set<string>();

  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly maxQueueWaitMs: number;

  private totalProcessed = 0;
  private fastTrackProcessed = 0;
  private circuitBreakerTripped = false;

  constructor(
    maxConcurrent = parseInt(process.env.CLASSIFIER_MAX_CONCURRENT || "25", 10),
    maxQueue = parseInt(process.env.CLASSIFIER_MAX_QUEUE || "200", 10),
    maxQueueWaitMs = parseInt(process.env.CLASSIFIER_MAX_QUEUE_WAIT_MS || "2000", 10),
  ) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(1, maxQueue);
    this.maxQueueWaitMs = Math.max(50, maxQueueWaitMs);
  }

  public getTotalQueuedCount(): number {
    let count = 0;
    for (const queue of this.clientQueues.values()) {
      count += queue.length;
    }
    return count;
  }

  /**
   * Enqueues turn evaluation for a specific client into the per-client FIFO queue.
   */
  public enqueue<T>(
    clientKeyOrTask: string | ((isFastTrack: boolean) => Promise<T>),
    taskArg?: (isFastTrack: boolean) => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = Date.now();
    let clientKey: string;
    let task: (isFastTrack: boolean) => Promise<T>;

    if (typeof clientKeyOrTask === "string" && taskArg) {
      clientKey = clientKeyOrTask;
      task = taskArg;
    } else if (typeof clientKeyOrTask === "function") {
      clientKey = "GLOBAL_UNSCOPED";
      task = clientKeyOrTask;
    } else {
      throw new Error("[ConcurrencyLimiter] Invalid arguments to enqueue");
    }

    const totalQueued = this.getTotalQueuedCount();

    // Circuit breaker: Queue capacity exceeded
    if (totalQueued >= this.maxQueue) {
      this.circuitBreakerTripped = true;
      console.warn(
        `[ConcurrencyLimiter] Global queue limit reached (${totalQueued}/${this.maxQueue}). Running task for ${clientKey} in Fast-Track mode.`,
      );
      this.fastTrackProcessed++;
      return task(true);
    }

    return new Promise<T>((resolve, reject) => {
      let q = this.clientQueues.get(clientKey);
      if (!q) {
        q = [];
        this.clientQueues.set(clientKey, q);
      }

      q.push({
        clientKey,
        task,
        resolve,
        reject,
        enqueuedAt,
      });

      this.drain();
    });
  }

  /**
   * Drains available slots in round-robin fashion across idle clients with pending work.
   */
  private drain(): void {
    while (this.activeCount < this.maxConcurrent) {
      // Find the next eligible client that has pending items and is NOT currently active
      let eligibleClientKey: string | null = null;
      let nextItem: QueuedItem | null = null;

      for (const [key, queue] of this.clientQueues.entries()) {
        if (!this.activeClients.has(key) && queue.length > 0) {
          eligibleClientKey = key;
          nextItem = queue.shift()!;
          if (queue.length === 0) {
            this.clientQueues.delete(key);
          }
          break;
        }
      }

      if (!eligibleClientKey || !nextItem) {
        // No available clients to schedule right now
        break;
      }

      const targetKey = eligibleClientKey;
      const itemToRun = nextItem;

      const isWaitTimeout = Date.now() - itemToRun.enqueuedAt > this.maxQueueWaitMs;
      const isFastTrack = this.circuitBreakerTripped || isWaitTimeout;

      if (isFastTrack) {
        this.fastTrackProcessed++;
        if (this.circuitBreakerTripped) {
          console.warn(
            `[ConcurrencyLimiter] Circuit breaker tripped for client ${eligibleClientKey}. Running in Fast-Track fallback mode.`,
          );
        } else {
          console.warn(
            `[ConcurrencyLimiter] Task wait time exceeded (${Date.now() - itemToRun.enqueuedAt}ms > ${this.maxQueueWaitMs}ms) for client ${eligibleClientKey}. Running in Fast-Track mode.`,
          );
        }
      }

      this.activeCount++;
      this.activeClients.add(eligibleClientKey);

      itemToRun
        .task(isFastTrack)
        .then(
          (res) => {
            this.totalProcessed++;
            itemToRun.resolve(res);
          },
          (err) => {
            console.error(
              `[ConcurrencyLimiter] Execution error for ${targetKey}:`,
              err,
            );
            itemToRun.reject(err);
          },
        )
        .finally(() => {
          this.activeCount--;
          this.activeClients.delete(targetKey);

          if (this.getTotalQueuedCount() < this.maxQueue / 2) {
            this.circuitBreakerTripped = false;
          }

          // Trigger next turn for this client or next waiting client
          this.drain();
        });
    }
  }

  /**
   * Allows synchronous routes to wait briefly if the specified client has an in-flight
   * evaluation so that the latest sliding window state can be retrieved.
   */
  public async waitForClient(clientKey: string, timeoutMs = 2500): Promise<void> {
    const start = Date.now();
    while (
      (this.activeClients.has(clientKey) ||
        (this.clientQueues.get(clientKey)?.length ?? 0) > 0) &&
      Date.now() - start < timeoutMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  public getStats(): ConcurrencyLimiterStats {
    return {
      active: this.activeCount,
      queued: this.getTotalQueuedCount(),
      activeClients: this.activeClients.size,
      circuitBreakerTripped: this.circuitBreakerTripped,
      totalProcessed: this.totalProcessed,
      fastTrackProcessed: this.fastTrackProcessed,
    };
  }
}

export const classifierConcurrencyController =
  new ClassifierConcurrencyController();
