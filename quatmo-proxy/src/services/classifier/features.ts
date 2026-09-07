import { fastLineLCS } from "./algorithms";
import type { ClientContext, TurnLog } from "./redisStore";

// Define feature lists and their weights
export const INSTRUMENTAL_WEIGHTS: Record<string, number> = {
  // Prompt features (i1 - i8)
  i1: 0.60, // asks conceptual explanation
  i2: 0.65, // asks API/syntax usage details
  i3: 0.70, // asks debugging hint or error root cause
  i4: 0.50, // asks documentation reference
  i5: 0.75, // provides own code and asks for diagnostics
  i6: 0.60, // requests structural architectural advice
  i7: 0.55, // asks validation of a solution step
  i8: 0.70, // explicitly requests code review comments

  // Response features (r1 - r6)
  r1: 0.65, // conceptual explanation without full code solution
  r2: 0.60, // narrow syntax reference snippet
  r3: 0.70, // diagnostic explanation or hint
  r4: 0.55, // documentation reference
  r5: 0.75, // code review feedback (no replacement code)
  r6: 0.50, // step-by-step logic pseudocode

  // Trajectory features (t1 - t5)
  t1: 0.70, // sustained_inquiry_pattern
  t2: 0.80, // self_correction_after_hint
  t3: 0.65, // increasing_specificity_own_reasoning
  t4: 0.70, // verification_loop
  t5: 0.85, // rejection_of_full_solution_offer

  // Code-diff features (c1 - c5)
  c1: 0.85, // high_student_modification_ratio
  c2: 0.75, // incremental_small_step_changes
  c3: 0.70, // structural_divergence_from_ai_suggestion
  c4: 0.80, // test_driven_iteration
  c5: 0.75, // own_algorithm_signature
};

export const EXECUTIVE_WEIGHTS: Record<string, number> = {
  // Prompt features (e1 - e6)
  e1: 0.80, // copy-pastes assignment text demanding solution
  e2: 0.85, // asks AI to write whole file or rewrite it completely
  e3: 0.75, // demands replacement code without explanation
  e4: 0.70, // asks AI to fix errors directly on their behalf
  e5: 0.65, // asks for boilerplate setup script
  e6: 0.60, // expresses helplessness ("make it work", "do it for me")

  // Response features (r7 - r8)
  r7: 0.85, // provides complete copy-pasteable full script/file
  r8: 0.80, // provides direct patch edits rewriting massive chunks

  // Trajectory features (t6 - t10)
  t6: 0.85, // repeated_copy_paste_pattern
  t7: 0.80, // escalation_to_full_solution
  t8: 0.60, // abandon_after_code_received
  t9: 0.55, // minimal_effort_between_turns
  t10: 0.75, // recurring_delegate_across_session

  // Code-diff features (c6 - c10)
  c6: 0.90, // exact_copy_ratio
  c7: 0.90, // single_large_jump
  c8: 0.85, // structural_identity_with_ai_output
  c9: 0.80, // no_intermediate_edits
  c10: 0.65, // zero_own_test_activity
};

export const IEM_WINDOW_SIZE = 5;

export const IEM_HIGH_THRESHOLD = 0.55;
export const IEM_MID_THRESHOLD = 0.45;
export const IEM_MARGIN_THRESHOLD = 0.15;

/**
 * Calculates the SignalScore for a list of weighted activation values.
 * Formula: min(1, v_1 + 0.35 * v_2 + 0.15 * sum(v_j for j >= 3))
 * where values are sorted descending.
 */
export function calculateSignalScore(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const v1 = sorted[0];
  const v2 = sorted[1] || 0;
  let sumRest = 0;
  for (let i = 2; i < sorted.length; i++) {
    sumRest += sorted[i];
  }
  return Math.min(1.0, v1 + 0.35 * v2 + 0.15 * sumRest);
}

export function calculateSessionSignalScore(scores: number[]): number {
  const validScores = scores
    .filter((score) => Number.isFinite(score))
    .slice(-IEM_WINDOW_SIZE);
  if (validScores.length === 0) return 0;

  return calculateSignalScore(
    validScores.map((score) => Math.max(0, Math.min(1, score))),
  );
}

export function deriveIemLabel(
  instrumentalScore: number,
  executiveScore: number,
): "instrumental" | "executive" | "mixed" | "ambiguous" {
  const delta = instrumentalScore - executiveScore;

  if (
    instrumentalScore >= IEM_HIGH_THRESHOLD &&
    executiveScore < IEM_MID_THRESHOLD &&
    delta >= IEM_MARGIN_THRESHOLD
  ) {
    return "instrumental";
  }

  if (
    executiveScore >= IEM_HIGH_THRESHOLD &&
    instrumentalScore < IEM_MID_THRESHOLD &&
    -delta >= IEM_MARGIN_THRESHOLD
  ) {
    return "executive";
  }

  if (
    instrumentalScore >= IEM_MID_THRESHOLD &&
    executiveScore >= IEM_MID_THRESHOLD
  ) {
    return "mixed";
  }

  return "ambiguous";
}

export function calculateIemConfidence(
  label: "instrumental" | "executive" | "mixed" | "ambiguous",
  instrumentalScore: number,
  executiveScore: number,
): number {
  const strongestSignal = Math.max(instrumentalScore, executiveScore);
  const weakestSignal = Math.min(instrumentalScore, executiveScore);
  const separation = Math.abs(instrumentalScore - executiveScore);

  if (label === "ambiguous") {
    return Math.max(
      0,
      Math.min(1, 1 - strongestSignal / IEM_MID_THRESHOLD),
    );
  }

  if (label === "mixed") {
    return Math.min(1, weakestSignal / IEM_MID_THRESHOLD);
  }

  const evidence = Math.min(1, strongestSignal / IEM_HIGH_THRESHOLD);
  const dominance = Math.min(1, separation / IEM_MARGIN_THRESHOLD);
  return Math.min(1, evidence * 0.55 + dominance * 0.45);
}

/**
 * Helper to extract code snippets wrapped in markdown backticks
 */
export function extractCodeBlocks(text: string): string {
  const regex = /```(?:[a-zA-Z0-9+#-]+)?\r?\n([\s\S]*?)```/g;
  let match;
  const blocks: string[] = [];
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  if (blocks.length === 0) {
    // If no backticks, check if there is raw code-like content
    return "";
  }
  return blocks.join("\n");
}

/**
 * Computes the programmatic features for a given turn.
 * Outputs activation levels in [0.00, 0.25, 0.50, 0.75, 1.00].
 */
export function calculateProgrammaticFeatures(
  prompt: string,
  response: string,
  clientContext: ClientContext | null,
  lastTurn: TurnLog | null,
  timeDeltaSeconds: number,
  recentTurns: TurnLog[] = [],
): Record<string, number> {
  const features: Record<string, number> = {};

  // --- Trajectory Features ---

  // t9: minimal_effort_between_turns (0.55 weight)
  // If timeDelta is very short (< 15 seconds) and there was code suggested in the last turn
  let t9Activation = 0;
  if (timeDeltaSeconds > 0 && timeDeltaSeconds < 15) {
    const hasAiCode = lastTurn && extractCodeBlocks(lastTurn.response).trim().length > 0;
    if (hasAiCode) {
      t9Activation = timeDeltaSeconds < 8 ? 1.0 : 0.5; // Strong if <8s, Partial if <15s
    }
  }
  features["t9"] = t9Activation;

  // t10: recurring_delegate_across_session (0.75 weight)
  // Scanning prompt for delegative keywords
  const delegateKeywords = [
    /\blàm hộ\b/i,
    /\bviết giúp\b/i,
    /\bsửa hộ\b/i,
    /\bcode hộ\b/i,
    /\bviết hộ\b/i,
    /\blàm giúp\b/i,
    /\bsửa giúp\b/i,
    /\bcode giúp\b/i,
    /\bviết hộ code\b/i,
    /\bsửa hộ code\b/i,
  ];
  delegateKeywords.push(
    /\bwrite (?:it|this|the code) for me\b/i,
    /\bdo (?:it|this|the assignment) for me\b/i,
    /\bfix (?:it|this|the code) for me\b/i,
  );
  const windowPrompts = [
    ...recentTurns.slice(-(IEM_WINDOW_SIZE - 1)).map((turn) => turn.prompt),
    prompt,
  ];
  const delegatedTurnCount = windowPrompts.filter((turnPrompt) =>
    delegateKeywords.some((pattern) => pattern.test(turnPrompt)),
  ).length;
  const t10Activation =
    delegatedTurnCount >= 3 ? 1.0 : delegatedTurnCount === 2 ? 0.75 : 0;
  features["t10"] = t10Activation;

  // --- Code-diff Features ---

  // c6: exact_copy_ratio (0.90 weight)
  // Compare AI response code blocks of last turn vs student's current code snapshot
  let c6Activation = 0;
  if (lastTurn && clientContext?.activeFile?.content) {
    const lastAiCode = extractCodeBlocks(lastTurn.response);
    if (lastAiCode.trim().length > 0) {
      const copyRatio = fastLineLCS(lastAiCode, clientContext.activeFile.content);
      if (copyRatio >= 0.85) c6Activation = 1.0; // Strong
      else if (copyRatio >= 0.50) c6Activation = 0.5; // Partial
      else if (copyRatio >= 0.20) c6Activation = 0.25; // Weak
    }
  }
  features["c6"] = c6Activation;

  // c7: single_large_jump (0.90 weight)
  // Checks if the student's active file code went from almost empty/very small to a massive block
  let c7Activation = 0;
  if (clientContext?.activeFile?.content) {
    const studentCode = clientContext.activeFile.content;
    const studentLines = studentCode.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const lastCode = lastTurn?.codeSnapshot || "";
    const lastLines = lastCode.split(/\r?\n/).filter((l) => l.trim().length > 0);

    const linesAdded = studentLines.length - lastLines.length;
    // If lines added is huge in 1 turn (e.g. > 40 lines added)
    if (linesAdded > 40 && lastLines.length < 15) {
      c7Activation = linesAdded > 80 ? 1.0 : 0.75; // Strong or Clear
    }
  }
  features["c7"] = c7Activation;

  return features;
}
