import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { healthResponseSchema } from "@homedata/contracts";
import { Public } from "../../shared/auth/auth-metadata.js";

@Controller("health")
@Public()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get("live")
  live() {
    return healthResponseSchema.parse({
      status: "ok",
      service: "homedata-api",
      timestamp: new Date().toISOString(),
      checks: { database: "ok" },
    });
  }

  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return healthResponseSchema.parse({
        status: "ok",
        service: "homedata-api",
        timestamp: new Date().toISOString(),
        checks: { database: "ok" },
      });
    } catch (error) {
      this.logger.error(
        error instanceof Error
          ? error.message
          : "Database readiness check failed",
      );
      throw new HttpException(
        {
          status: "degraded",
          service: "homedata-api",
          timestamp: new Date().toISOString(),
          checks: { database: "unavailable" },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
