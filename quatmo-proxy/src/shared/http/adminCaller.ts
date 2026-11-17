import { HTTPException } from "hono/http-exception";

/** Returns the authenticated caller or aborts with 401 (never defaults to admin). */
export function requireCaller(c: any): {
  username: string;
  role: string;
  name: string;
} {
  const caller = c.get("caller");
  if (!caller || !caller.role || !caller.username) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  return caller;
}
