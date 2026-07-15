import fs from "fs";
import path from "path";
import { redisStore } from "./redisStore";
import { evaluateTurnSemanticFeatures } from "./llmEvaluator";
import {
  calculateIemConfidence,
  calculateProgrammaticFeatures,
  calculateSignalScore,
  calculateWindowScore,
  deriveIemLabel,
  INSTRUMENTAL_WEIGHTS,
  EXECUTIVE_WEIGHTS,
} from "./features";
import { sessionStates } from "../sessionStore";

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
    const priorTurns = turns.slice(-4);
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
    );

    const codeSnapshot = clientContext?.activeFile?.content || "";
    const codeSnapshots = clientContext?.files || [];
    const activeFile = clientContext?.activeFile;
    const semantic = await evaluateTurnSemanticFeatures(
      prompt,
      response,
      codeSnapshot,
      history,
      codeSnapshots,
      activeFile,
      priorTurns,
    );

    const combinedFeatures: Record<string, number> = {
      ...semantic,
      ...programmatic,
    };

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
      I_score: I_score_Ti,
      E_score: E_score_Ti,
      featureVector: combinedFeatures,
    };

    const windowTurns = [...priorTurns, currentTurn].slice(-5);
    await redisStore.saveTurns(sCode, sId, windowTurns);

    const I_score_S = calculateWindowScore(
      windowTurns.map((turn) => turn.I_score),
    );
    const E_score_S = calculateWindowScore(
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

    try {
      const logDir = path.resolve(process.cwd(), "logs", "sessions", sCode);
      const logFilePath = path.resolve(logDir, `${sId}.json`);
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
            method: "sliding_window_turn_score_average_v2",
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
