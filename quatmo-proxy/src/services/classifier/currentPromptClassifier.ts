import {
  calculateSignalScore,
  calculateIemConfidence,
  deriveIemLabel,
  EXECUTIVE_WEIGHTS,
  INSTRUMENTAL_WEIGHTS,
} from "./features";

export type IemLabel = "instrumental" | "mixed" | "executive";

export interface CurrentPromptDecision {
  label: IemLabel;
  rawLabel?: string;
  confidence: number;
  instrumentalScore: number;
  executiveScore: number;
  activeFeatures: Record<string, number>;
  hardExecutive: boolean;
  isAmbiguous?: boolean;
  isShortContinuation?: boolean;
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
 * Fast deterministic preflight classifier for student prompts.
 * Designed for low-latency preflight checks before streaming AI responses.
 * Deep semantic evaluation and sliding window history are handled asynchronously
 * via evaluateTurnAndSession with the LLM evaluator.
 */
export function classifyCurrentPrompt(prompt: string): CurrentPromptDecision {
  const text = normalizeText(prompt);
  const features: Record<string, number> = {};

  const hasCodeContext =
    /attached (context )?file|```|traceback|\b(line|error) \d+\b/i.test(text);

  // Explicit delegation indicators
  const hasExplicitDelegation =
    /\b(for me|to me|give me|send me|show me|cho (?:tôi|tao|mình|em)|hộ (?:tôi|tao|mình|em)|giúp (?:tôi|tao|mình|em))\b/i.test(
      text,
    );

  // Instrumental inquiry patterns
  const asksExplanation =
    /\b(what is|what are|why|explain|describe|understand|concept|how does|how do|how can|how to|difference between|compare|meaning of|intuition behind)\b/i.test(
      text,
    ) ||
    /(?:giải thích|là gì|tại sao|nguyên lý|ý nghĩa|khác nhau thế nào|hoạt động như thế nào|làm thế nào|cách làm|cách cài đặt|hướng dẫn)/i.test(
      text,
    );

  // Executive signal patterns
  const asksDirectCreation =
    (
      /\b(write|create|build|implement|generate|rewrite|complete|finish|code)\b.{0,50}\b(code|file|script|function|class|method|module|app|application|project|solution|program|algorithm|view|model|controller|component|template|page|website)\b/i.test(
        text,
      ) &&
      (!asksExplanation || hasExplicitDelegation)
    ) ||
    /\bwrite (?:me )?(?:a |an |the )?(?:full |complete )?(?:code|script|function|program|solution|implementation|app)\b/i.test(
      text,
    ) ||
    /\b(give|provide|send) (?:me )?(?:a |the )?(?:complete |full )?(?:code|script|solution|implementation)\b/i.test(
      text,
    ) ||
    /(?:viết|code|tạo|làm|xây dựng|viết giúp|làm giúp|code giúp|viết hộ|làm hộ|code hộ|giải bài).{0,30}(?:code|hàm|function|chương trình|bài|script|dự án|project|app|web|trang web|thuật toán|giúp tôi|hộ tôi)/i.test(
      text,
    ) ||
    /(?:code cho (?:tôi|tao|mình|em)|viết cho (?:tôi|tao|mình|em)|làm bài này|giải bài này|viết code)/i.test(
      text,
    );

  const asksDirectAnswer =
    /\b(give|show|send|provide|tell) (?:me )?(?:the )?(?:exact |full |complete )?(?:code|solution|answer|result)\b/i.test(
      text,
    ) ||
    /\bwhat is the (?:solution|answer|complete code|full solution)\b/i.test(
      text,
    ) ||
    /\b(solve|do) (?:this|the) (?:problem|exercise|assignment|task|question)\b/i.test(
      text,
    ) ||
    /(?:cho (?:tôi|tao|mình|em) (?:code|đáp án|lời giải|kết quả)|đưa code|cho xin code|giải hộ)/i.test(
      text,
    );

  const delegatesFix =
    /\b(fix|repair|correct|solve|debug) (?:this|my|the|it) for me\b/i.test(
      text,
    ) ||
    /\b(make it work|fix it for me|do it for me|solve it for me)\b/i.test(
      text,
    ) ||
    /\bjust (?:fix|correct|solve) (?:it|this|my code)\b/i.test(text) ||
    /(?:sửa (?:giúp|hộ|cho)|fix (?:giúp|hộ|cho)|sửa lỗi này|làm cho nó chạy|sửa code)/i.test(
      text,
    );

  // Differentiate procedural guidance from full delegation
  const isHowToDelegation =
    /\b(how (?:can|to|do) i|show me)\b.{0,60}\b(complete|code|finish|write|implement)\b.{0,40}\b(all|full|everything|todos?|files?)\b/i.test(text) ||
    (/\b(show me|how can i)\b/i.test(text) && /\b(for me|giúp tôi|hộ em)\b/i.test(text) && /\b(code|file|function|task)\b/i.test(text));

  // Identify raw stack trace or runtime traceback dumps
  const isTraceback = /\b(traceback \(most recent call last\)|from database import|modulenotfounderror|operationalerror|sqlalchemy)\b/i.test(text);
  const asksTracebackExplanation = isTraceback && /\b(why|what causes|explain|what does this mean|tại sao|nguyên nhân|nghĩa là gì)\b/i.test(text);

  // Distinguish code reviews from code-fixing delegations
  const isReviewAndFix =
    /\b(check|review|kiểm tra|soi lỗi)\b.{0,80}\b(if wrong|nếu sai|nếu lỗi|and fix|và sửa|sửa giúp|help me fix|fix (?:it|any bugs?|help me)|sửa hộ)\b/i.test(text);
  const isPureReview =
    !isReviewAndFix &&
    (/(?:^\s*|\b)(check|review|kiểm tra|soi lỗi|is this correct|check my code|check my logic|check the function)\b/i.test(text) ||
     /\b(review|check)\b.{0,40}\b(code|function|logic|hàm)\b/i.test(text));

  // Identify short continuation prompts
  const isShortContinuation = /^(same|do the same|the same|continue|next|như cũ|làm tiếp)$/i.test(text.trim());

  // Instrumental feature activations
  if (asksExplanation && !isHowToDelegation && !asksDirectCreation) {
    activate(features, "i1", 0.75);
  }

  if (
    !asksDirectCreation &&
    !isHowToDelegation &&
    (/\b(syntax|api|library|package|method|function signature|command|how (?:do|can) i use|usage of|parameter|argument|reference guide|in python|in c\+\+|in java|in javascript|in js|in ts|in c|bằng python|trong python|bằng c|bằng java)\b/i.test(
      text,
    ) ||
    /(?:cú pháp|cách dùng hàm|tham số|cách sử dụng)/i.test(text))
  ) {
    activate(features, "i2", 0.75);
  }

  if (
    asksExplanation &&
    /\b(algorithm|data structure|binary search|bubble sort|quick sort|merge sort|sorting|recursion|tree|graph|dp|dynamic programming|thuật toán|cấu trúc dữ liệu)\b/i.test(
      text,
    )
  ) {
    activate(features, "i3", 0.85);
  }

  if (
    (/\b(why\b|root cause|what causes|diagnose|concept|meaning of|intuition behind|theory|mechanism|understand (?:the )?error|meaning of (?:this )?traceback|exception|stack trace)\b/i.test(
      text,
    ) ||
      /(?:tại sao|nguyên lý|ý nghĩa|bản chất|khái niệm|nguyên nhân lỗi|lỗi này nghĩa là gì)/i.test(text)) &&
    !delegatesFix &&
    !isHowToDelegation
  ) {
    activate(features, "i3", 0.85);
  }

  if (
    /\b(documentation|official docs?|specification|reference guide|man page|docs for|problem statement|problem understanding|đề bài|hiểu bài)\b/i.test(
      text,
    )
  ) {
    activate(features, "i4", 0.75);
  }

  if (
    hasCodeContext &&
    /\b(review|feedback|where (?:is|did)|why is (?:my|this)|what is wrong with my|analyze my)\b/i.test(
      text,
    ) &&
    !delegatesFix
  ) {
    activate(features, "i5", 0.75);
  }

  if (
    /\b(architecture|structure|design pattern|how to organize|modularity|database schema|data structure choice)\b/i.test(
      text,
    ) ||
    /(?:kiến trúc|cấu trúc thư mục|thiết kế database)/i.test(text)
  ) {
    activate(features, "i6", 0.75);
  }

  if (
    (/\b(is this (?:approach|way|idea|logic)|is my (?:approach|thought|solution|understanding)|am i on the right track|am i right|validate (?:my|this)|check my logic)\b/i.test(
      text,
    ) ||
    /\b(how (?:can|do) i test|test my|verify (?:if|that|my)|know if (?:the )?codes? works?|check if (?:it|the code) works?|cách test|làm sao để test|kiểm thử)\b/i.test(
      text,
    ) ||
    /(?:logic này đúng không|cách này ổn không|tôi làm thế này có đúng không)/i.test(
      text,
    ) || isPureReview || isReviewAndFix)
  ) {
    activate(features, "i7", 0.85);
  }

  if (
    /\b(complexity|time complexity|space complexity|big o|optimize|how to improve efficiency|refactor advice|clean code|độ phức tạp)\b/i.test(
      text,
    )
  ) {
    activate(features, "i8", 0.75);
  }

  if (
    asksExplanation &&
    /\b(implement|code|write|algorithm|function|class|cài đặt|viết code|thuật toán)\b/i.test(text) &&
    !hasExplicitDelegation &&
    !isHowToDelegation
  ) {
    activate(features, "i8", 0.75);
  }

  if (asksTracebackExplanation) {
    activate(features, "i6", 0.85);
  }

  // Executive feature activations
  if (
    text.length >= 200 &&
    /\b(requirements?|assignment|task|acceptance criteria|problem statement|input format|output format|sample input|sample output|test case|bài tập|đề bài|yêu cầu bài)\b/i.test(
      text,
    ) &&
    !asksExplanation
  ) {
    activate(features, "e1", 0.75);
  }

  if (asksDirectCreation || isHowToDelegation) {
    activate(features, "e1", 0.85);
    activate(features, "e2", 1.0);
  }

  if (asksDirectAnswer) {
    activate(features, "e1", 0.75);
    activate(features, "e3", 1.0);
  }

  if (delegatesFix || isReviewAndFix) {
    activate(features, "e5", 1.0);
  }

  if (isTraceback && !asksTracebackExplanation) {
    activate(features, "e4", 0.85);
    activate(features, "e5", 0.75);
    activate(features, "e6", 0.75);
  }

  if (
    /\b(give me |provide |generate )(?:a |the )?(?:boilerplate|scaffold|starter template|ready-made|skeleton project|config file)\b/i.test(
      text,
    )
  ) {
    activate(features, "e5", 0.75);
  }

  if (
    /\b(i am stuck|i'm stuck|cannot do|can't do|do everything|make it work|do it for me|you do it|just do it for me|write it all for me)\b/i.test(
      text,
    ) ||
    /(?:làm hết hộ|giải hết|làm từ a đến z|làm giúp từ đầu)/i.test(text)
  ) {
    activate(features, "e6", 1.0);
  }

  const instrumentalScore = scoreFeatures(features, INSTRUMENTAL_WEIGHTS);
  const executiveScore = scoreFeatures(features, EXECUTIVE_WEIGHTS);

  const rawLabel = deriveIemLabel(instrumentalScore, executiveScore);
  const label: IemLabel =
    rawLabel === "instrumental" || rawLabel === "executive"
      ? rawLabel
      : "mixed";

  const confidence = calculateIemConfidence(rawLabel, instrumentalScore, executiveScore);

  return {
    label,
    rawLabel,
    confidence,
    instrumentalScore,
    executiveScore,
    activeFeatures: features,
    hardExecutive: (rawLabel === "executive" || label === "executive") && executiveScore >= 0.50,
    isAmbiguous: rawLabel === "ambiguous",
    isShortContinuation,
  };
}
