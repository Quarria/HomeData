import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { readCookies, sessionCookieName } from "./cookies.js";
import { ALLOW_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from "./auth-metadata.js";
import type { AuthenticatedRequest } from "./auth-types.js";

const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const cookieToken = readCookies(request.headers.cookie)[
      sessionCookieName(request)
    ];
    if (authorization && request.headers.cookie) {
      throw new UnauthorizedException({ code: "AUTH_METHOD_AMBIGUOUS" });
    }
    const bearer =
      typeof authorization === "string"
        ? /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(authorization)
        : null;
    if (authorization && !bearer) {
      throw new UnauthorizedException({ code: "AUTH_REQUIRED" });
    }
    const token = bearer?.[1] ?? cookieToken;
    if (!token) throw new UnauthorizedException({ code: "AUTH_REQUIRED" });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { account: true },
    });
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > IDLE_SESSION_MS ||
      session.account.status !== "ACTIVE" ||
      session.account.authVersion !== session.authVersion
    ) {
      if (session && !session.revokedAt) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: now },
        });
      }
      throw new UnauthorizedException({ code: "AUTH_SESSION_EXPIRED" });
    }

    const allowPasswordChange =
      this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    const allowedDuringChange =
      allowPasswordChange ||
      (request.method === "GET" && request.url.endsWith("/me"));
    if (session.account.mustChangePassword && !allowedDuringChange) {
      throw new ForbiddenException({ code: "PASSWORD_CHANGE_REQUIRED" });
    }

    if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_WRITE_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      });
    }
    request.account = session.account;
    request.sessionId = session.id;
    if (bearer) request.sessionToken = token;
    return true;
  }
}
