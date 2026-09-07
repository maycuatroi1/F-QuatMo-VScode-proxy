import {
  calculateSignalScore,
  EXECUTIVE_WEIGHTS,
  INSTRUMENTAL_WEIGHTS,
} from "./features";

export type IemLabel = "instrumental" | "mixed" | "executive";

export interface CurrentPromptDecision {
  label: IemLabel;
  confidence: number;
  instrumentalScore: number;
  executiveScore: number;
  activeFeatures: Record<string, number>;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0111/g, "d")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function activate(
  features: Record<string, number>,
  key: string,
  level: number,
): void {
  features[key] = Math.max(features[key] ?? 0, level);
}

function scoreFeatures(
  features: Record<string, number>,
  weights: Record<string, number>,
): number {
  return calculateSignalScore(
    Object.entries(weights)
      .filter(([key]) => key.startsWith("i") || key.startsWith("e"))
      .map(([key, weight]) => (features[key] ?? 0) * weight),
  );
}

/**
 * Classifies the current request before generation. This intentionally uses
 * only local evidence so selecting a tutor policy adds no model round-trip.
 */
export function classifyCurrentPrompt(prompt: string): CurrentPromptDecision {
  const text = normalizeText(prompt);
  const features: Record<string, number> = {};

  const hasCodeContext =
    /attached (context )?file|```|traceback|\b(line|error) \d+\b/.test(text);
  const asksExplanation =
    /\b(what is|what are|why|explain|describe|understand|concept|how does|difference between|compare)\b/.test(
      text,
    ) || /\b(giai thich|tai sao|la gi|khai niem|so sanh)\b/.test(text);
  const asksDirectCreation =
    /\b(write|create|build|implement|generate|rewrite|complete|finish)\b.{0,50}\b(code|file|script|function|class|module|app|application|project|solution|program)\b/.test(
      text,
    ) ||
    /\b(viet|tao|lam|xay dung|trien khai|hoan thanh)\b.{0,50}\b(code|file|script|ham|class|module|app|du an|bai)\b/.test(
      text,
    ) ||
    /\bwrite (me )?(a|an|the)\b/.test(text);
  const asksDirectAnswer =
    /\b(give|show|send|provide) (me )?(the )?(code|solution|answer|full|complete)\b/.test(
      text,
    ) || /\b(dua|gui|cho) (toi|minh)? ?(code|dap an|loi giai)\b/.test(text);
  const delegatesFix =
    /\b(fix|repair|correct|solve|debug) (this|my|the|it|for me)\b/.test(text) ||
    /\b(make it work|fix it for me|do it for me)\b/.test(text) ||
    /\b(sua|fix|debug) (ho|giup|cho toi|cho minh)\b/.test(text);

  if (asksExplanation) activate(features, "i1", 0.75);
  if (/\b(syntax|api|library|command|how (do|can) i use|usage|reference)\b/.test(text)) {
    activate(features, "i2", 0.75);
  }
  if (
    /\b(why|root cause|diagnose|debug|traceback|exception|error)\b/.test(text) &&
    !delegatesFix
  ) {
    activate(features, "i3", 0.75);
  }
  if (/\b(documentation|official docs?|specification|reference guide)\b/.test(text)) {
    activate(features, "i4", 0.75);
  }
  if (
    hasCodeContext &&
    /\b(review|feedback|diagnose|where|why|what is wrong)\b/.test(text) &&
    !delegatesFix
  ) {
    activate(features, "i5", 0.75);
  }
  if (/\b(architecture|structure|design|organize|module|database schema)\b/.test(text)) {
    activate(features, "i6", 0.75);
  }
  if (/\b(is this|is my|am i|validate|check my|approach correct|idea correct)\b/.test(text)) {
    activate(features, "i7", 0.75);
  }
  if (/\b(code review|review my|critique|complexity|refactor advice)\b/.test(text)) {
    activate(features, "i8", 0.75);
  }

  if (
    text.length >= 500 &&
    /\b(requirements?|assignment|task|acceptance criteria|problem statement)\b/.test(text)
  ) {
    activate(features, "e1", 0.75);
  }
  if (asksDirectCreation) activate(features, "e2", 1);
  if (asksDirectAnswer) activate(features, "e3", 1);
  if (delegatesFix) activate(features, "e4", 1);
  if (/\b(boilerplate|scaffold|starter template|setup script|ready-made|config file)\b/.test(text)) {
    activate(features, "e5", 0.75);
  }
  if (
    /\b(i am stuck|i'm stuck|cannot do|can't do|do everything|make it work|do it for me)\b/.test(
      text,
    ) || /\b(khong biet lam|lam ho|lam giup|lam het)\b/.test(text)
  ) {
    activate(features, "e6", 1);
  }

  const instrumentalScore = scoreFeatures(features, INSTRUMENTAL_WEIGHTS);
  const executiveScore = scoreFeatures(features, EXECUTIVE_WEIGHTS);
  const hardExecutive = ["e2", "e3", "e4", "e6"].some(
    (key) => (features[key] ?? 0) >= 0.75,
  );

  let label: IemLabel;
  if (hardExecutive) {
    label = "executive";
  } else if (
    instrumentalScore < 0.2 &&
    executiveScore < 0.2
  ) {
    label = "mixed";
  } else if (Math.abs(instrumentalScore - executiveScore) < 0.12) {
    label = "mixed";
  } else {
    label = instrumentalScore > executiveScore ? "instrumental" : "executive";
  }

  const strongest = Math.max(instrumentalScore, executiveScore);
  const separation = Math.abs(instrumentalScore - executiveScore);
  const confidence =
    label === "mixed"
      ? Math.max(0.35, Math.min(1, 1 - separation / 0.25))
      : Math.min(1, strongest * 0.6 + Math.min(1, separation / 0.4) * 0.4);

  return {
    label,
    confidence,
    instrumentalScore,
    executiveScore,
    activeFeatures: features,
  };
}
