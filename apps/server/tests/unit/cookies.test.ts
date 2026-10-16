import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  csrfCookie,
  sessionCookie,
  sessionCookieName,
} from "../../src/shared/auth/cookies.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalAppOrigin = process.env.APP_ORIGIN;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
});

describe("authentication cookies", () => {
  it("uses Secure host cookies for production HTTPS", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://ledger.example.test";

    expect(sessionCookieName()).toBe("__Host-hd_session");
    expect(sessionCookie("session", 3600)).toContain("; Secure");
    expect(csrfCookie("csrf")).toContain("; Secure");
    expect(clearSessionCookie()).toContain("; Secure");
  });

  it("uses HTTP-compatible cookies for production IP access", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "http://203.0.113.10:8080";

    expect(sessionCookieName()).toBe("hd_session");
    expect(sessionCookie("session", 3600)).not.toContain("; Secure");
    expect(csrfCookie("csrf")).not.toContain("; Secure");
    expect(clearSessionCookie()).not.toContain("; Secure");
  });
});
