import { getProxyApiKey } from "./proxyKey";

export function getAdminUsername(): string {
  return process.env.ADMIN_USERNAME || "admin";
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD || getProxyApiKey();
}
