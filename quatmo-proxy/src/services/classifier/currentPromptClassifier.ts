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

  // --- Instrumental Signals ---
  const asksExplanation =
    /\b(what is|what are|why|explain|describe|understand|concept|how does|how do|difference between|compare|meaning of|intuition behind)\b/i.test(
      text,
    ) ||
    /(?:giải thích|là gì|tại sao|nguyên lý|ý nghĩa|khác nhau thế nào|hoạt động như thế nào)/i.test(
      text,
    );

  // --- Executive Signals ---
  const asksDirectCreation =
    /\b(write|create|build|implement|generate|rewrite|complete|finish|code)\b.{0,50}\b(code|file|script|function|class|method|module|app|application|project|solution|program|algorithm|view|model|controller|component|template|page|website)\b/i.test(
      text,
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

  // Instrumental Feature Activations (i1 - i8)
  if (asksExplanation) activate(features, "i1", 0.75);

  if (
    /\b(syntax|api|library|package|method|function signature|command|how (?:do|can) i use|usage of|parameter|argument|reference guide)\b/i.test(
      text,
    ) ||
    /(?:cú pháp|cách dùng hàm|tham số|cách sử dụng)/i.test(text)
  ) {
    activate(features, "i2", 0.75);
  }

  if (
    (/\b(why (?:did|is|does)|root cause|what causes|diagnose|understand (?:the )?error|meaning of (?:this )?traceback|exception|stack trace)\b/i.test(
      text,
    ) ||
      /(?:tại sao lỗi|nguyên nhân lỗi|lỗi này nghĩa là gì)/i.test(text)) &&
    !delegatesFix
  ) {
    activate(features, "i3", 0.75);
  }

  if (
    /\b(documentation|official docs?|specification|reference guide|man page|docs for)\b/i.test(
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
    /\b(is this (?:approach|way|idea|logic)|is my (?:approach|thought|solution|understanding)|am i on the right track|am i right|validate (?:my|this)|check my logic)\b/i.test(
      text,
    ) ||
    /(?:logic này đúng không|cách này ổn không|tôi làm thế này có đúng không)/i.test(
      text,
    )
  ) {
    activate(features, "i7", 0.75);
  }

  if (
    /\b(complexity|time complexity|space complexity|big o|optimize|how to improve efficiency|refactor advice|clean code)\b/i.test(
      text,
    )
  ) {
    activate(features, "i8", 0.75);
  }

  // Executive Feature Activations (e1 - e6)
  if (
    text.length >= 200 &&
    /\b(requirements?|assignment|task|acceptance criteria|problem statement|input format|output format|sample input|sample output|test case|bài tập|đề bài|yêu cầu bài)\b/i.test(
      text,
    )
  ) {
    activate(features, "e1", 0.85);
  }

  if (asksDirectCreation) activate(features, "e2", 1.0);
  if (asksDirectAnswer) activate(features, "e3", 1.0);
  if (delegatesFix) activate(features, "e4", 1.0);

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
  const hardExecutive = ["e1", "e2", "e3", "e4", "e6"].some(
    (key) => (features[key] ?? 0) >= 0.75,
  );

  let label: IemLabel;
  if (hardExecutive) {
    label = "executive";
  } else if (instrumentalScore < 0.2 && executiveScore < 0.2) {
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
    hardExecutive,
  };
}
