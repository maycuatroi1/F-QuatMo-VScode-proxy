import { redisStore } from "./redisStore";
import { evaluateTurnSemanticFeatures } from "./llmEvaluator";
import {
  calculateProgrammaticFeatures,
  calculateSignalScore,
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
    let turns = await redisStore.getTurns(sCode, sId);
    if (turns.length >= 5) {
      turns = [];
    }
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

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

    turns.push({
      timestamp: now,
      prompt,
      response,
      codeSnapshot,
      I_score: I_score_Ti,
      E_score: E_score_Ti,
    });

    await redisStore.saveTurns(sCode, sId, turns);

    const I_score_S = calculateSignalScore(turns.map((t) => t.I_score));
    const E_score_S = calculateSignalScore(turns.map((t) => t.E_score));
    const D_S = I_score_S - E_score_S;

    const HIGH = 0.55;
    const MID = 0.45;
    const MARGIN = 0.15;

    let label = "ambiguous";
    if (I_score_S >= HIGH && E_score_S < MID && D_S >= MARGIN) {
      label = "instrumental";
    } else if (E_score_S >= HIGH && I_score_S < MID && -D_S >= MARGIN) {
      label = "executive";
    } else if (I_score_S >= MID && E_score_S >= MID) {
      label = "mixed";
    }

    console.log(
      `[Evaluator] Session State Updated for ${sId} in ${sCode} ➔ I(S): ${I_score_S.toFixed(
        2,
      )} | E(S): ${E_score_S.toFixed(2)} | Label: ${label}`,
    );

    await redisStore.cacheClassification(token, label, 1.0);

    const state = sessionStates.get(stateKey);
    if (state) {
      const extendedState = state as any;
      extendedState.latestClassification = label;
      extendedState.I_score_S = I_score_S;
      extendedState.E_score_S = E_score_S;
    }
  } catch (err: any) {
    console.error("[Evaluator] Error in evaluateTurnAndSession:", err.message);
  } finally {
    await redisStore.setEvaluationPending(token, false).catch(() => {});
  }
}
