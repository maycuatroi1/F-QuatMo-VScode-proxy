

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, string>;
}

export function parseXmlToolCall(xml: string): ParsedToolCall | null {
  const funcMatch = xml.match(/<function=([^>]+)>/);
  if (!funcMatch) return null;
  const name = funcMatch[1].trim();

  const args: Record<string, string> = {};
  const paramStartRegex = /<parameter=([^>]+)>/g;
  let match;
  const paramRanges: {
    name: string;
    startIdx: number;
    contentStartIdx: number;
  }[] = [];

  while ((match = paramStartRegex.exec(xml)) !== null) {
    paramRanges.push({
      name: match[1].trim(),
      startIdx: match.index,
      contentStartIdx: match.index + match[0].length,
    });
  }

  for (let i = 0; i < paramRanges.length; i++) {
    const current = paramRanges[i];
    const nextStart =
      i + 1 < paramRanges.length
        ? paramRanges[i + 1].startIdx
        : xml.indexOf("</function>");

    let paramContent = xml.substring(
      current.contentStartIdx,
      nextStart !== -1 ? nextStart : xml.length,
    );
    const closeTagIdx = paramContent.lastIndexOf("</parameter>");
    if (closeTagIdx !== -1) {
      paramContent = paramContent.substring(0, closeTagIdx);
    }
    args[current.name] = paramContent.trim();
  }

  return { name, arguments: args };
}

export class XmlToolCallConverter {
  private buffer = "";
  private inToolCall = false;

  public processChunk(text: string): any[] {
    const cleanText = text.replace(/<\/tool_call>/g, "");
    this.buffer += cleanText;
    const outputs: any[] = [];
    const targetTag = "<function=";

    while (this.buffer.length > 0) {
      if (!this.inToolCall) {
        const funcIdx = this.buffer.indexOf(targetTag);
        if (funcIdx === -1) {
          // Check if the end of the buffer matches a partial prefix of "<function="
          let partialLen = 0;
          for (
            let len = Math.min(this.buffer.length, targetTag.length - 1);
            len > 0;
            len--
          ) {
            if (this.buffer.endsWith(targetTag.substring(0, len))) {
              partialLen = len;
              break;
            }
          }

          if (partialLen > 0) {
            // Flush content before the partial tag, keep the partial tag in the buffer
            const outputText = this.buffer.substring(
              0,
              this.buffer.length - partialLen,
            );
            this.buffer = this.buffer.substring(
              this.buffer.length - partialLen,
            );
            if (outputText.length > 0) {
              outputs.push({
                delta: { content: outputText },
              });
            }
            break;
          } else {
            // No partial match, flush the entire buffer
            const outputText = this.buffer;
            this.buffer = "";
            outputs.push({
              delta: { content: outputText },
            });
            break;
          }
        } else {
          if (funcIdx > 0) {
            const leadingText = this.buffer.substring(0, funcIdx);
            outputs.push({
              delta: { content: leadingText },
            });
          }
          this.buffer = this.buffer.substring(funcIdx);
          this.inToolCall = true;
        }
      } else {
        const endIdx = this.buffer.indexOf("</function>");
        if (endIdx === -1) {
          break;
        } else {
          const fullToolCallXml = this.buffer.substring(
            0,
            endIdx + "</function>".length,
          );
          this.buffer = this.buffer.substring(endIdx + "</function>".length);
          this.inToolCall = false;

          const parsed = parseXmlToolCall(fullToolCallXml);
          if (parsed) {
            const toolCallId =
              "call_" + Math.random().toString(36).substring(2, 11);
            outputs.push({
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: parsed.name,
                      arguments: JSON.stringify(parsed.arguments),
                    },
                  },
                ],
              },
            });
          } else {
            outputs.push({
              delta: { content: fullToolCallXml },
            });
          }
        }
      }
    }

    return outputs;
  }

  public flush(): any[] {
    const outputs: any[] = [];
    if (this.buffer) {
      outputs.push({
        delta: { content: this.buffer },
      });
      this.buffer = "";
    }
    return outputs;
  }
}

export function extractToolCalls(
  completionText: string,
  nativeToolCalls?: any[],
): any[] {
  const list: any[] = [];
  if (Array.isArray(nativeToolCalls) && nativeToolCalls.length > 0) {
    for (const tc of nativeToolCalls) {
      list.push({
        name: tc.function?.name || tc.name,
        arguments: tc.function?.arguments || tc.arguments,
      });
    }
  }
  if (completionText.includes("<function=")) {
    const parsed = parseXmlToolCall(completionText);
    if (parsed) {
      list.push({
        name: parsed.name,
        arguments: parsed.arguments,
      });
    }
  }
  return list;
}
