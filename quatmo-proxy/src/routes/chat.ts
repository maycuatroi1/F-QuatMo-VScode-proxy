// Preserve existing key initialization order while ENV loading remains unchanged.
import "../services/proxyKey";
import { clientVersionGate } from "../middleware/clientVersionGate";
import { Hono } from "hono";
import type { UserSession } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { unifiedAuthMiddleware } from "../middleware/authUnified";
import { verifyFingerprintMiddleware } from "../middleware/verifyFingerprint";
import dotenv from "dotenv";
import { getLatestClassification, saveClientContext } from "../modules/chat/contextHandlers";
import { completeChat } from "../modules/chat/completionsHandler";

dotenv.config();

const chatRouter = new Hono<{
  Variables: {
    user: UserSession;
    token: string;
    authMode?: "session" | "normal";
    sessionContext?: any;
    sessionKey?: string;
  };
}>();

chatRouter.use("*", verifyFingerprintMiddleware());
chatRouter.use("*", clientVersionGate({ allowVerifiedSessionTokens: true }));
chatRouter.get("/latest-classification", unifiedAuthMiddleware(), getLatestClassification);
chatRouter.post("/client-context", unifiedAuthMiddleware(), saveClientContext);
chatRouter.post("/completions", unifiedAuthMiddleware(), rateLimitMiddleware(), completeChat);

export { chatRouter };
export { latestClassifications } from "../modules/chat/classificationState";
export { isInlineCompletionRequest } from "../modules/chat/inlineGuard";
export { CLIENT_COMMAND_PRECEDENCE_DIRECTIVE } from "../modules/chat/prompts";
export { parseXmlToolCall, XmlToolCallConverter } from "../modules/chat/toolCalls";
export type { ParsedToolCall } from "../modules/chat/toolCalls";
