import { Hono } from "hono";
import { loginUser, getCurrentUser } from "../modules/auth/userHandlers";

const authRouter = new Hono();

authRouter.post("/login", loginUser);
authRouter.get("/me", getCurrentUser);

export { authRouter };
