import { redisStore } from "../../services/classifier/redisStore";
import { resolveTerminalActivity } from "../../modules/chat/terminalContext";
import { latestClassifications } from "../../modules/chat/classificationState";

export async function getLatestClassification(c: any) {
  const token = c.get("token");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Wait if evaluation is pending (long polling)
  let retries = 0;
  const maxRetries = parseInt(
    process.env.CLASSIFICATION_POLL_RETRIES || "300",
    10,
  );
  while (
    (await redisStore.isEvaluationPending(token)) &&
    retries < maxRetries
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    retries++;
  }
  const cached = await redisStore.getCachedClassification(token);
  if (cached) {
    return c.json(cached);
  }
  const result = latestClassifications.get(token);
  if (!result) {
    return c.json({ label: "none", confidence: 0 });
  }
  return c.json(result);
}

export async function saveClientContext(c: any) {
  const token = c.get("token");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json();
  const user = c.get("user");
  const sessionContext = c.get("sessionContext");
  const machineId =
    c.req.header("x-machine-id") || c.req.header("X-Machine-Id") || "";

  let sessionCode = "DEFAULT";
  let studentId = machineId || "DEFAULT_USER";

  if (sessionContext) {
    sessionCode = sessionContext.sessionCode || "DEFAULT";
    studentId = sessionContext.studentId || "DEFAULT_USER";
  } else {
    if (
      user?.userId &&
      user.userId !== "master-user" &&
      user.userId !== "local-user"
    ) {
      studentId = user.userId;
    }
  }

  sessionCode = sessionCode.toUpperCase();
  studentId = studentId.toUpperCase();

  const { activeFile, recentPaste, files, recentTerminal, terminalOutput } =
    body;
  const terminalActivity = await resolveTerminalActivity(
    sessionCode,
    studentId,
    recentTerminal,
    terminalOutput,
  );
  await redisStore.saveClientContext(sessionCode, studentId, {
    activeFile,
    recentPaste,
    files,
    recentTerminal: terminalActivity,
  });
  return c.json({ success: true });
}
