import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { readCookies } from "./cookies.js";
import type { AuthenticatedRequest } from "./auth-types.js";
import { configuredAppOrigins } from "../config/app-origins.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function secureEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (SAFE_METHODS.has(request.method)) return true;

    const originHeader = request.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : undefined;
    const allowedOrigins = configuredAppOrigins();
    if (
      process.env.NODE_ENV === "production" &&
      (!origin || !allowedOrigins.includes(origin))
    ) {
      throw new ForbiddenException({ code: "ORIGIN_NOT_ALLOWED" });
    }
    if (
      origin &&
      allowedOrigins.length > 0 &&
      process.env.NODE_ENV !== "production" &&
      !allowedOrigins.includes(origin) &&
      !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      throw new ForbiddenException({ code: "ORIGIN_NOT_ALLOWED" });
    }

    const cookieToken = readCookies(request.headers.cookie).hd_csrf;
    const requestToken = request.headers["x-csrf-token"];
    if (
      !cookieToken ||
      typeof requestToken !== "string" ||
      !secureEqual(cookieToken, requestToken)
    ) {
      throw new ForbiddenException({ code: "CSRF_TOKEN_INVALID" });
    }
    return true;
  }
}
