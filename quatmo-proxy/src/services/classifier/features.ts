import {
  INSTRUMENTAL_WEIGHTS,
  EXECUTIVE_WEIGHTS,
  IEM_WINDOW_SIZE,
  IEM_HIGH_THRESHOLD,
  IEM_MID_THRESHOLD,
  IEM_MARGIN_THRESHOLD,
  IEM_DECISION_GATE,
} from "./weights";

export {
  NOMINAL_INSTRUMENTAL_WEIGHTS,
  CALIBRATED_INSTRUMENTAL_WEIGHTS,
  EMPIRICAL_DISTRIBUTION_NOISE_INSTRUMENTAL_WEIGHTS,
  WOE_INSTRUMENTAL_WEIGHTS,
  INSTRUMENTAL_WEIGHTS,
  NOMINAL_EXECUTIVE_WEIGHTS,
  CALIBRATED_EXECUTIVE_WEIGHTS,
  EMPIRICAL_DISTRIBUTION_NOISE_EXECUTIVE_WEIGHTS,
  WOE_EXECUTIVE_WEIGHTS,
  EXECUTIVE_WEIGHTS,
  IEM_DECISION_GATE,
  IEM_WINDOW_SIZE,
  IEM_HIGH_THRESHOLD,
  IEM_MID_THRESHOLD,
  IEM_MARGIN_THRESHOLD,
  IEM_DOMINANT_SEPARATION,
  FEATURE_DESCRIPTIONS,
} from "./weights";

export {
  extractCodeBlocks,
  extractCodeSnapshot,
  extractFunctionSignatures,
  normalizeCodeStructure,
  calculateProgrammaticFeatures,
  isDelegationRequest,
  isExecutionEvidence,
} from "./programmaticFeatures";

/** Online profile: 32 operational features (Prompt 14, Response 8, Trajectory 6, CodeDiff 4). */
export const ONLINE_FEATURE_KEYS = [
  "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8",
  "e1", "e2", "e3", "e4", "e5", "e6",
  "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8",
  "t1", "t3", "t4", "t5", "t7", "t10",
  "c1", "c3", "c5", "c8",
] as const;
export const FEATURE_SCHEMA = "fvs-codexgold-online-v3";

/** Reliability priors, NOT fitted accuracy estimates or pedagogical weights. */
export const PROG_TRUST: Readonly<Record<string, number>> = {
  e2: 0.70, // explicit, scoped implementation delegation only
  t4: 1.00, // observed current execution record; absent record => abstain
  t10: 1.00, // count >= 2 within current + four prior turns, using semantic e2
  c1: 0.85, // current-side LCS coverage, comparable file and bounded work
  c5: 0.00, // semantic ownership; copying is a separate evidence veto below
};
export const PROGRAMMATIC_TRUST_WEIGHTS = PROG_TRUST;

export function blendFeatures(
  semantic: Record<string, number>,
  programmatic: Record<string, number>,
  onDisagreement?: (key: string, prog: number, llm: number, blended: number) => void,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of ONLINE_FEATURE_KEYS) {
    const p = programmatic[key];
    const s = semantic[key];
    // i/e/r are semantic, except explicit lexical e2 corroboration. No generic
    // programmatic-only fallback may invent roles, intent, or algorithm novelty.
    const trust = PROG_TRUST[key] ?? 0;
    const hasP = trust > 0 && typeof p === "number" && Number.isFinite(p);
    const hasS = typeof s === "number" && Number.isFinite(s);
    if (!hasP && !hasS) continue; // missing evidence is not a negative vote
    const pNorm = hasP && p > 0 ? 1 : 0;
    const sNorm = hasS && s > 0 ? 1 : 0;
    const activation = hasP && hasS
      ? trust * pNorm + (1 - trust) * sNorm
      : hasP ? pNorm : sNorm;
    const weight = INSTRUMENTAL_WEIGHTS[key] ?? EXECUTIVE_WEIGHTS[key];
    result[key] = activation > 0.5 ? weight : 0; // a tie is insufficient
    if (hasP && hasS && pNorm !== sNorm) onDisagreement?.(key, pNorm, sNorm, result[key]);
  }
  // A complete task solution performs the student's work, including chat delivery.
  if (result.r8 > 0) {
    result.r7 = EXECUTIVE_WEIGHTS.r7;
    // Preserve evidenced review (r5); surrounding pedagogy is subsumed.
    for (const key of ["r1", "r2", "r3", "r4", "r6"]) result[key] = 0;
  }
  // Internal evidence is never an output feature. Copying alone cannot be novelty.
  if (programmatic._exactCopyOnly === 1) result.c5 = 0;
  return result;
}

/** min(1, v1 + 0.35*v2 + 0.15*sum(v3...)), sorted descending. */
export function calculateSignalScore(values: number[]): number {
  if (values.length === 0) return 0.0;
  const sorted = [...values].sort((a, b) => b - a);
  let rest = 0.0;
  for (let j = 2; j < sorted.length; j++) rest += sorted[j];
  return Math.min(1.0, sorted[0] + 0.35 * (sorted[1] ?? 0.0) + 0.15 * rest);
}

/** Unclamped raw score for Session compounding to prevent ceiling saturation artifact. */
export function calculateRawSignalScore(values: number[]): number {
  if (values.length === 0) return 0.0;
  const sorted = [...values].sort((a, b) => b - a);
  let rest = 0.0;
  for (let j = 2; j < sorted.length; j++) rest += sorted[j];
  return sorted[0] + 0.35 * (sorted[1] ?? 0.0) + 0.15 * rest;
}

/** Apply the identical SignalScore to the latest five Turn positions. */
export function calculateSessionSignalScore(scores: number[]): number {
  const window = scores.slice(-IEM_WINDOW_SIZE).filter(Number.isFinite);
  return calculateSignalScore(window.map((s) => Math.max(0, Math.min(1, s))));
}

/** Calculate unclamped raw Session compounding score across W=5 turns. */
export function calculateRawSessionSignalScore(scores: number[]): number {
  const window = scores.slice(-IEM_WINDOW_SIZE).filter(Number.isFinite);
  return calculateRawSignalScore(window.map((s) => Math.max(0, s)));
}

/** Train-calibrated overlap, dominance gaps, then Mixed for ambiguity.
 * All thresholds are inclusive, with tolerance only for floating point equality.
 */
export function deriveSignalScoreOverlap(
  si: number,
  se: number,
): "Instrumental" | "Executive" | "Mixed" {
  if (!Number.isFinite(si) || !Number.isFinite(se)) return "Mixed";
  if (si === 0 && se === 0) return "Mixed";
  const p = IEM_DECISION_GATE;
  const tolerance = 1e-12;
  if (si - se >= p.M_I - tolerance) return "Instrumental";
  if (se - si >= p.M_E - tolerance) return "Executive";
  return "Mixed";
}

/** Compatibility entry point; uses the same calibrated mathematical gate. */
export function deriveSignalScore2D(
  si: number,
  se: number,
): "Instrumental" | "Executive" | "Mixed" {
  return deriveSignalScoreOverlap(si, se);
}

/** Shared Turn label rule. */
export function deriveIemLabel(
  instrumentalScore: number,
  executiveScore: number,
): "instrumental" | "executive" | "mixed" {
  return deriveSignalScoreOverlap(instrumentalScore, executiveScore).toLowerCase() as
    "instrumental" | "executive" | "mixed";
}

/** Session-specific decision gate based on Raw Compounding Margin. */
export function deriveSessionIemLabel(
  rawSi: number,
  rawSe: number,
): "instrumental" | "executive" | "mixed" {
  return deriveSignalScoreOverlap(rawSi, rawSe).toLowerCase() as
    "instrumental" | "executive" | "mixed";
}

export function calculateIemConfidence(
  label: "instrumental" | "executive" | "mixed" | string,
  instrumentalScore: number,
  executiveScore: number,
): number {
  const strongest = Math.max(instrumentalScore, executiveScore);
  const weakest = Math.min(instrumentalScore, executiveScore);
  const separation = Math.abs(instrumentalScore - executiveScore);
  if (label === "ambiguous") {
    return Math.max(0, Math.min(1, 1 - strongest / IEM_MID_THRESHOLD));
  }
  if (label === "mixed") {
    return Math.min(1, weakest / IEM_MID_THRESHOLD);
  }
  const evidence = Math.min(1, strongest / IEM_HIGH_THRESHOLD);
  const dominance = Math.min(1, separation / IEM_MARGIN_THRESHOLD);
  return Math.min(1, evidence * 0.55 + dominance * 0.45);
}
