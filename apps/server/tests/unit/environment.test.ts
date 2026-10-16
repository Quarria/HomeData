import { describe, expect, it } from "vitest";
import { validateEnvironment } from "../../src/shared/config/environment.js";

describe("environment validation", () => {
  it("keeps AI and WeChat disabled unless explicitly enabled", () => {
    const result = validateEnvironment({
      DATABASE_URL: "postgresql://localhost/test",
    });
    expect(result.AI_PROVIDER).toBe("disabled");
    expect(result.WECHAT_NOTIFICATIONS_ENABLED).toBe("false");
  });

  it("fails production startup when secrets are absent", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/test",
        APP_ORIGIN: "https://example.test",
      }),
    ).toThrow(/SESSION_SECRET.*CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("allows production HTTP when the origin is an IP address", () => {
    const result = validateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/test",
      APP_ORIGIN: "http://203.0.113.10:8080",
      SESSION_SECRET: "s".repeat(32),
      CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
    });

    expect(result.APP_ORIGIN).toBe("http://203.0.113.10:8080");
  });

  it("rejects production HTTP origins that use a domain name", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/test",
        APP_ORIGIN: "http://ledger.example.test",
        SESSION_SECRET: "s".repeat(32),
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
      }),
    ).toThrow(/HTTP 时，APP_ORIGIN 只能配置为 IP 地址/);
  });

  it("rejects the sample placeholders and reused production secrets", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/test",
        APP_ORIGIN: "https://example.test",
        SESSION_SECRET: "REPLACE_WITH_A_LONG_RANDOM_SECRET_VALUE",
        CREDENTIAL_ENCRYPTION_KEY: "REPLACE_WITH_ANOTHER_LONG_SECRET_VALUE",
      }),
    ).toThrow(/占位密钥/);
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/test",
        APP_ORIGIN: "https://example.test",
        SESSION_SECRET: "same-secret-".repeat(3),
        CREDENTIAL_ENCRYPTION_KEY: "same-secret-".repeat(3),
      }),
    ).toThrow(/不同密钥/);
  });

  it("requires a provider key only after the AI provider is enabled", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/test",
        APP_ORIGIN: "https://example.test",
        SESSION_SECRET: "s".repeat(32),
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
        AI_PROVIDER: "deepseek",
      }),
    ).toThrow(/AI_API_KEY/);
  });
});
