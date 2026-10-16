import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  adminAccountCreateRequestSchema,
  adminPasswordResetRequestSchema,
  versionRequestSchema,
} from "@homedata/contracts";
import { SystemAdmin } from "../../shared/auth/auth-metadata.js";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { AccountsService } from "./accounts.service.js";

@SystemAdmin()
@Controller("admin/accounts")
export class AccountsController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return apiSuccess(request, await this.accounts.list());
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parseBody(adminAccountCreateRequestSchema, body);
    const result = await this.accounts.create(input, request.account!.id);
    return apiSuccess(request, result);
  }

  @Post(":id/reset-password")
  async resetPassword(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { initialPassword } = parseBody(
      adminPasswordResetRequestSchema,
      body,
    );
    const result = await this.accounts.resetPassword(
      id,
      initialPassword,
      request.account!.id,
    );
    return apiSuccess(request, result);
  }

  @Post(":id/disable")
  async disable(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(versionRequestSchema, body);
    const result = await this.accounts.setEnabled(
      id,
      false,
      version,
      request.account!.id,
    );
    return apiSuccess(request, result);
  }

  @Post(":id/enable")
  async enable(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(versionRequestSchema, body);
    const result = await this.accounts.setEnabled(
      id,
      true,
      version,
      request.account!.id,
    );
    return apiSuccess(request, result);
  }
}
