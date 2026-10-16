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
export const usesSecureCookies = () =>
  isProduction() && process.env.APP_ORIGIN?.startsWith("https://") === true;
export const sessionCookieName = () =>
  usesSecureCookies() ? "__Host-hd_session" : "hd_session";

export function sessionCookie(token: string, maxAgeSeconds: number) {
  return `${sessionCookieName()}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${usesSecureCookies() ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${sessionCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${usesSecureCookies() ? "; Secure" : ""}`;
}

export function csrfCookie(token: string) {
  return `hd_csrf=${encodeURIComponent(token)}; Path=/; Max-Age=43200; SameSite=Lax${usesSecureCookies() ? "; Secure" : ""}`;
}
