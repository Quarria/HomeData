import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  shareCreateRequestSchema,
  shareRevokeRequestSchema,
  shareUnlockRequestSchema,
} from "@homedata/contracts";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { readCookies, usesSecureCookies } from "../../shared/auth/cookies.js";
import { Public } from "../../shared/auth/auth-metadata.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { SharesService } from "./shares.service.js";
import { z } from "zod";

const shareSessionCookieName = () =>
  usesSecureCookies() ? "__Host-hd_share_session" : "hd_share_session";

function shareSessionCookie(token: string, maxAgeSeconds: number) {
  return `${shareSessionCookieName()}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${usesSecureCookies() ? "; Secure" : ""}`;
}

@Controller()
export class SharesController {
  constructor(@Inject(SharesService) private readonly shares: SharesService) {}

  @Get("shares")
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(query);
    return apiSuccess(
      request,
      await this.shares.listOwned(request.account!.id, input),
    );
  }

  @Post("shares")
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parseBody(shareCreateRequestSchema, body);
    return apiSuccess(
      request,
      await this.shares.create(request.account!.id, input),
    );
  }

  @Get("shares/:id")
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSuccess(
      request,
      await this.shares.getOwned(id, request.account!.id),
    );
  }

  @Post("shares/:id/revoke")
  async revoke(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(shareRevokeRequestSchema, body);
    return apiSuccess(
      request,
      await this.shares.revoke(id, request.account!.id, input.version),
    );
  }

  @Public()
  @Post("public/shares/:token/unlock")
  async unlock(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): void },
  ) {
    const input = parseBody(shareUnlockRequestSchema, body);
    const result = await this.shares.unlock(
      token,
      input.passcode,
      request.ip ?? "unknown",
    );
    response.setHeader(
      "Set-Cookie",
      shareSessionCookie(
        result.rawToken,
        Math.max(
          0,
          Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
        ),
      ),
    );
    this.setPrivateHeaders(response);
    return apiSuccess(request, { unlocked: true, expiresAt: result.expiresAt });
  }

  @Public()
  @Get("public/shares/:token")
  async publicView(
    @Param("token") token: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): void },
  ) {
    const cookie = readCookies(request.headers.cookie)[
      shareSessionCookieName()
    ];
    this.setPrivateHeaders(response);
    return apiSuccess(request, await this.shares.publicView(token, cookie));
  }

  private setPrivateHeaders(response: {
    setHeader(name: string, value: string): void;
  }) {
    response.setHeader("Cache-Control", "no-store, private");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }
}
