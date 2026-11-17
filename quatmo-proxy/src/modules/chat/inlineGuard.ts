

export function isInlineCompletionRequest(body: any, c: any): boolean {
  const modeHeader = (
    c.req.header("x-quatmo-mode") ||
    c.req.header("X-Quatmo-Mode") ||
    ""
  ).toLowerCase();
  if (modeHeader === "completion" || modeHeader === "inline") return true;

  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      const content =
        typeof m?.content === "string"
          ? m.content
          : JSON.stringify(m?.content || "");
      if (
        content.includes("Text before cursor:") ||
        content.includes("Text after cursor:") ||
        content.includes("You complete code. Return ONLY the completion") ||
        content.startsWith("Complete:\n")
      ) {
        return true;
      }
    }
  }

  if (typeof body?.prompt === "string") {
    if (
      body.prompt.includes("Text before cursor:") ||
      body.prompt.includes("Text after cursor:") ||
      body.prompt.includes("You complete code. Return ONLY the completion") ||
      body.prompt.startsWith("Complete:\n")
    ) {
      return true;
    }
  }

  return false;
}
