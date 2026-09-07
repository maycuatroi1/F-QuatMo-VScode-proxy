import type { IemLabel } from "./currentPromptClassifier";

export interface IemPolicyViolation {
  code: "IEM_CODE_LIMIT" | "IEM_PATCH_BLOCKED" | "IEM_TOOL_BLOCKED";
  message: string;
}

const CODE_LINE_LIMITS: Record<IemLabel, number> = {
  instrumental: 10,
  mixed: 5,
  executive: 0,
};

const CODE_LINE_PATTERN =
  /^\s*(?:from\s+\S+\s+import|import\s+\S+|def\s+\w+|class\s+\w+|if\s+.+:|for\s+.+:|while\s+.+:|return\b|[A-Za-z_]\w*\s*=|[A-Za-z_]\w*\([^)]*\))/;

export class IemStreamPolicyGuard {
  private readonly limit: number;
  private pendingLine = "";
  private scanTail = "";
  private insideFence = false;
  private codeLines = 0;

  constructor(private readonly label: IemLabel) {
    this.limit = CODE_LINE_LIMITS[label];
  }

  push(text: string): IemPolicyViolation | null {
    const scanText = this.scanTail + text;
    this.scanTail = scanText.slice(-128);

    if (/\*\*\* Begin Patch|diff --git|<function=/i.test(scanText)) {
      return {
        code: "IEM_PATCH_BLOCKED",
        message: "The response was stopped because it attempted a patch or direct tool action outside the selected tutoring policy.",
      };
    }

    const lines = (this.pendingLine + text).split(/\r?\n/);
    this.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      const violation = this.processLine(line);
      if (violation) return violation;
    }

    const pendingLooksLikeCode =
      this.pendingLine.trim().length > 0 &&
      (this.insideFence || CODE_LINE_PATTERN.test(this.pendingLine));
    if (this.codeLines + (pendingLooksLikeCode ? 1 : 0) > this.limit) {
      return this.codeLimitViolation();
    }

    return null;
  }

  private processLine(line: string): IemPolicyViolation | null {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      this.insideFence = !this.insideFence;
      if (this.label === "executive") return this.codeLimitViolation();
      return null;
    }

    if (
      trimmed.length > 0 &&
      (this.insideFence || CODE_LINE_PATTERN.test(line))
    ) {
      this.codeLines++;
      if (this.codeLines > this.limit) return this.codeLimitViolation();
    }

    return null;
  }

  private codeLimitViolation(): IemPolicyViolation {
    return {
      code: "IEM_CODE_LIMIT",
      message:
        this.label === "executive"
          ? "The response was stopped because Executive Mode does not permit code or a ready-made solution."
          : `The response was stopped because ${this.label} mode permits at most ${this.limit} illustrative code lines.`,
    };
  }
}

export function validateIemResponse(
  label: IemLabel,
  response: string,
): IemPolicyViolation | null {
  const guard = new IemStreamPolicyGuard(label);
  return guard.push(response + "\n");
}

export function toolCallViolation(): IemPolicyViolation {
  return {
    code: "IEM_TOOL_BLOCKED",
    message: "The response was stopped because tutor mode is textual and does not permit tool or file-system actions.",
  };
}

export function getIemPolicyFallback(label: IemLabel): string {
  if (label === "executive") {
    return "I cannot write, patch, or apply the solution for you. I can break the task into smaller concepts and help you attempt the first step; please show what you have tried so far.";
  }
  return "I stopped that response because it exceeded the code scope for this tutoring mode. I can continue with a smaller illustrative fragment and explain the reasoning step by step.";
}
