import { Hono } from "hono";
import { clientVersionGate } from "../middleware/clientVersionGate";
import { streamSessionEvents } from "../modules/sessions/streamHandler";
import { getSessionStatus } from "../modules/sessions/statusHandler";
import { loginSession } from "../modules/sessions/loginHandler";
import { uploadSessionLogs } from "../modules/sessions/uploadHandler";

const sessionAuthRouter = new Hono();

sessionAuthRouter.get("/events/stream", streamSessionEvents);
sessionAuthRouter.get("/status", getSessionStatus);
sessionAuthRouter.post("/login", clientVersionGate(), loginSession);
sessionAuthRouter.post("/upload-logs", uploadSessionLogs);

export { sessionAuthRouter };
