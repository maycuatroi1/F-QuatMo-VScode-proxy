import { getLockedList, unlockTarget } from "../../services/rateLimiter";
import { requireCaller } from "../../shared/http/adminCaller";

export async function listSecurityLockouts(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const data = await getLockedList();
  return c.json({ success: true, ...data });
}

export async function unlockSecurityTarget(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const body = await c.req.json();
  const { type, target } = body as { type?: "ip" | "account"; target?: string };

  if (!type || !target) {
    return c.json({ error: "Fields 'type' and 'target' are required." }, 400);
  }

  await unlockTarget(type, target);
  return c.json({
    success: true,
    message: `Lockout cleared for ${type} '${target}'.`,
  });
}
