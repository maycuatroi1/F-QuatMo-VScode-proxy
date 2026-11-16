import fs from "fs";
import path from "path";
import { redisStore, type ClientContext, type TurnLog } from "./redisStore";
import { evaluateTurnSemanticFeatures } from "./llmEvaluator";
import {
  calculateIemConfidence,
  calculateProgrammaticFeatures,
  calculateSignalScore,
  calculateRawSessionSignalScore,
  deriveIemLabel,
  deriveSessionIemLabel,
  blendFeatures,
  extractCodeSnapshot,
  INSTRUMENTAL_WEIGHTS,
  EXECUTIVE_WEIGHTS,
  IEM_WINDOW_SIZE,
  FEATURE_SCHEMA,
} from "./features";
import { sessionStates } from "../sessionStore";
import { eventBus } from "../eventBus";
import { s3Storage } from "../s3Storage";
import { atomicWriteJson, withFileLock } from "../promptLogService";
export { withFileLock };
import {
  classifyCurrentPrompt,
  type IemLabel,
} from "./currentPromptClassifier";
import { classifierConcurrencyController } from "./concurrencyLimiter";

export interface EvaluationResult {
  label: IemLabel | string;
  overallLabel?: IemLabel;
  currentLabel?: IemLabel;
  confidence: number;
  iScoreS: number;
  eScoreS: number;
  iScoreSRaw?: number;
  eScoreSRaw?: number;
  iScoreTurn: number;
  eScoreTurn: number;
  windowSize: number;
  featureSchema?: string;
}

export interface TopNClassificationResult {
  label: IemLabel;
  overallLabel?: IemLabel;
  confidence: number;
  source: string;
  windowSize?: number;
  iScoreS?: number;
  eScoreS?: number;
  iScoreSRaw?: number;
  eScoreSRaw?: number;
  featureSchema?: string;
}

/**
 * Retrieves the student's active IEM label derived from their top-N sliding window history.
 * Uses unclamped raw session SignalScore + IEM_DECISION_GATE (M_I=0.60, M_E=0.30) to stay
 * 100% consistent with evaluateTurnAndSession.
 */
export async function getStudentTopNClassification(
  sessionCode: string,
  studentId: string,
  token?: string,
  conversationId?: string,
): Promise<TopNClassificationResult> {
  const sCode = (sessionCode || "DEFAULT").toUpperCase();
  const sId = (studentId || "DEFAULT_USER").toUpperCase();
  const stateKey = `${sCode}:${sId}`;

  // 1. Derive directly from the top-N window turns in Redis / in-memory store
  try {
    const turns = await redisStore.getTurns(sCode, sId, conversationId);
    if (turns && turns.length > 0) {
      const windowTurns = turns.slice(-IEM_WINDOW_SIZE);
      const I_score_S_raw = calculateRawSessionSignalScore(
        windowTurns.map((turn) => turn.I_score),
      );
      const E_score_S_raw = calculateRawSessionSignalScore(
        windowTurns.map((turn) => turn.E_score),
      );
      const label = deriveSessionIemLabel(I_score_S_raw, E_score_S_raw);
      const I_score_S = Math.min(1.0, I_score_S_raw);
      const E_score_S = Math.min(1.0, E_score_S_raw);
      const confidence = calculateIemConfidence(label, I_score_S, E_score_S);
      return {
        label,
        overallLabel: label,
        confidence,
        source: `window_turns(${windowTurns.length})`,
        windowSize: windowTurns.length,
        iScoreS: I_score_S,
        eScoreS: E_score_S,
        iScoreSRaw: I_score_S_raw,
        eScoreSRaw: E_score_S_raw,
        featureSchema: FEATURE_SCHEMA,
      };
    }
  } catch (err) {
    console.warn(
      "[Classifier] Failed to get window turns for top-N label:",
      err,
    );
  }

  try {
    let logFilePath = path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      sCode,
      `${sId}.json`,
    );
    if (!fs.existsSync(logFilePath)) {
      logFilePath = path.resolve(
        process.cwd(),
        "logs",
        "guests",
        `${sId}.json`,
      );
    }
    if (fs.existsSync(logFilePath)) {
      const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
      const logs = JSON.parse(fileContent);
      if (Array.isArray(logs) && logs.length > 0) {
        const matchingLogs = conversationId
          ? logs.filter((e: any) => e.conversationId === conversationId)
          : logs;

        for (let i = matchingLogs.length - 1; i >= 0; i--) {
          const entry = matchingLogs[i];
          const c = entry?.classification;
          const candidate = c?.trendLabel || c?.label || c?.currentLabel;
          if (candidate && candidate !== "none") {
            const norm = candidate.toLowerCase().trim();
            if (
              norm === "instrumental" ||
              norm === "executive" ||
              norm === "mixed"
            ) {
              return {
                label: norm as IemLabel,
                overallLabel: norm as IemLabel,
                confidence:
                  typeof c?.confidence === "number" ? c.confidence : 0.8,
                source: "log_history",
                windowSize:
                  typeof c?.windowSize === "number" ? c.windowSize : 1,
                iScoreS: typeof c?.iScoreS === "number" ? c.iScoreS : undefined,
                eScoreS: typeof c?.eScoreS === "number" ? c.eScoreS : undefined,
                iScoreSRaw:
                  typeof c?.iScoreSRaw === "number" ? c.iScoreSRaw : undefined,
                eScoreSRaw:
                  typeof c?.eScoreSRaw === "number" ? c.eScoreSRaw : undefined,
                featureSchema: c?.featureSchema,
              };
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[Classifier] Failed to read log file for top-N label:", err);
  }

  if (conversationId) {
    return {
      label: "mixed",
      overallLabel: "mixed",
      confidence: 0.5,
      source: "new_conversation",
      windowSize: 0,
    };
  }

  try {
    const state = sessionStates.get(stateKey);
    if (state?.latestClassification && state.latestClassification !== "none") {
      const norm = state.latestClassification.toLowerCase().trim();
      if (norm === "instrumental" || norm === "executive" || norm === "mixed") {
        return {
          label: norm as IemLabel,
          overallLabel: norm as IemLabel,
          confidence: 0.8,
          source: "session_state",
        };
      }
    }
  } catch (err) {
    console.warn(
      "[Classifier] Failed to check sessionStates for top-N label:",
      err,
    );
  }

  return {
    label: "mixed",
    overallLabel: "mixed",
    confidence: 0.5,
    source: "default_fallback",
    windowSize: 0,
  };
}

export async function evaluateTurnAndSession(
  sessionCode: string,
  studentId: string,
  token: string,
  prompt: string,
  response: string,
  history: Array<{ role: string; content: string }>,
  isFastTrack = false,
  conversationId?: string,
): Promise<EvaluationResult | null> {
  const sCode = sessionCode.toUpperCase();
  const sId = studentId.toUpperCase();
  const stateKey = `${sCode}:${sId}`;

  try {
    const clientContext = await redisStore.getClientContext(sCode, sId);
    const turns = await redisStore.getTurns(sCode, sId, conversationId);
    const priorTurns = turns.slice(-(IEM_WINDOW_SIZE - 1));
    const lastTurn =
      priorTurns.length > 0 ? priorTurns[priorTurns.length - 1] : null;

    const now = Date.now();
    const timeDeltaSeconds = lastTurn ? (now - lastTurn.timestamp) / 1000 : 0;

    const extracted = extractCodeSnapshot(null, prompt);
    const codeSnapshot =
      clientContext?.activeFile?.content || extracted.content || "";
    const activeFile =
      clientContext?.activeFile ||
      (extracted.content
        ? {
            path: extracted.path,
            content: extracted.content,
            languageId: extracted.languageId,
          }
        : undefined);
    const codeSnapshots =
      clientContext?.files && clientContext.files.length > 0
        ? clientContext.files
        : activeFile
          ? [
              {
                path: activeFile.path,
                content: activeFile.content,
                languageId:
                  "languageId" in activeFile && activeFile.languageId
                    ? activeFile.languageId
                    : extracted.languageId,
              },
            ]
          : [];

    const evalClientContext: ClientContext | null =
      clientContext || activeFile || codeSnapshots.length > 0
        ? {
            activeFile: activeFile
              ? {
                  path: activeFile.path,
                  content: activeFile.content,
                  languageId:
                    "languageId" in activeFile && activeFile.languageId
                      ? activeFile.languageId
                      : extracted.languageId,
                }
              : undefined,
            files: codeSnapshots,
            recentPaste: clientContext?.recentPaste,
            recentTerminal: clientContext?.recentTerminal,
          }
        : null;

    const enableHeuristicFastTrack =
      process.env.ENABLE_HEURISTIC_PREFLIGHT === "true";

    // Step 1: Single-pass LLM semantic evaluation (fvs-codexgold-online-v3, 32 keys).
    // Must run BEFORE programmatic features so recurring delegation (t10) can use semantic e2.
    let semantic: Record<string, number>;
    if (isFastTrack && enableHeuristicFastTrack) {
      console.log(
        `[Evaluator] Running Fast-Track Heuristic evaluation for ${sId} in ${sCode}`,
      );
      const decision = classifyCurrentPrompt(prompt);
      semantic = { ...decision.activeFeatures };
    } else {
      if (isFastTrack) {
        console.log(
          `[Evaluator] High load detected for ${sId} in ${sCode}, but heuristic shortcut is DISABLED for research data collection integrity. Running full deep LLM evaluation.`,
        );
      }
      semantic = await evaluateTurnSemanticFeatures(
        prompt,
        response,
        codeSnapshot,
        history,
        codeSnapshots,
        activeFile,
        priorTurns,
        clientContext?.recentTerminal,
      );
    }

    // Step 2: Programmatic evidence detectors (e2, t4, t10, c1, c5 copy veto) with semantic e2 input.
    const programmatic = calculateProgrammaticFeatures(
      prompt,
      response,
      evalClientContext,
      lastTurn,
      timeDeltaSeconds,
      priorTurns,
      semantic,
    );

    // Step 3: Trust-weighted blending with strict > 0.5 threshold, r8 subsumption, and copy veto.
    const disagreements: string[] = [];
    const combinedFeatures = blendFeatures(
      semantic,
      programmatic,
      (key, prog, llm, blended) => {
        if (Math.abs(prog - llm) > 0.4) {
          disagreements.push(
            `${key}[prog=${prog.toFixed(2)},llm=${llm.toFixed(2)}→${blended.toFixed(2)}]`,
          );
        }
      },
    );

    if (disagreements.length > 0 && process.env.CLASSIFIER_VERBOSE === "true") {
      console.log(
        `[Evaluator] Prog/LLM disagreements for ${sId}:`,
        disagreements.join(", "),
      );
    }

    const iTurnValues: number[] = [];
    for (const [key, weight] of Object.entries(INSTRUMENTAL_WEIGHTS)) {
      const act = combinedFeatures[key] ?? 0;
      if (act > 0) {
        iTurnValues.push(weight);
      }
    }
    const I_score_Ti = calculateSignalScore(iTurnValues);

    const eTurnValues: number[] = [];
    for (const [key, weight] of Object.entries(EXECUTIVE_WEIGHTS)) {
      const act = combinedFeatures[key] ?? 0;
      if (act > 0) {
        eTurnValues.push(weight);
      }
    }
    const E_score_Ti = calculateSignalScore(eTurnValues);

    const currentLabel = deriveIemLabel(I_score_Ti, E_score_Ti);

    const currentTurn: TurnLog = {
      timestamp: now,
      prompt,
      response,
      codeSnapshot,
      activeFilePath: activeFile?.path || undefined,
      terminalOutput: clientContext?.recentTerminal?.output,
      lastTerminalCommand: clientContext?.recentTerminal?.lastCommand,
      commandType: clientContext?.recentTerminal?.commandType,
      terminalTimestamp: clientContext?.recentTerminal?.timestamp,
      I_score: I_score_Ti,
      E_score: E_score_Ti,
      featureVector: combinedFeatures,
      schemaVersion: FEATURE_SCHEMA,
    };

    const windowTurns = await redisStore.pushTurnAtomic(
      sCode,
      sId,
      currentTurn,
      IEM_WINDOW_SIZE,
      conversationId,
    );

    const I_score_S_raw = calculateRawSessionSignalScore(
      windowTurns.map((turn) => turn.I_score),
    );
    const E_score_S_raw = calculateRawSessionSignalScore(
      windowTurns.map((turn) => turn.E_score),
    );
    const overallLabel = deriveSessionIemLabel(I_score_S_raw, E_score_S_raw);
    const I_score_S = Math.min(1.0, I_score_S_raw);
    const E_score_S = Math.min(1.0, E_score_S_raw);
    const deltaRaw = I_score_S_raw - E_score_S_raw;
    const label = overallLabel;
    const confidence = calculateIemConfidence(label, I_score_S, E_score_S);

    console.log(
      `[Evaluator] IEM Result (${FEATURE_SCHEMA}) for ${sId} in ${sCode}${conversationId ? ` [Conv: ${conversationId}]` : ""} (Window: ${windowTurns.length}) -> ` +
        `currentLabel: ${currentLabel.toUpperCase()} [I(Turn): ${I_score_Ti.toFixed(2)} | E(Turn): ${E_score_Ti.toFixed(2)}] | ` +
        `overallLabel (top5): ${overallLabel.toUpperCase()} [I(Raw): ${I_score_S_raw.toFixed(2)} | E(Raw): ${E_score_S_raw.toFixed(2)} | Delta: ${deltaRaw.toFixed(2)}]`,
    );

    await redisStore.cacheClassification(token, label, confidence);

    const state = sessionStates.get(stateKey);
    if (state) {
      const extendedState = state as any;
      extendedState.latestClassification = label;
      extendedState.I_score_S = I_score_S;
      extendedState.E_score_S = E_score_S;
      extendedState.I_score_S_raw = I_score_S_raw;
      extendedState.E_score_S_raw = E_score_S_raw;
      sessionStates.set(stateKey, state);
    }

    eventBus
      .publishIemUpdate({
        token,
        sessionCode: sCode,
        studentId: sId,
        conversationId,
        label: overallLabel,
        overallLabel,
        currentLabel,
        confidence,
        iScoreS: I_score_S,
        eScoreS: E_score_S,
        iScoreSRaw: I_score_S_raw,
        eScoreSRaw: E_score_S_raw,
        iScoreTurn: I_score_Ti,
        eScoreTurn: E_score_Ti,
        windowSize: windowTurns.length,
        featureSchema: FEATURE_SCHEMA,
        timestamp: now,
      })
      .catch((busErr) => {
        console.warn(
          "[Evaluator] Failed to publish IEM update to event bus:",
          busErr,
        );
      });

    try {
      const safeSessionCode = (sCode || "DEFAULT").toUpperCase();
      const safeStudentId = (sId || "DEFAULT_USER").toUpperCase();
      const logDir = path.resolve(
        process.cwd(),
        "logs",
        "sessions",
        safeSessionCode,
      );
      let isGuestLog = false;
      let logFilePath = path.resolve(logDir, `${safeStudentId}.json`);
      if (!fs.existsSync(logFilePath)) {
        const rawSessionPath = path.resolve(logDir, `${sId}.json`);
        if (fs.existsSync(rawSessionPath)) {
          logFilePath = rawSessionPath;
        }
      }
      if (!fs.existsSync(logFilePath)) {
        const guestPath = path.resolve(
          process.cwd(),
          "logs",
          "guests",
          `${safeStudentId}.json`,
        );
        if (fs.existsSync(guestPath)) {
          logFilePath = guestPath;
          isGuestLog = true;
        } else {
          const altGuest = path.resolve(
            process.cwd(),
            "logs",
            "guests",
            `${sId}.json`,
          );
          if (fs.existsSync(altGuest)) {
            logFilePath = altGuest;
            isGuestLog = true;
          }
        }
      }
      if (fs.existsSync(logFilePath)) {
        const normalizePromptForMatch = (text: any): string =>
          (typeof text === "string" ? text : "")
            .replace(/__CLASSIFIER_RESULT__:\{.*?\}\n*/g, "")
            .trimStart();
        const normalizedTargetPrompt = normalizePromptForMatch(prompt);
        const updatedLogsSnapshot = await withFileLock<any[] | null>(
          logFilePath,
          async () => {
            const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
            const logs = JSON.parse(fileContent);
            if (Array.isArray(logs) && logs.length > 0) {
              const targetEntry = logs
                .slice()
                .reverse()
                .find(
                  (e: any) =>
                    normalizePromptForMatch(e?.prompt) === normalizedTargetPrompt &&
                    (!conversationId ||
                      !e?.conversationId ||
                      e.conversationId === conversationId),
                );
              if (!targetEntry) {
                console.warn(
                  `[Evaluator] Matching log entry not yet written for ${safeStudentId} in ${logFilePath}; skipping overwrite to protect prior turns.`,
                );
                return null;
              }
              targetEntry.classification = {
                ...(targetEntry.classification || {}),
                label: overallLabel,
                overallLabel,
                currentLabel,
                trendLabel: overallLabel,
                confidence,
                iScoreS: I_score_S,
                eScoreS: E_score_S,
                iScoreSRaw: I_score_S_raw,
                eScoreSRaw: E_score_S_raw,
                iScoreTurn: I_score_Ti,
                eScoreTurn: E_score_Ti,
                windowSize: windowTurns.length,
                featureSchema: FEATURE_SCHEMA,
                method: "signal_score_model_prediction_w5",
                summary: `currentLabel: ${currentLabel} | overallLabel: ${overallLabel} | I(Raw): ${I_score_S_raw.toFixed(2)} | E(Raw): ${E_score_S_raw.toFixed(2)}`,
                features: combinedFeatures,
              };
              targetEntry.featureVector = combinedFeatures;
              if (activeFile?.path && !targetEntry.activeFilePath) {
                targetEntry.activeFilePath = activeFile.path;
              }
              if (
                clientContext?.recentTerminal?.commandType &&
                !targetEntry.commandType
              ) {
                targetEntry.commandType = clientContext.recentTerminal.commandType;
              }
              if (conversationId && !targetEntry.conversationId) {
                targetEntry.conversationId = conversationId;
              }
              await atomicWriteJson(logFilePath, logs);
              console.log(
                `[Evaluator] Updated local JSON log file for ${safeStudentId} with currentLabel: ${currentLabel} | overallLabel (top5): ${overallLabel}${conversationId ? ` [Conv: ${conversationId}]` : ""}`,
              );
              return logs;
            }
            return null;
          },
        );

        if (
          updatedLogsSnapshot &&
          updatedLogsSnapshot.length > 0 &&
          s3Storage.isAvailable()
        ) {
          const logTargetId = path.basename(logFilePath, ".json");
          const s3SyncPromise = isGuestLog
            ? s3Storage.uploadGuestPromptLog(logTargetId, updatedLogsSnapshot)
            : s3Storage.uploadStudentPromptLog(
                safeSessionCode,
                logTargetId,
                updatedLogsSnapshot,
              );
          s3SyncPromise.catch((s3Err) => {
            console.warn(
              "[Evaluator] Failed to re-sync enriched prompt log to S3:",
              s3Err,
            );
          });
        }
      }
    } catch (logErr) {
      console.error(
        "[Evaluator] Failed to update JSON log file with IEM label:",
        logErr,
      );
    }

    return {
      label: overallLabel,
      overallLabel,
      currentLabel,
      confidence,
      iScoreS: I_score_S,
      eScoreS: E_score_S,
      iScoreSRaw: I_score_S_raw,
      eScoreSRaw: E_score_S_raw,
      iScoreTurn: I_score_Ti,
      eScoreTurn: E_score_Ti,
      windowSize: windowTurns.length,
      featureSchema: FEATURE_SCHEMA,
    };
  } catch (err: any) {
    console.error("[Evaluator] Error in evaluateTurnAndSession:", err.message);
    return null;
  } finally {
    await redisStore.setEvaluationPending(token, false).catch(() => {});
  }
}

/**
 * Enqueues turn evaluation into the Keyed FIFO Concurrency Controller.
 * Ensures turns for the same student are processed in strict causal sequence,
 * while independent students run concurrently in parallel.
 */
export function queueEvaluation(
  sessionCode: string,
  studentId: string,
  token: string,
  prompt: string,
  response: string,
  history: Array<{ role: string; content: string }>,
  conversationId?: string,
): Promise<EvaluationResult | null> {
  const clientKey = `${(sessionCode || "DEFAULT").toUpperCase()}:${(studentId || "DEFAULT_USER").toUpperCase()}`;
  return classifierConcurrencyController.enqueue(clientKey, (isFastTrack) =>
    evaluateTurnAndSession(
      sessionCode,
      studentId,
      token,
      prompt,
      response,
      history,
      isFastTrack,
      conversationId,
    ),
  );
}
