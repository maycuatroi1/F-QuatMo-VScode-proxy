import { getTrustedClientIP } from "../../services/security";

export function getClientIP(c: any): string {
  return getTrustedClientIP((n) => c.req.header(n));
}
