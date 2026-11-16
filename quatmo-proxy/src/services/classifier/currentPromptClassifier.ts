import {
  calculateSignalScore,
  calculateIemConfidence,
  deriveIemLabel,
  EXECUTIVE_WEIGHTS,
  INSTRUMENTAL_WEIGHTS,
  isDelegationRequest,
} from "./features";

export type IemLabel = "instrumental" | "mixed" | "executive";

export interface CurrentPromptDecision {
  label: IemLabel;
  confidence: number;
  instrumentalScore: number;
  executiveScore: number;
  activeFeatures: Record<string, number>;
  hardExecutive: boolean;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function activate(
  features: Record<string, number>,
  key: string,
  weightMap: Record<string, number>,
): void {
  const w = weightMap[key];
  if (typeof w === "number" && w > 0) {
    features[key] = w;
  }
}

function scoreFeatures(
  features: Record<string, number>,
  weights: Record<string, number>,
): number {
  return calculateSignalScore(
    Object.entries(weights)
      .filter(([key]) => (key.startsWith("i") || key.startsWith("e")) && (features[key] ?? 0) > 0)
      .map(([, weight]) => weight),
  );
}

/**
 * Fast deterministic preflight/fallback classifier aligned with IEM v3 feature IDs.
 * Deep semantic evaluation and sliding window history are handled asynchronously
 * via evaluateTurnAndSession with the LLM evaluator.
 */
export function classifyCurrentPrompt(prompt: string): CurrentPromptDecision {
  const text = normalizeText(prompt);
  const features: Record<string, number> = {};

  const hasCodeContext =
    /attached (context )?file|```|traceback|\b(line|error) \d+\b/i.test(text);

  const hasExplicitDelegation =
    isDelegationRequest(prompt) ||
    /\b(for me|to me|do it all)\b/i.test(text) ||
    /(?:viết giúp|làm giúp|code giúp|viết hộ|làm hộ|code hộ|giải hộ|giải giúp)/i.test(
      text,
    );

  // --- Instrumental Signals ---
  const asksExplanation =
    /\b(what is|what are|why|explain|describe|understand|concept|how does|how do|how can|how to|difference between|compare|meaning of|intuition behind|hint|guide)\b/i.test(
      text,
    ) ||
    /(?:giải thích|là gì|tại sao|nguyên lý|ý nghĩa|khác nhau thế nào|hoạt động như thế nào|làm thế nào|cách làm|cách cài đặt|hướng dẫn|gợi ý)/i.test(
      text,
    );

  const asksConceptualTopic =
    /\b(algorithm|data structure|binary search|bubble sort|quick sort|merge sort|sorting|recursion|tree|graph|dp|dynamic programming|complexity|time complexity|space complexity|big o|theory|mechanism)\b/i.test(
      text,
    ) ||
    /(?:thuật toán|cấu trúc dữ liệu|độ phức tạp|nguyên lý|bản chất|khái niệm)/i.test(
      text,
    );

  const asksProblemUnderstanding =
    /\b(documentation|official docs?|specification|reference guide|requirement|requirements|problem statement|problem scope|constraint|clarify)\b/i.test(
      text,
    ) || /(?:đề bài|hiểu bài|yêu cầu bài)/i.test(text);

  const asksExample =
    /\b(example|minimal demo|sample|illustrate|illustration)\b/i.test(text) ||
    /(?:ví dụ|minh họa)/i.test(text);

  const asksErrorInterpretation =
    /\b(why\b.*error|root cause|what causes|diagnose|understand (?:the )?error|meaning of (?:this )?traceback|why is (?:my|this) (?:code )?(?:fail|error|wrong|broken)|what is wrong)\b/i.test(
      text,
    ) ||
    /(?:nguyên nhân lỗi|lỗi này nghĩa là gì|tại sao.*lỗi)/i.test(text);

  const asksVerification =
    /\b(is this (?:approach|way|idea|logic)|is my (?:approach|thought|solution|understanding|code)|am i on the right track|am i right|validate (?:my|this)|check my (?:code|logic|solution)|review my|feedback|scan my code|point out any issues)\b/i.test(
      text,
    ) ||
    /(?:kiểm tra giúp|xem giúp|logic này đúng không|cách này ổn không|tôi làm thế này có đúng không)/i.test(
      text,
    );

  const asksSyntaxOrHint =
    /\b(hint|guide me|how to approach|where is\b|how do i write|how (?:do|can) i use|syntax|api|library|package|function signature|parameter|argument)\b/i.test(
      text,
    ) || /(?:gợi ý|cú pháp|cách dùng hàm|tham số|cách sử dụng)/i.test(text);

  // --- Executive Signals ---
  const delegatesFix =
    /\b(fix|repair|correct|solve|debug) (?:this|my|the|it) for me\b/i.test(
      text,
    ) ||
    /\b(make it work|fix it for me|do it for me|solve it for me|rewrite (?:it|both|my code))\b/i.test(
      text,
    ) ||
    /\bjust (?:fix|correct|solve) (?:it|this|my code)\b/i.test(text) ||
    /(?:sửa (?:giúp|hộ|cho)|fix (?:giúp|hộ|cho)|sửa lỗi này|làm cho nó chạy)/i.test(
      text,
    );

  const asksDirectCreation =
    ((
      /\b(write|create|build|implement|generate|rewrite|complete|finish|code)\b.{0,50}\b(code|file|script|function|class|method|module|app|application|project|solution|program|algorithm|view|model|controller|component|template|page|website|route)\b/i.test(
        text,
      ) &&
      (!asksExplanation || hasExplicitDelegation) &&
      !/\bhint\b/i.test(text)
    ) ||
      /\bwrite (?:me )?(?:a |an |the )?(?:full |complete )?(?:code|script|function|program|solution|implementation|app)\b/i.test(
        text,
      ) ||
      /(?:viết|code|tạo|làm|xây dựng|giải bài).{0,30}(?:code|hàm|function|chương trình|bài|script|dự án|project|app|web|trang web|thuật toán|giúp tôi|hộ tôi)/i.test(
        text,
      ) ||
      /(?:code cho (?:tôi|tao|mình|em)|viết cho (?:tôi|tao|mình|em)|làm bài này|giải bài này|viết code)/i.test(
        text,
      ));

  const asksDirectAnswer =
    /\b(give|show|send|provide|tell) (?:me )?(?:the )?(?:exact |full |complete )?(?:solution|answer)\b/i.test(
      text,
    ) ||
    /\bwhat is the (?:solution|answer|complete code|full solution)\b/i.test(
      text,
    ) ||
    /\b(solve|do) (?:this|the) (?:problem|exercise|assignment|task|question)\b/i.test(
      text,
    ) ||
    /(?:cho (?:tôi|tao|mình|em) (?:đáp án|lời giải)|cho xin full code bài|giải hộ bài)/i.test(
      text,
    );

  // --- Map Instrumental Prompt Features (i1 - i8) cleanly ---
  if (
    asksExplanation &&
    !hasCodeContext &&
    !asksConceptualTopic &&
    !asksProblemUnderstanding &&
    !asksVerification
  ) {
    activate(features, "i1", INSTRUMENTAL_WEIGHTS);
  }
  if (
    hasCodeContext &&
    (asksExplanation || asksErrorInterpretation || asksVerification || asksSyntaxOrHint) &&
    !delegatesFix &&
    !asksDirectCreation
  ) {
    activate(features, "i2", INSTRUMENTAL_WEIGHTS);
  }
  if (asksExplanation && asksConceptualTopic) {
    activate(features, "i3", INSTRUMENTAL_WEIGHTS);
  }
  if (asksProblemUnderstanding) {
    activate(features, "i4", INSTRUMENTAL_WEIGHTS);
  }
  if (asksExample && !asksDirectCreation && !hasExplicitDelegation) {
    activate(features, "i5", INSTRUMENTAL_WEIGHTS);
  }
  if (asksErrorInterpretation && !delegatesFix) {
    activate(features, "i6", INSTRUMENTAL_WEIGHTS);
  }
  if (asksVerification) {
    activate(features, "i7", INSTRUMENTAL_WEIGHTS);
  }
  if (
    asksSyntaxOrHint &&
    !hasExplicitDelegation &&
    !delegatesFix &&
    (!asksDirectCreation || /\b(hint|how can|how to|how do i|cách cài đặt|hướng dẫn|gợi ý)\b/i.test(text))
  ) {
    activate(features, "i8", INSTRUMENTAL_WEIGHTS);
  }

  // --- Map Executive Prompt Features (e1 - e6) cleanly ---
  if (asksDirectCreation && !asksVerification) {
    activate(features, "e1", EXECUTIVE_WEIGHTS);
  }
  if (
    hasExplicitDelegation ||
    asksDirectAnswer ||
    /\b(i am stuck|i'm stuck|cannot do|can't do|do everything|do it for me|you do it|just do it for me|write it all for me)\b/i.test(
      text,
    ) ||
    /(?:làm hết hộ|giải hết|làm từ a đến z|làm giúp từ đầu)/i.test(text)
  ) {
    activate(features, "e2", EXECUTIVE_WEIGHTS);
  }
  if (
    text.length >= 200 &&
    /\b(requirements?|assignment|task|acceptance criteria|problem statement|input format|output format|sample input|sample output|test case|bài tập|đề bài|yêu cầu bài)\b/i.test(
      text,
    ) &&
    !asksExplanation &&
    !asksProblemUnderstanding
  ) {
    activate(features, "e3", EXECUTIVE_WEIGHTS);
  }
  if (delegatesFix && !asksVerification) {
    activate(features, "e5", EXECUTIVE_WEIGHTS);
  }
  if (
    /(?:traceback|assertionerror|syntaxerror|typeerror|nameerror|valueerror|returncode|exit code)/i.test(
      text,
    ) &&
    !asksExplanation &&
    !asksErrorInterpretation &&
    !asksVerification &&
    !delegatesFix
  ) {
    activate(features, "e6", EXECUTIVE_WEIGHTS);
  }

  const instrumentalScore = scoreFeatures(features, INSTRUMENTAL_WEIGHTS);
  const executiveScore = scoreFeatures(features, EXECUTIVE_WEIGHTS);

  const label: IemLabel = deriveIemLabel(instrumentalScore, executiveScore);
  const confidence = calculateIemConfidence(
    label,
    instrumentalScore,
    executiveScore,
  );

  return {
    label,
    confidence,
    instrumentalScore,
    executiveScore,
    activeFeatures: features,
    hardExecutive: label === "executive" && executiveScore >= 0.75,
  };
}
