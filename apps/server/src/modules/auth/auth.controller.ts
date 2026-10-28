import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  accountProfilePatchRequestSchema,
  loginRequestSchema,
  passwordChangeRequestSchema,
} from "@homedata/contracts";
import { AuthService, accountSummary } from "./auth.service.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import {
  AllowPasswordChange,
  MiniprogramLogin,
  Public,
} from "../../shared/auth/auth-metadata.js";
import {
  clearSessionCookie,
  csrfCookie,
  sessionCookie,
} from "../../shared/auth/cookies.js";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get("auth/csrf")
  csrf(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): void },
  ) {
    const token = randomBytes(32).toString("base64url");
    response.setHeader("Set-Cookie", csrfCookie(token, request));
    return apiSuccess(request, { token });
  }

  @Public()
  @Post("auth/login")
  async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): void },
  ) {
    const input = parseBody(loginRequestSchema, body);
    const result = await this.auth.login(
      input.username,
      input.password,
      request.ip ?? "unknown",
    );
    response.setHeader(
      "Set-Cookie",
      sessionCookie(result.rawToken, 7 * 24 * 60 * 60, request),
    );
    return apiSuccess(request, {
      account: result.account,
      family: null,
      mustChangePassword: result.account.mustChangePassword,
    });
  }

  @Public()
  @MiniprogramLogin()
  @Post("auth/miniprogram/login")
  async miniprogramLogin(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(loginRequestSchema, body);
    const result = await this.auth.login(
      input.username,
      input.password,
      request.ip ?? "unknown",
    );
    return apiSuccess(request, {
      token: result.rawToken,
      account: result.account,
      family: null,
      mustChangePassword: result.account.mustChangePassword,
    });
  }

  @AllowPasswordChange()
  @Post("auth/logout")
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string | string[]): void },
  ) {
    if (!request.sessionId) throw new UnauthorizedException();
    await this.auth.logout(request.sessionId);
    response.setHeader("Set-Cookie", [
      clearSessionCookie(request),
      csrfCookie("", request),
    ]);
    return apiSuccess(request, null);
  }

  @AllowPasswordChange()
  @Get("me")
  async me(@Req() request: AuthenticatedRequest) {
    const account = request.account;
    if (!account) throw new UnauthorizedException();
    const membership = await this.prisma.membership.findFirst({
      where: { accountId: account.id, leftAt: null },
      include: {
        family: {
          include: {
            memberships: {
              where: { leftAt: null, account: { status: "ACTIVE" } },
              include: { account: true },
              orderBy: { joinedAt: "asc" },
            },
          },
        },
      },
    });
    const family = membership
      ? {
          id: membership.family.id,
          name: membership.family.name,
          adminAccountId: membership.family.adminAccountId,
          status: membership.family.status,
          version: membership.family.version,
          defaultCity: membership.family.defaultCityName
            ? {
                name: membership.family.defaultCityName,
                countryCode: membership.family.defaultCityCountry!,
                latitude: membership.family.defaultCityLatitude!,
                longitude: membership.family.defaultCityLongitude!,
                timezone: membership.family.defaultCityTimezone!,
              }
            : null,
          role:
            membership.family.adminAccountId === account.id
              ? "ADMIN"
              : "MEMBER",
          members: membership.family.memberships.map(({ account: member }) => ({
            id: member.id,
            username: member.username,
            nickname: member.nickname,
          })),
        }
      : null;
    return apiSuccess(request, {
      account: accountSummary(account),
      family,
      mustChangePassword: account.mustChangePassword,
    });
  }

  @Patch("me")
  async updateProfile(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(accountProfilePatchRequestSchema, body);
    const account = request.account;
    if (!account) throw new UnauthorizedException();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.account.updateMany({
        where: { id: account.id, version: input.version, status: "ACTIVE" },
        data: {
          nickname: input.nickname,
          ...(input.gender ? { gender: input.gender } : {}),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const current = await tx.account.findUniqueOrThrow({
        where: { id: account.id },
      });
      await tx.auditEvent.create({
        data: {
          actorId: account.id,
          action: "ACCOUNT_PROFILE_UPDATED",
          subjectType: "ACCOUNT",
          subjectId: account.id,
          details: {
            fields: input.gender ? ["nickname", "gender"] : ["nickname"],
          },
        },
      });
      return current;
    });
    return apiSuccess(request, accountSummary(updated));
  }

  @AllowPasswordChange()
  @Post("me/password")
  async changePassword(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): void },
  ) {
    const input = parseBody(passwordChangeRequestSchema, body);
    if (!request.account || !request.sessionId)
      throw new UnauthorizedException();
    const result = await this.auth.changePassword(
      request.account.id,
      request.sessionId,
      input.currentPassword,
      input.newPassword,
    );
    if (!request.sessionToken) {
      response.setHeader(
        "Set-Cookie",
        sessionCookie(result.rawToken, 7 * 24 * 60 * 60, request),
      );
    }
    return apiSuccess(request, {
      account: result.account,
      family: null,
      mustChangePassword: false,
      ...(request.sessionToken ? { token: result.rawToken } : {}),
    });
  }
}
