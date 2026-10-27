import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { CsrfGuard } from "../../src/shared/auth/csrf.guard.js";
import {
  csrfCookie,
  sessionCookie,
  sessionCookieName,
  clearSessionCookie,
} from "../../src/shared/auth/cookies.js";
import { validateEnvironment } from "../../src/shared/config/environment.js";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

function configure() {
  process.env.NODE_ENV = "production";
  process.env.APP_ORIGIN = "https://ledger.example.test";
  process.env.APP_ADDITIONAL_ORIGINS = "http://203.0.113.10:8080";
}

function context(origin: string, token = "token") {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        headers: { origin, cookie: "hd_csrf=token", "x-csrf-token": token },
      }),
    }),
  } as ExecutionContext;
}

describe("simultaneous HTTPS domain and HTTP IP access", () => {
  it("allows both explicit origins while rejecting other origins and invalid CSRF", () => {
    configure();
    const guard = new CsrfGuard();
    expect(guard.canActivate(context(process.env.APP_ORIGIN!))).toBe(true);
    expect(
      guard.canActivate(context(process.env.APP_ADDITIONAL_ORIGINS!)),
    ).toBe(true);
    expect(() =>
      guard.canActivate(context("http://203.0.113.11:8080")),
    ).toThrow();
    expect(() =>
      guard.canActivate(context(process.env.APP_ADDITIONAL_ORIGINS!, "wrong")),
    ).toThrow();
  });

  it("uses host-specific cookies even when the HTTPS proxy forwards HTTP", () => {
    configure();
    const domain = {
      headers: { host: "ledger.example.test", "x-forwarded-proto": "http" },
    };
    const ip = {
      headers: { host: "203.0.113.10:8080", "x-forwarded-proto": "https" },
    };
    expect(sessionCookieName(domain)).toBe("__Host-hd_session");
    expect(sessionCookie("session", 3600, domain)).toContain("; Secure");
    expect(csrfCookie("csrf", domain)).toContain("; Secure");
    expect(clearSessionCookie(domain)).toContain("; Secure");
    expect(sessionCookieName(ip)).toBe("hd_session");
    expect(sessionCookie("session", 3600, ip)).not.toContain("; Secure");
    expect(csrfCookie("csrf", ip)).not.toContain("; Secure");
    expect(clearSessionCookie(ip)).not.toContain("; Secure");
    expect(sessionCookieName({ headers: { host: "untrusted.test" } })).toBe(
      "__Host-hd_session",
    );
  });

  it("validates each additional origin with the same production rules", () => {
    const source = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/test",
      APP_ORIGIN: "https://ledger.example.test",
      SESSION_SECRET: "s".repeat(32),
      CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
    };
    expect(() =>
      validateEnvironment({
        ...source,
        APP_ADDITIONAL_ORIGINS: "http://203.0.113.10:8080",
      }),
    ).not.toThrow();
    for (const origin of [
      "http://insecure.example.test",
      "https://example.test/path",
      "https://user:pass@example.test",
      "*",
      "http://ledger.example.test",
    ]) {
      expect(() =>
        validateEnvironment({ ...source, APP_ADDITIONAL_ORIGINS: origin }),
      ).toThrow();
    }
    expect(() =>
      validateEnvironment({
        ...source,
        APP_ADDITIONAL_ORIGINS: "https://203.0.113.10,http://203.0.113.10",
      }),
    ).toThrow();
  });
});
