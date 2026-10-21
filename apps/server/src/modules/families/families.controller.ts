import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  familyCreateRequestSchema,
  familyDefaultCityRequestSchema,
  familyHandoverRequestSchema,
  familyMemberAddRequestSchema,
  familyVersionRequestSchema,
} from "@homedata/contracts";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { FamiliesService } from "./families.service.js";

@Controller("families")
export class FamiliesController {
  constructor(
    @Inject(FamiliesService) private readonly families: FamiliesService,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parseBody(familyCreateRequestSchema, body);
    const family = await this.families.create(request.account!.id, input.name);
    return apiSuccess(request, family);
  }

  @Get("current")
  async current(@Req() request: AuthenticatedRequest) {
    return apiSuccess(
      request,
      await this.families.current(request.account!.id),
    );
  }

  @Patch(":id/default-city")
  async setDefaultCity(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(familyDefaultCityRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.setDefaultCity(familyId, request.account!.id, input),
    );
  }

  @Get(":id/members")
  async members(
    @Param("id") familyId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.families.members(familyId, request.account!.id),
    );
  }

  @Post(":id/members")
  async addMember(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(familyMemberAddRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.addMember(
        familyId,
        request.account!.id,
        input.username,
      ),
    );
  }

  @Delete(":id/members/:accountId")
  async removeMember(
    @Param("id") familyId: string,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(familyVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.removeMember(
        familyId,
        request.account!.id,
        accountId,
        version,
      ),
    );
  }

  @Post(":id/leave")
  async leave(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(familyVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.leave(familyId, request.account!.id, version),
    );
  }

  @Post(":id/handover")
  async handover(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(familyHandoverRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.handover(
        familyId,
        request.account!.id,
        input.targetAccountId,
        input.version,
      ),
    );
  }

  @Post(":id/archive")
  async archive(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(familyVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.setArchived(
        familyId,
        request.account!.id,
        version,
        true,
      ),
    );
  }

  @Post(":id/restore")
  async restore(
    @Param("id") familyId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(familyVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.families.setArchived(
        familyId,
        request.account!.id,
        version,
        false,
      ),
    );
  }
}
