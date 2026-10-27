import { isIP } from "node:net";
import { z } from "zod";
import { configuredAppOrigins } from "./app-origins.js";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_ORIGIN: z.string().url().optional(),
  APP_ADDITIONAL_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  RECEIPT_STORAGE_PATH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  AI_PROVIDER: z.enum(["disabled", "deepseek"]).default("disabled"),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  AI_VISION_MODEL: z.string().min(1).default("deepseek-flash"),
  AI_ANALYSIS_MODEL: z.string().min(1).default("deepseek-v4-pro"),
  AI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(180_000)
    .default(90_000),
  WECHAT_NOTIFICATIONS_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`环境配置无效，请检查环境变量：\n${fields}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production") {
    const missing = [
      ["SESSION_SECRET", config.SESSION_SECRET],
      ["CREDENTIAL_ENCRYPTION_KEY", config.CREDENTIAL_ENCRYPTION_KEY],
    ].filter(([, value]) => !value);
    if (missing.length)
      throw new Error(
        `生产环境缺少必填密钥：${missing.map(([key]) => key).join(", ")}`,
      );
    if (!config.APP_ORIGIN) {
      throw new Error("生产环境必须配置 APP_ORIGIN。");
    }
    const originHosts = new Map<string, string>();
    for (const value of configuredAppOrigins(config)) {
      let appOrigin: URL;
      try {
        appOrigin = new URL(value);
      } catch {
        throw new Error(
          "APP_ORIGIN / APP_ADDITIONAL_ORIGINS 必须是完整的 HTTP 或 HTTPS 来源地址。",
        );
      }
      if (
        !["http:", "https:"].includes(appOrigin.protocol) ||
        appOrigin.pathname !== "/" ||
        appOrigin.search ||
        appOrigin.hash ||
        appOrigin.username ||
        appOrigin.password ||
        value !== appOrigin.origin
      ) {
        throw new Error("APP_ORIGIN 必须是完整的 HTTP 或 HTTPS 来源地址。");
      }
      const appHost = appOrigin.hostname.replace(/^\[|\]$/g, "");
      if (appOrigin.protocol === "http:" && isIP(appHost) === 0) {
        throw new Error(
          "生产环境使用 HTTP 时，APP_ORIGIN 只能配置为 IP 地址。",
        );
      }
      const protocol = originHosts.get(appOrigin.host);
      if (protocol && protocol !== appOrigin.protocol) {
        throw new Error(
          "同一访问主机只能配置一种协议，以确定会话 Cookie 的安全属性。",
        );
      }
      originHosts.set(appOrigin.host, appOrigin.protocol);
    }
    if (
      config.SESSION_SECRET?.startsWith("REPLACE_WITH_") ||
      config.CREDENTIAL_ENCRYPTION_KEY?.startsWith("REPLACE_WITH_")
    ) {
      throw new Error("生产环境不能使用 env.example 中的占位密钥。");
    }
    if (config.SESSION_SECRET === config.CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error(
        "SESSION_SECRET 与 CREDENTIAL_ENCRYPTION_KEY 必须使用不同密钥。",
      );
    }
    if (config.AI_PROVIDER === "deepseek" && !config.AI_API_KEY) {
      throw new Error(
        "AI_PROVIDER=deepseek 时必须提供 AI_API_KEY；否则请明确设置 AI_PROVIDER=disabled。",
      );
    }
  }
  if (config.AI_PROVIDER !== "disabled" && !config.AI_API_KEY) {
    throw new Error("AI_PROVIDER 已启用，但缺少 AI_API_KEY。");
  }
  return config;
}
