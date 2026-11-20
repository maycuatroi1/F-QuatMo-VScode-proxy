import { deduplicateRecords, toMs } from "./sessionTime";

export function requestTime(turn: any): number | null {
  const id = String(turn?.requestId ?? turn?.payload?.requestId ?? "");
  const encoded = /^chat-(\d+)-/.exec(id);
  return toMs(turn?.createdAt) ?? (encoded ? toMs(encoded[1]) : null) ?? toMs(turn?.timestamp);
}

export function reconcilePromptTurns(rawTurns: any[] = [], interactions: any[] = []): any[] {
  const turns = deduplicateRecords(rawTurns).map((t) => ({ ...t }));
  const records = deduplicateRecords(interactions);
  const responses = new Map<string, any[]>();
  for (const r of records.filter((r) => r?.type === "chat_response_complete")) {
    const id = r.payload?.requestId;
    if (id) responses.set(id, [...(responses.get(id) ?? []), r]);
  }
  const requests = records.filter((r) => r?.type === "chat_request");
  for (const r of requests) {
    const id = r.payload?.requestId;
    const created = requestTime(r);
    if (!created) continue;
    const userMessages = (r.payload?.messages ?? []).filter((m: any) => m.role === "user");
    const prompt = r.payload?.prompt ?? r.payload?.message ?? userMessages.at(-1)?.content ?? "";
    const conflict = !!id && requests.filter((q) => q.payload?.requestId === id).length > 1;
    const matches = turns.filter((t) =>
      (id && t.requestId === id && !conflict) ||
      (requestTime(t) === created && t.prompt === prompt));
    const responseCandidates = id ? responses.get(id) ?? [] : [];
    const candidate = !conflict && responseCandidates.length === 1 ? responseCandidates[0] : undefined;
    const response = candidate && (toMs(candidate.timestamp) ?? 0) >= created ? candidate : undefined;
    const completed = response ? toMs(response.timestamp) : null;
    if (conflict) for (const t of turns.filter((t) => t.requestId === id)) t.associationStatus = "DUPLICATE_CONFLICT";
    if (matches.length === 1) {
      const t = matches[0];
      if (conflict) t.associationStatus = "DUPLICATE_CONFLICT";
      t.requestId ??= id;
      t.createdAt ??= new Date(created).toISOString();
      if (completed !== null && completed >= created) {
        t.completedAt ??= new Date(completed).toISOString();
        t.responseDurationMs ??= completed - created;
      }
      continue;
    }
    if (matches.length > 1) continue;
    turns.push({
      requestId: id,
      timestamp: new Date(created).toISOString(),
      createdAt: new Date(created).toISOString(),
      ...(completed !== null && completed >= created ? {
        completedAt: new Date(completed).toISOString(), responseDurationMs: completed - created,
      } : {}),
      prompt,
      output: response?.payload?.text ?? response?.payload?.content,
      tokensConsumedTotal: response?.payload?.tokenUsage?.totalTokens,
      history: r.payload?.messages,
      conversationId: r.payload?.conversationId,
      activeFilePath: r.payload?.activeDocumentUri,
      source: "client_reconstructed",
      responseStatus: response ? "matched" : "missing_or_ambiguous",
      ...(conflict ? { associationStatus: "DUPLICATE_CONFLICT" } : {}),
    });
  }
  return turns.sort((a, b) => (requestTime(a) ?? 0) - (requestTime(b) ?? 0));
}
