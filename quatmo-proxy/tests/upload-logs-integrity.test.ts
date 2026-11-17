import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import * as fs from "fs";
import * as path from "path";
import { getJwtSecret } from "../src/services/jwtKey";
import { sessions, sessionStates } from "../src/services/sessionStore";
import { sessionAuthRouter } from "../src/routes/sessionAuth";

const app = new Hono();
app.route("/session", sessionAuthRouter);

describe("Scientific Telemetry Ingestion & Chronological Merge Integrity", () => {
  const jwtSecret = getJwtSecret();
  const sessionCode = "SCI_TEST_SESSION";
  const studentId = "SE_AUDIT_01";
  const targetDir = path.resolve(
    process.cwd(),
    "logs",
    "sessions",
    sessionCode,
    studentId
  );

  beforeEach(async () => {
    // Clear any previous test files
    if (fs.existsSync(targetDir)) {
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    }

    const now = Math.floor(Date.now() / 1000);
    sessions.set(sessionCode, {
      sessionCode,
      startTime: now - 600,
      durationMinutes: 90,
      aiOption: "chatbot",
      aiValidityMinutes: 90,
      defaultTokenBudget: 10000,
      allowedStudentIds: new Set([studentId]),
      createdAt: now - 600,
    });

  });

  afterEach(async () => {
    if (fs.existsSync(targetDir)) {
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    }
    sessions.delete(sessionCode);
  });

  it("should merge out-of-order logs into strictly chronological order and re-index groupId", async () => {
    // Events must fall inside the active session's validity window.
    const t1 = Date.now() - 300000;
    const t2 = t1 + 1000;
    const t3 = t1 + 2000;
    const t4 = t1 + 3000;
    const token = await sign(
      {
        sessionCode,
        studentId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      jwtSecret
    );

    // Machine B uploads first with timestamps 3000 and 4000
    const machineBPayload = {
      sessionCode,
      studentId,
      uploadReason: "machine_b_complete",
      files: [
        {
          relativePath: "exam_records/sci_session/events.jsonl",
          content: [
            JSON.stringify({ timestamp: t3, type: "ui_click", payload: { x: 10 }, groupId: 0 }),
            JSON.stringify({ timestamp: t4, type: "panel_resize", payload: { w: 100 }, groupId: 1 }),
          ].join("\n") + "\n",
        },
        {
          relativePath: "exam_records/sci_session/metadata.json",
          content: JSON.stringify({
            examSessionId: "sci_session",
            examStartAt: t3,
            examEndAt: t4,
            conversations: [{ id: "c2" }],
          }),
        },
        {
          relativePath: "exam_records/sci_session/snapshot_start.zip",
          content: "SNAPSHOT_MACHINE_B",
        },
      ],
    };

    const resB = await app.request("/session/upload-logs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(machineBPayload),
    });
    expect(resB.status).toBe(200);

    // Now Machine A (delayed upload from earlier machine) uploads with timestamps 1000 and 2000
    const machineAPayload = {
      sessionCode,
      studentId,
      uploadReason: "machine_a_delayed_sync",
      files: [
        {
          relativePath: "exam_records/sci_session/events.jsonl",
          content: [
            JSON.stringify({ timestamp: t1, type: "file_switch", payload: { to: "main.py" }, groupId: 0 }),
            JSON.stringify({ timestamp: t2, type: "typing_chunk", payload: { text: "hello" }, groupId: 1 }),
            // Also contains a duplicate of timestamp 3000 to test deduplication
            JSON.stringify({ timestamp: t3, type: "ui_click", payload: { x: 10 }, groupId: 2 }),
          ].join("\n") + "\n",
        },
        {
          relativePath: "exam_records/sci_session/metadata.json",
          content: JSON.stringify({
            examSessionId: "sci_session",
            examStartAt: t1,
            conversations: [{ id: "c1" }],
          }),
        },
        {
          relativePath: "exam_records/sci_session/snapshot_start.zip",
          content: "ORIGINAL_BASELINE_SNAPSHOT_A",
        },
      ],
    };

    const resA = await app.request("/session/upload-logs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(machineAPayload),
    });
    expect(resA.status).toBe(200);

    // Verify merged events.jsonl
    const eventsPath = path.join(targetDir, "exam_records", "sci_session", "events.jsonl");
    expect(fs.existsSync(eventsPath)).toBe(true);

    const mergedContent = await fs.promises.readFile(eventsPath, "utf-8");
    const mergedLines = mergedContent.trim().split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

    // 1. Exact count: exactly 4 unique events (1000, 2000, 3000, 4000)
    expect(mergedLines.length).toBe(4);

    // 2. Strict chronological order
    expect(mergedLines[0].timestamp).toBe(t1);
    expect(mergedLines[1].timestamp).toBe(t2);
    expect(mergedLines[2].timestamp).toBe(t3);
    expect(mergedLines[3].timestamp).toBe(t4);

    // 3. Strict monotonic groupId (0, 1, 2, 3)
    expect(mergedLines[0].groupId).toBe(0);
    expect(mergedLines[1].groupId).toBe(1);
    expect(mergedLines[2].groupId).toBe(2);
    expect(mergedLines[3].groupId).toBe(3);

    // 4. Metadata verification: earliest start time is preserved (1000), conversations merged
    const metaPath = path.join(targetDir, "exam_records", "sci_session", "metadata.json");
    const mergedMeta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    expect(mergedMeta.examStartAt).toBe(t1);
    expect(mergedMeta.examEndAt).toBe(t4);
    expect(mergedMeta.conversations.length).toBe(2);

    // 5. Initial snapshot preservation
    const snapPath = path.join(targetDir, "exam_records", "sci_session", "snapshot_start.zip");
    const snapContent = await fs.promises.readFile(snapPath, "utf-8");
    expect(snapContent).toBe("SNAPSHOT_MACHINE_B"); // Initial uploaded snapshot was preserved

    // 6. Upload reason recorded in upload_info.json
    const infoPath = path.join(targetDir, "upload_info.json");
    const uploadInfo = JSON.parse(await fs.promises.readFile(infoPath, "utf-8"));
    expect(uploadInfo.uploadReason).toBe("machine_a_delayed_sync");
  });
});
