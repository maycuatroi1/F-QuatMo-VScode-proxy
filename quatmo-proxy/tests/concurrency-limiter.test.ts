import { describe, expect, it } from "bun:test";
import { ClassifierConcurrencyController } from "../src/services/classifier/concurrencyLimiter";

describe("ClassifierConcurrencyController (Semaphore & Adaptive Circuit Breaker)", () => {
  it("should bound concurrency to maxConcurrent and process all queued items", async () => {
    const controller = new ClassifierConcurrencyController(5, 50, 2000);
    let peakConcurrency = 0;
    let currentActive = 0;
    let completedCount = 0;

    const taskPromises: Promise<any>[] = [];

    // Schedule 15 tasks concurrently on a controller with maxConcurrent = 5
    for (let i = 0; i < 15; i++) {
      const p = controller.enqueue(async (isFastTrack) => {
        currentActive++;
        if (currentActive > peakConcurrency) {
          peakConcurrency = currentActive;
        }
        // Simulate evaluation work
        await new Promise((resolve) => setTimeout(resolve, 20));
        currentActive--;
        completedCount++;
        return { index: i, isFastTrack };
      });
      taskPromises.push(p);
    }

    const results = await Promise.all(taskPromises);

    expect(peakConcurrency).toBeLessThanOrEqual(5);
    expect(completedCount).toBe(15);
    expect(results.length).toBe(15);
    expect(controller.getStats().active).toBe(0);
    expect(controller.getStats().queued).toBe(0);
    expect(controller.getStats().totalProcessed).toBe(15);
  });

  it("should trigger fast-track when task wait time exceeds maxQueueWaitMs", async () => {
    // maxConcurrent = 5, maxQueue = 50, maxQueueWaitMs = 500
    const controller = new ClassifierConcurrencyController(5, 50, 500);
    const results: boolean[] = [];

    // Fill the 5 concurrent slots with 600ms work
    for (let i = 0; i < 5; i++) {
      controller.enqueue(async (isFastTrack) => {
        await new Promise((r) => setTimeout(r, 600));
        results.push(isFastTrack);
        return isFastTrack;
      });
    }

    // 6th task is enqueued immediately behind them; will wait ~600ms > 500ms
    const delayedTask = controller.enqueue(async (isFastTrack) => {
      results.push(isFastTrack);
      return isFastTrack;
    });

    const isFastTrack = await delayedTask;
    expect(isFastTrack).toBe(true);
    expect(controller.getStats().fastTrackProcessed).toBeGreaterThanOrEqual(1);
  });

  it("should immediately execute Fast-Track when queue capacity is reached", async () => {
    const controller = new ClassifierConcurrencyController(2, 5, 5000);
    const taskPromises: Promise<any>[] = [];

    // Enqueue 10 tasks (2 running, 5 queued, 3 overflow)
    for (let i = 0; i < 10; i++) {
      taskPromises.push(
        controller.enqueue(async (isFastTrack) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { i, isFastTrack };
        }),
      );
    }

    const allResults = await Promise.all(taskPromises);
    expect(allResults.length).toBe(10);

    // Overflow tasks must be Fast-Track
    const fastTrackTasks = allResults.filter((r) => r.isFastTrack === true);
    expect(fastTrackTasks.length).toBeGreaterThanOrEqual(3);
    expect(controller.getStats().fastTrackProcessed).toBeGreaterThanOrEqual(3);
  });

  it("preserves per-client FIFO order and maxConcurrent bound even on queue overflow", async () => {
    const controller = new ClassifierConcurrencyController(2, 3, 5000);
    let activeNow = 0;
    let peakActive = 0;
    const perStudentOrder: string[] = [];

    // Seed 5 tasks from 3 students (maxConcurrent=2, maxQueue=3 -> triggers overflow)
    const schedule = [
      { key: "S:A", turn: "A1" },
      { key: "S:B", turn: "B1" },
      { key: "S:C", turn: "C1" },
      { key: "S:A", turn: "A2" },
      { key: "S:A", turn: "A3" },
      { key: "S:D", turn: "D1" },
      { key: "S:E", turn: "E1" },
    ];

    const promises = schedule.map(({ key, turn }) =>
      controller.enqueue(key, async (isFastTrack) => {
        activeNow++;
        peakActive = Math.max(peakActive, activeNow);
        await new Promise((r) => setTimeout(r, turn === "A1" ? 40 : 10));
        perStudentOrder.push(turn);
        activeNow--;
        return { turn, isFastTrack };
      }),
    );

    const results = await Promise.all(promises);
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(results.some((r) => r.isFastTrack)).toBe(true);

    const studentAOrder = perStudentOrder.filter((t) => t.startsWith("A"));
    expect(studentAOrder).toEqual(["A1", "A2", "A3"]);
  });
});
