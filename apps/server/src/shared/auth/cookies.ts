import { configuredAppOrigins } from "../config/app-origins.js";
import type { AuthenticatedRequest } from "./auth-types.js";

type CookieRequest = Pick<AuthenticatedRequest, "headers">;

export function readCookies(header: string | string[] | undefined) {
  if (!header || Array.isArray(header)) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      return [
        [
          part.slice(0, separator).trim(),
          decodeURIComponent(part.slice(separator + 1).trim()),
        ],
      ];
    }),
  );
}

export const isProduction = () => process.env.NODE_ENV === "production";
export function usesSecureCookies(request?: CookieRequest) {
  if (!isProduction()) return false;
  const host = request?.headers.host;
  const origin =
    typeof host === "string"
      ? configuredAppOrigins().find(
          (value) => new URL(value).host === host.toLowerCase(),
        )
      : undefined;
  return (origin ?? process.env.APP_ORIGIN)?.startsWith("https://") === true;
}
export const sessionCookieName = (request?: CookieRequest) =>
  usesSecureCookies(request) ? "__Host-hd_session" : "hd_session";

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  request?: CookieRequest,
) {
  return `${sessionCookieName(request)}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${usesSecureCookies(request) ? "; Secure" : ""}`;
}

export function clearSessionCookie(request?: CookieRequest) {
  return `${sessionCookieName(request)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${usesSecureCookies(request) ? "; Secure" : ""}`;
}

export function csrfCookie(token: string, request?: CookieRequest) {
  return `hd_csrf=${encodeURIComponent(token)}; Path=/; Max-Age=${token ? 43200 : 0}; SameSite=Lax${usesSecureCookies(request) ? "; Secure" : ""}`;
}
