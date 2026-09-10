import fs from "fs";
import path from "path";
import { redisStore } from "./redisStore";
import { evaluateTurnSemanticFeatures } from "./llmEvaluator";
import {
  calculateIemConfidence,
  calculateProgrammaticFeatures,
  calculateSignalScore,
  calculateSessionSignalScore,
  deriveIemLabel,
  blendFeatures,
  extractCodeSnapshot,
  INSTRUMENTAL_WEIGHTS,
  EXECUTIVE_WEIGHTS,
  IEM_WINDOW_SIZE,
} from "./features";
import { sessionStates } from "../sessionStore";
import type { IemLabel } from "./currentPromptClassifier";

export interface TopNClassificationResult {
  label: IemLabel;
  confidence: number;
  source: string;
  windowSize?: number;
  iScoreS?: number;
  eScoreS?: number;
}

/**
 * Retrieves the student's active IEM label derived from their top-N sliding window history.
 * Does not perform prompt-level regex classification; instead reads from the evaluated
 * sliding window (turns), sessionStates, token cache, or historical log files.
 */
export async function getStudentTopNClassification(
  sessionCode: string,
  studentId: string,
  token?: string,
): Promise<TopNClassificationResult> {
  const sCode = (sessionCode || "DEFAULT").toUpperCase();
  const sId = (studentId || "DEFAULT_USER").toUpperCase();
  const stateKey = `${sCode}:${sId}`;

  // 1. Derive directly from the top-N window turns in Redis / in-memory store
  try {
    const turns = await redisStore.getTurns(sCode, sId);
    if (turns && turns.length > 0) {
      const windowTurns = turns.slice(-IEM_WINDOW_SIZE);
      const I_score_S = calculateSessionSignalScore(
        windowTurns.map((turn) => turn.I_score),
      );
      const E_score_S = calculateSessionSignalScore(
        windowTurns.map((turn) => turn.E_score),
      );
      const rawLabel = deriveIemLabel(I_score_S, E_score_S);
      const label: IemLabel =
        rawLabel === "executive" || rawLabel === "instrumental"
          ? rawLabel
          : "mixed";
      const confidence = calculateIemConfidence(label, I_score_S, E_score_S);
      return {
        label,
        confidence,
        source: `window_turns(${windowTurns.length})`,
        windowSize: windowTurns.length,
        iScoreS: I_score_S,
        eScoreS: E_score_S,
      };
    }
  } catch (err) {
    console.warn("[Classifier] Failed to get window turns for top-N label:", err);
  }

  // 2. Check sessionStates (in-memory SQLite persistent map)
  try {
    const state = sessionStates.get(stateKey);
    if (state?.latestClassification && state.latestClassification !== "none") {
      const norm = state.latestClassification.toLowerCase().trim();
      if (norm === "instrumental" || norm === "executive" || norm === "mixed") {
        return {
          label: norm as IemLabel,
          confidence: 0.8,
          source: "session_state",
        };
      }
    }
  } catch (err) {
    console.warn("[Classifier] Failed to check sessionStates for top-N label:", err);
  }

  // 3. Check cached classification in Redis / memory by token
  if (token) {
    try {
      const cached = await redisStore.getCachedClassification(token);
      if (cached?.label && cached.label !== "none") {
        const norm = cached.label.toLowerCase().trim();
        if (norm === "instrumental" || norm === "executive" || norm === "mixed") {
          return {
            label: norm as IemLabel,
            confidence: cached.confidence || 0.8,
            source: "cached_token",
          };
        }
      }
    } catch (err) {
      console.warn("[Classifier] Failed to get cached classification for top-N label:", err);
    }
  }

  // 4. Fallback to student's saved JSON log file
  try {
    let logFilePath = path.resolve(process.cwd(), "logs", "sessions", sCode, `${sId}.json`);
    if (!fs.existsSync(logFilePath)) {
      logFilePath = path.resolve(process.cwd(), "logs", "guests", `${sId}.json`);
    }
    if (fs.existsSync(logFilePath)) {
      const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
      const logs = JSON.parse(fileContent);
      if (Array.isArray(logs) && logs.length > 0) {
        for (let i = logs.length - 1; i >= 0; i--) {
          const entry = logs[i];
          const c = entry?.classification;
          const candidate = c?.trendLabel || c?.label || c?.currentLabel;
          if (candidate && candidate !== "none") {
            const norm = candidate.toLowerCase().trim();
            if (norm === "instrumental" || norm === "executive" || norm === "mixed") {
              return {
                label: norm as IemLabel,
                confidence: typeof c?.confidence === "number" ? c.confidence : 0.8,
                source: "log_history",
              };
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[Classifier] Failed to read log file for top-N label:", err);
  }

  // 5. Default fallback if student has no prior turns
  return {
    label: "mixed",
    confidence: 0.5,
    source: "default_fallback",
  };
}

export async function evaluateTurnAndSession(
  sessionCode: string,
  studentId: string,
  token: string,
  prompt: string,
  response: string,
  history: Array<{ role: string; content: string }>,
): Promise<void> {
  const sCode = sessionCode.toUpperCase();
  const sId = studentId.toUpperCase();
  const stateKey = `${sCode}:${sId}`;

  try {
    const clientContext = await redisStore.getClientContext(sCode, sId);
    const turns = await redisStore.getTurns(sCode, sId);
    const priorTurns = turns.slice(-(IEM_WINDOW_SIZE - 1));
    const lastTurn =
      priorTurns.length > 0 ? priorTurns[priorTurns.length - 1] : null;

    const now = Date.now();
    const timeDeltaSeconds = lastTurn ? (now - lastTurn.timestamp) / 1000 : 0;

    const programmatic = calculateProgrammaticFeatures(
      prompt,
      response,
      clientContext,
      lastTurn,
      timeDeltaSeconds,
      priorTurns,
    );

    const extracted = extractCodeSnapshot(null, prompt);
    const codeSnapshot = clientContext?.activeFile?.content || extracted.content || "";
    const activeFile = clientContext?.activeFile || (extracted.content ? { path: extracted.path, content: extracted.content } : undefined);
    const codeSnapshots = clientContext?.files && clientContext.files.length > 0
      ? clientContext.files
      : activeFile
        ? [{ path: activeFile.path, content: activeFile.content, languageId: extracted.languageId }]
        : [];
    const semantic = await evaluateTurnSemanticFeatures(
      prompt,
      response,
      codeSnapshot,
      history,
      codeSnapshots,
      activeFile,
      priorTurns,
      clientContext?.recentTerminal,
    );

    // Blend programmatic and LLM semantic features using per-feature trust weights.
    // - Features only in programmatic (c6, c7, t9): pass through
    // - Features only in LLM (i1-i8, e1-e6, r1-r8, t1-t8, c4, c5): pass through
    // - Features in BOTH (c1-c3, c8-c10, t10): blended = progTrust×prog + (1-progTrust)×llm
    const disagreements: string[] = [];
    const combinedFeatures = blendFeatures(semantic, programmatic, (key, prog, llm, blended) => {
      if (Math.abs(prog - llm) > 0.40) {
        disagreements.push(`${key}[prog=${prog.toFixed(2)},llm=${llm.toFixed(2)}→${blended.toFixed(2)}]`);
      }
    });
    if (disagreements.length > 0) {
      console.log(`[Evaluator] Feature disagreements (prog vs LLM): ${disagreements.join(" | ")}`);
    }

    const iTurnValues: number[] = [];
    for (const [key, weight] of Object.entries(INSTRUMENTAL_WEIGHTS)) {
      const act = combinedFeatures[key] ?? 0;
      iTurnValues.push(act * weight);
    }
    const I_score_Ti = calculateSignalScore(iTurnValues);

    const eTurnValues: number[] = [];
    for (const [key, weight] of Object.entries(EXECUTIVE_WEIGHTS)) {
      const act = combinedFeatures[key] ?? 0;
      eTurnValues.push(act * weight);
    }
    const E_score_Ti = calculateSignalScore(eTurnValues);

    const currentTurn = {
      timestamp: now,
      prompt,
      response,
      codeSnapshot,
      terminalOutput: clientContext?.recentTerminal?.output,
      lastTerminalCommand: clientContext?.recentTerminal?.lastCommand,
      I_score: I_score_Ti,
      E_score: E_score_Ti,
      featureVector: combinedFeatures,
    };

    const windowTurns = [...priorTurns, currentTurn].slice(-IEM_WINDOW_SIZE);
    await redisStore.saveTurns(sCode, sId, windowTurns);

    const I_score_S = calculateSessionSignalScore(
      windowTurns.map((turn) => turn.I_score),
    );
    const E_score_S = calculateSessionSignalScore(
      windowTurns.map((turn) => turn.E_score),
    );
    const delta = I_score_S - E_score_S;
    const label = deriveIemLabel(I_score_S, E_score_S);
    const confidence = calculateIemConfidence(label, I_score_S, E_score_S);

    console.log(
      `[Evaluator] Sliding window updated for ${sId} in ${sCode} -> I(S): ${I_score_S.toFixed(
        2,
      )} | E(S): ${E_score_S.toFixed(2)} | Delta: ${delta.toFixed(2)} | Window: ${windowTurns.length} | Label: ${label}`,
    );

    await redisStore.cacheClassification(token, label, confidence);

    const state = sessionStates.get(stateKey);
    if (state) {
      const extendedState = state as any;
      extendedState.latestClassification = label;
      extendedState.I_score_S = I_score_S;
      extendedState.E_score_S = E_score_S;
      sessionStates.set(stateKey, state);
    }

    // Broadcast real-time SSE event to Fvscode client and Admin dashboard (0ms latency)
    try {
      const { broadcastStudentEvent, broadcastSessionEvent } = await import("../eventStream");
      void broadcastStudentEvent(sCode, sId, "iem_update", {
        label,
        confidence,
        iScoreS: I_score_S,
        eScoreS: E_score_S,
        iScoreTurn: I_score_Ti,
        eScoreTurn: E_score_Ti,
        windowSize: windowTurns.length,
        timestamp: Date.now(),
      });
      void broadcastSessionEvent(sCode, "session_state_update", {
        studentId: sId,
        latestClassification: label,
        iScoreS: I_score_S,
        eScoreS: E_score_S,
        timestamp: Date.now(),
      });
    } catch (broadcastErr) {
      console.error("[Evaluator] Failed to broadcast real-time event:", broadcastErr);
    }

    try {
      const logDir = path.resolve(process.cwd(), "logs", "sessions", sCode);
      let logFilePath = path.resolve(logDir, `${sId}.json`);
      if (!fs.existsSync(logFilePath)) {
        const guestPath = path.resolve(process.cwd(), "logs", "guests", `${sId}.json`);
        if (fs.existsSync(guestPath)) {
          logFilePath = guestPath;
        }
      }
      if (fs.existsSync(logFilePath)) {
        const fileContent = await fs.promises.readFile(logFilePath, "utf-8");
        const logs = JSON.parse(fileContent);
        if (logs.length > 0) {
          const lastEntry = logs[logs.length - 1];
          const currentLabel =
            lastEntry.classification?.currentLabel ||
            lastEntry.classification?.label ||
            "mixed";
          lastEntry.classification = {
            label,
            currentLabel,
            trendLabel: label,
            confidence,
            iScoreS: I_score_S,
            eScoreS: E_score_S,
            iScoreTurn: I_score_Ti,
            eScoreTurn: E_score_Ti,
            windowSize: windowTurns.length,
            method: "sliding_window_hierarchical_signal_score_v3",
            summary: `I(S): ${I_score_S.toFixed(2)} | E(S): ${E_score_S.toFixed(2)} | Label: ${label}`,
          };
          await fs.promises.writeFile(
            logFilePath,
            JSON.stringify(logs, null, 2),
            "utf-8",
          );
          console.log(
            `[Evaluator] Updated local JSON log file for ${sId} with classification: ${label}`,
          );
        }
      }
    } catch (logErr) {
      console.error(
        "[Evaluator] Failed to update JSON log file with IEM label:",
        logErr,
      );
    }
  } catch (err: any) {
    console.error("[Evaluator] Error in evaluateTurnAndSession:", err.message);
  } finally {
    await redisStore.setEvaluationPending(token, false).catch(() => {});
  }
}
