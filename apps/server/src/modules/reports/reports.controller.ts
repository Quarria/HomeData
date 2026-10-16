import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import {
  reportDetailsQuerySchema,
  reportQuerySchema,
} from "@homedata/contracts";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { ReportsService } from "./reports.service.js";

@Controller("reports")
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Get("summary")
  async summary(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportQuerySchema, query);
    return apiSuccess(
      request,
      await this.reports.summary(request.account!.id, input),
    );
  }

  @Get("trend")
  async trend(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportQuerySchema, query);
    return apiSuccess(
      request,
      await this.reports.trend(request.account!.id, input),
    );
  }

  @Get("categories")
  async categories(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportQuerySchema, query);
    return apiSuccess(
      request,
      await this.reports.categories(request.account!.id, input),
    );
  }

  @Get("members")
  async members(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportQuerySchema, query);
    return apiSuccess(
      request,
      await this.reports.members(request.account!.id, input),
    );
  }

  @Get("details")
  async details(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportDetailsQuerySchema, query);
    return apiSuccess(
      request,
      await this.reports.details(request.account!.id, input),
    );
  }
}
