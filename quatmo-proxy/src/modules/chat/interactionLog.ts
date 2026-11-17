import { logSession, logGlobal, logGuest } from "../../services/secureLogger";
import path from "path";
import fs from "fs";
import { redisStore } from "../../services/classifier/redisStore";
import { s3Storage } from "../../services/s3Storage";
import { withFileLock } from "../../services/classifier/index";
import { extractCodeSnapshot } from "../../services/classifier/features";
import { extractToolCalls } from "./toolCalls";
import { sanitizeFilename } from "../telemetry/logFiles";

export async function logStudentInteraction(
  sessionCode: string,
  studentId: string,
  currentAiOption: string,
  tokenLimit: number,
  body: any,
  completionText: string,
  inputTokens: number,
  outputTokens: number,
  totalConsumed: number,
  classifierLabel: string,
  classifierConfidence: number,
  nativeToolCalls?: any[],
  isSession: boolean = true,
  machineId?: string,
  conversationId?: string,
  requestStartTime?: number,
  requestEndTime?: number,
) {
  const completedTime = requestEndTime || Date.now();
  let startTime = requestStartTime || completedTime;
  if (
    body?.requestId &&
    typeof body.requestId === "string" &&
    body.requestId.startsWith("chat-")
  ) {
    const clientTime = parseInt(body.requestId.split("-")[1], 10);
    if (
      !isNaN(clientTime) &&
      clientTime > 1000000000000 &&
      clientTime <= completedTime
    ) {
      startTime = clientTime;
    }
  }
  const createdAtStr = new Date(startTime).toISOString();
  const completedAtStr = new Date(completedTime).toISOString();
  const responseDurationMs = Math.max(0, completedTime - startTime);

  const userMessages =
    body?.messages?.filter((m: any) => m.role === "user") || [];
  const currentUserMsg =
    userMessages.length > 0
      ? (typeof userMessages[userMessages.length - 1].content === "string"
          ? userMessages[userMessages.length - 1].content
          : JSON.stringify(userMessages[userMessages.length - 1].content)
        )
          .replace(/__CLASSIFIER_RESULT__:\{.*?\}\n*/g, "")
          .trimStart()
      : "";

  const clientContext = await redisStore.getClientContext(
    sessionCode,
    studentId,
  );
  const extracted = extractCodeSnapshot(body, currentUserMsg);
  const codeSnapshot =
    clientContext?.activeFile?.content || extracted.content || "";
  const activeFilePath =
    clientContext?.activeFile?.path || extracted.path || "";
  const activeFileLanguageId =
    clientContext?.activeFile?.languageId || extracted.languageId || "";
  const codeSnapshots =
    clientContext?.files && clientContext.files.length > 0
      ? clientContext.files
      : extracted.content
        ? [
            {
              path: extracted.path,
              content: extracted.content,
              languageId: extracted.languageId,
            },
          ]
        : [];

  const terminalOutput =
    clientContext?.recentTerminal?.output ||
    body?.terminalOutput ||
    body?.recentTerminal?.output ||
    "";
  const lastTerminalCommand =
    clientContext?.recentTerminal?.lastCommand ||
    body?.recentTerminal?.lastCommand ||
    "";
  const commandType =
    clientContext?.recentTerminal?.commandType ||
    body?.recentTerminal?.commandType ||
    undefined;

  // Clean CLASSIFIER_RESULT prefix from completionText
  const cleanCompletion = completionText
    .replace(/__CLASSIFIER_RESULT__:\{.*?\}\n*/g, "")
    .trim();

  // Extract classification from completionText if present (as fallback or override)
  let finalLabel = classifierLabel;
  let finalConfidence = classifierConfidence;

  const match = completionText.match(/__CLASSIFIER_RESULT__:(\{.*?\})/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && parsed.label) {
        finalLabel = parsed.label;
        finalConfidence = parsed.confidence ?? 0;
      }
    } catch (e) {
      console.error(
        "[Logger] Failed to parse CLASSIFIER_RESULT from completionText:",
        e,
      );
    }
  }

  // If still none, check history for assistant classification result
  if (finalLabel === "none" || finalLabel === "") {
    for (const msg of body.messages) {
      if (msg.role === "assistant" && typeof msg.content === "string") {
        const m = msg.content.match(/__CLASSIFIER_RESULT__:(\{.*?\})/);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed && parsed.label) {
              finalLabel = parsed.label;
              finalConfidence = parsed.confidence ?? 0;
              break;
            }
          } catch (e) {}
        }
      }
    }
  }

  // Clean CLASSIFIER_RESULT from body.messages for cleaner history
  const cleanHistory = body.messages.map((msg: any) => {
    if (typeof msg.content === "string") {
      return {
        ...msg,
        content: msg.content
          .replace(/__CLASSIFIER_RESULT__:\{.*?\}\n*/g, "")
          .trimStart(),
      };
    }
    return msg;
  });

  const lastMsg =
    body.messages && body.messages.length > 0
      ? body.messages[body.messages.length - 1]
      : null;

  const toolCalls = extractToolCalls(cleanCompletion, nativeToolCalls);
  const safeSessionCode = sanitizeFilename(
    sessionCode || "DEFAULT",
  ).toUpperCase();
  const safeStudentId = sanitizeFilename(
    studentId || "DEFAULT_USER",
  ).toUpperCase();
  const safeLogIdentifier = sanitizeFilename(
    machineId || studentId || "DEFAULT_USER",
  ).toUpperCase();

  const logDir = isSession
    ? path.resolve(process.cwd(), "logs", "sessions", safeSessionCode)
    : path.resolve(process.cwd(), "logs", "guests");
  const logFilePath = path.resolve(
    logDir,
    `${isSession ? safeStudentId : safeLogIdentifier}.json`,
  );

  try {
    await fs.promises.mkdir(logDir, { recursive: true });

    let sessionEntry: any = null;
    let currentLogsSnapshot: any[] = [];

    await withFileLock(logFilePath, async () => {
      let logs: any[] = [];
      if (fs.existsSync(logFilePath)) {
        try {
          const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
          const parsed = JSON.parse(fileContent);
          if (Array.isArray(parsed)) logs = parsed;
        } catch (e) {
          try {
            const auditLogPath = path.resolve(
              logDir,
              `${isSession ? safeStudentId : safeLogIdentifier}.log`,
            );
            if (fs.existsSync(auditLogPath)) {
              const { decryptLogFile } =
                await import("../../services/secureLogger");
              const candidateKeys = [
                (process.env.LOG_ENCRYPT_KEY || "").trim(),
                (process.env.CUSTOM_API_KEY || "").trim(),
                "1234",
                "secret",
              ].filter(Boolean);
              for (const k of candidateKeys) {
                const decrypted = decryptLogFile(auditLogPath, k) as any[];
                const valid = decrypted.filter(
                  (t) => t && !t._error && t.prompt,
                );
                if (valid.length > 0) {
                  logs = valid;
                  break;
                }
              }
            }
          } catch {}
        }
      }

      const lastEntry = logs.length > 0 ? logs[logs.length - 1] : null;
      const isContinuation =
        lastEntry &&
        lastEntry.prompt === currentUserMsg &&
        lastMsg?.role !== "user" &&
        Date.now() - new Date(lastEntry.timestamp).getTime() < 300000;

      if (isContinuation && lastEntry) {
        lastEntry.tokensConsumedTotal += totalConsumed;
        lastEntry.output = cleanCompletion;
        lastEntry.history = cleanHistory;
        lastEntry.lastUpdated = completedAtStr;
        lastEntry.completedAt = completedAtStr;
        if (!lastEntry.createdAt) {
          lastEntry.createdAt = createdAtStr;
        }
        const initialStart = new Date(lastEntry.createdAt).getTime();
        lastEntry.responseDurationMs = !isNaN(initialStart)
          ? Math.max(0, completedTime - initialStart)
          : responseDurationMs;
        lastEntry.codeSnapshot = codeSnapshot;
        lastEntry.activeFilePath = activeFilePath;
        lastEntry.activeFileLanguageId = activeFileLanguageId;
        lastEntry.codeSnapshots = codeSnapshots;
        if (conversationId && !lastEntry.conversationId) {
          lastEntry.conversationId = conversationId;
        }
        if (terminalOutput) {
          lastEntry.terminalOutput = terminalOutput;
        }
        if (lastTerminalCommand) {
          lastEntry.lastTerminalCommand = lastTerminalCommand;
        }
        if (commandType) {
          lastEntry.commandType = commandType;
        }
        if (
          finalLabel &&
          finalLabel !== "none" &&
          (!lastEntry.classification ||
            lastEntry.classification.label === "none")
        ) {
          lastEntry.classification = {
            ...(lastEntry.classification || {}),
            label: finalLabel,
            currentLabel: finalLabel,
            confidence: finalConfidence,
          };
        } else if (finalLabel && finalLabel !== "none") {
          lastEntry.classification.currentLabel = finalLabel;
        }
        if (toolCalls.length > 0 || lastEntry.agentLoops.length > 0) {
          lastEntry.agentLoops.push({
            step: lastEntry.agentLoops.length + 1,
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            toolCalls,
          });
        }
        sessionEntry = lastEntry;
      } else {
        const newEntry: any = {
          timestamp: completedAtStr,
          createdAt: createdAtStr,
          completedAt: completedAtStr,
          responseDurationMs,
          conversationId: conversationId || undefined,
          prompt: currentUserMsg,
          classification: {
            label: finalLabel || "none",
            currentLabel: finalLabel || "none",
            confidence: finalConfidence || 0,
          },
          aiOption: currentAiOption,
          tokenLimit,
          tokensConsumedTotal: totalConsumed,
          output: cleanCompletion,
          agentLoops: [],
          history: cleanHistory,
          codeSnapshot,
          activeFilePath,
          activeFileLanguageId,
          codeSnapshots,
          terminalOutput,
          lastTerminalCommand,
          ...(commandType ? { commandType } : {}),
        };

        if (toolCalls.length > 0) {
          newEntry.agentLoops.push({
            step: 1,
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            toolCalls,
          });
        }

        logs.push(newEntry);
        sessionEntry = newEntry;
      }

      const tmpPath = `${logFilePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      await fs.promises.writeFile(
        tmpPath,
        JSON.stringify(logs, null, 2),
        "utf-8",
      );
      await fs.promises.rename(tmpPath, logFilePath);
      currentLogsSnapshot = logs;
    });

    if (isSession) {
      if (sessionEntry) {
        await logSession(safeSessionCode, safeStudentId, sessionEntry);
      }
      if (s3Storage.isAvailable() && currentLogsSnapshot.length > 0) {
        await s3Storage
          .uploadStudentPromptLog(
            safeSessionCode,
            safeStudentId,
            currentLogsSnapshot,
          )
          .catch((e) => console.warn("[Logger] S3 upload error:", e));
      }
    } else {
      if (sessionEntry) {
        await logGuest(safeLogIdentifier, sessionEntry);
      }
      if (s3Storage.isAvailable() && currentLogsSnapshot.length > 0) {
        await s3Storage
          .uploadGuestPromptLog(safeLogIdentifier, currentLogsSnapshot)
          .catch((e) => console.warn("[Logger] Guest S3 upload error:", e));
      }
    }
  } catch (err) {
    console.error("[Logger] Failed to write student log:", err);
    logGlobal({
      level: "error",
      event: isSession ? "session_log_write_failed" : "guest_log_write_failed",
      sessionCode,
      studentId,
      machineId,
      error: String(err),
    });
  }
}

export async function logStudentError(
  sessionCode: string,
  studentId: string,
  currentAiOption: string,
  body: any,
  errorMsg: string,
  layer: string,
  code?: string,
  httpStatus?: number,
  isSession: boolean = true,
  machineId?: string,
) {
  const userMessages =
    body?.messages?.filter((m: any) => m.role === "user") || [];
  const currentUserMsg =
    userMessages.length > 0
      ? (typeof userMessages[userMessages.length - 1].content === "string"
          ? userMessages[userMessages.length - 1].content
          : JSON.stringify(userMessages[userMessages.length - 1].content)
        )
          .replace(/__CLASSIFIER_RESULT__:\{.*?\}\n*/g, "")
          .trimStart()
      : "";

  const clientContext = await redisStore
    .getClientContext(sessionCode, studentId)
    .catch(() => null);
  const extracted = extractCodeSnapshot(body, currentUserMsg);
  const codeSnapshot =
    clientContext?.activeFile?.content || extracted.content || "";
  const activeFilePath =
    clientContext?.activeFile?.path || extracted.path || "";
  const activeFileLanguageId =
    clientContext?.activeFile?.languageId || extracted.languageId || "";
  const codeSnapshots =
    clientContext?.files && clientContext.files.length > 0
      ? clientContext.files
      : extracted.content
        ? [
            {
              path: extracted.path,
              content: extracted.content,
              languageId: extracted.languageId,
            },
          ]
        : [];

  const safeSessionCode = sanitizeFilename(
    sessionCode || "DEFAULT",
  ).toUpperCase();
  const safeStudentId = sanitizeFilename(
    studentId || "DEFAULT_USER",
  ).toUpperCase();
  const safeLogIdentifier = sanitizeFilename(
    machineId || studentId || "DEFAULT_USER",
  ).toUpperCase();

  const logDir = isSession
    ? path.resolve(process.cwd(), "logs", "sessions", safeSessionCode)
    : path.resolve(process.cwd(), "logs", "guests");
  const logFilePath = path.resolve(
    logDir,
    `${isSession ? safeStudentId : safeLogIdentifier}.json`,
  );

  try {
    await fs.promises.mkdir(logDir, { recursive: true });

    let logs: any[] = [];
    if (fs.existsSync(logFilePath)) {
      try {
        const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
        logs = JSON.parse(fileContent);
      } catch (e) {
        // file empty or invalid
      }
    }

    const newEntry: any = {
      timestamp: new Date().toISOString(),
      prompt: currentUserMsg,
      aiOption: currentAiOption,
      error: {
        layer,
        message: errorMsg,
        code: code || "ERROR",
        httpStatus: httpStatus || 500,
      },
      history: body?.messages || [],
      codeSnapshot,
      activeFilePath,
      activeFileLanguageId,
      codeSnapshots,
    };

    logs.push(newEntry);

    await fs.promises.writeFile(
      logFilePath,
      JSON.stringify(logs, null, 2),
      "utf-8",
    );

    if (isSession) {
      await logSession(safeSessionCode, safeStudentId, newEntry).catch(
        () => {},
      );
    } else {
      await logGuest(safeLogIdentifier, newEntry).catch(() => {});
    }
  } catch (err) {
    console.error("[Logger] Failed to write student error log:", err);
  }
}
