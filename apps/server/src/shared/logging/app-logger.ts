import { Injectable, LoggerService } from "@nestjs/common";
import pino, { type Logger } from "pino";
import { requestContext } from "../http/request-context.js";

@Injectable()
export class AppLogger implements LoggerService {
  private readonly logger: Logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "password",
        "*.password",
        "authorization",
        "req.headers.authorization",
        "req.headers.cookie",
        "apiKey",
        "*.apiKey",
        "token",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
    base: {
      service: "homedata-api",
      environment: process.env.NODE_ENV ?? "development",
    },
    mixin() {
      const requestId = requestContext.getStore()?.requestId;
      return requestId ? { requestId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info({ context: optional[0] }, String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    this.logger.error(
      { context: optional[0], trace: optional[1] },
      String(message),
    );
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn({ context: optional[0] }, String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug({ context: optional[0] }, String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.trace({ context: optional[0] }, String(message));
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.logger.fatal({ context: optional[0] }, String(message));
  }
}
