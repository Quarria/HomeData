import {
  ConflictException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  reportQuerySchema,
  wardrobeRecommendationRequestSchema,
} from "@homedata/contracts";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { AiService } from "./ai.service.js";

const receiptRequestSchema = z.object({ receiptId: z.string().uuid() });
const wardrobeImageRequestSchema = z.object({
  wardrobeImageId: z.string().uuid(),
});
const idempotencyKeySchema = z.string().uuid();

@Controller("ai")
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @Get("status")
  status(@Req() request: AuthenticatedRequest) {
    return apiSuccess(request, this.ai.availability());
  }

  private key(value: string | undefined) {
    const parsed = idempotencyKeySchema.safeParse(value);
    if (!parsed.success) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED") as Error & {
        status: number;
        code: string;
      };
      error.status = 422;
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }
    return parsed.data;
  }

  @Post("receipt-extractions")
  async extractReceipt(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(receiptRequestSchema, body);
    return apiSuccess(
      request,
      await this.ai.createReceiptExtraction(
        request.account!.id,
        input.receiptId,
        this.key(key),
      ),
    );
  }

  @Post("wardrobe-recognitions")
  async recognizeWardrobe(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(wardrobeImageRequestSchema, body);
    return apiSuccess(
      request,
      await this.ai.createWardrobeRecognition(
        request.account!.id,
        input.wardrobeImageId,
        this.key(key),
      ),
    );
  }

  @Post("wardrobe-recommendations")
  async recommendWardrobe(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(wardrobeRecommendationRequestSchema, body);
    const requestKey = this.key(key ?? input.idempotencyKey);
    if (requestKey !== input.idempotencyKey) {
      throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
    }
    return apiSuccess(
      request,
      await this.ai.createWardrobeRecommendation(
        request.account!.id,
        input,
        requestKey,
      ),
    );
  }

  @Post("analyses")
  async analyze(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reportQuerySchema, body);
    return apiSuccess(
      request,
      await this.ai.createAnalysis(request.account!.id, input, this.key(key)),
    );
  }

  @Get("runs/:id")
  async getRun(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(request, await this.ai.getRun(request.account!.id, id));
  }
}
