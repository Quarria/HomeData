import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Res } from "@nestjs/common";
import { z } from "zod";
import {
  expenseCreateRequestSchema,
  expenseListQuerySchema,
  expensePatchRequestSchema,
  expenseVersionRequestSchema,
  refundCreateRequestSchema,
  refundPatchRequestSchema,
} from "@homedata/contracts";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { LedgerService } from "./ledger.service.js";

const idempotencyKeySchema = z.string().uuid();
const receiptLinkSchema = z.object({
  receiptId: z.string().uuid(),
  confirmFamilyVisible: z.boolean().default(false),
});
type PassthroughResponse = { set(headers: Record<string, string>): unknown };

@Controller()
export class LedgerController {
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

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

  @Post("receipts/uploads")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  async uploadReceipt(
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!file) {
      const error = new Error("RECEIPT_REQUIRED") as Error & {
        status: number;
        code: string;
      };
      error.status = HttpStatus.UNPROCESSABLE_ENTITY;
      error.code = "RECEIPT_REQUIRED";
      throw error;
    }
    return apiSuccess(
      request,
      await this.ledger.uploadReceipt(request.account!.id, file),
    );
  }

  @Get("receipts/:id/content")
  async receiptContent(
    @Param("id", ParseUUIDPipe) receiptId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ) {
    const receipt = await this.ledger.receiptContent(
      receiptId,
      request.account!.id,
    );
    response.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return new StreamableFile(receipt.buffer, {
      type: receipt.mimeType,
      length: receipt.sizeBytes,
    });
  }

  @Post("expenses/:id/receipt-links")
  async linkReceipt(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(receiptLinkSchema, body);
    return apiSuccess(
      request,
      await this.ledger.linkReceipt(
        expenseId,
        input.receiptId,
        request.account!.id,
        input.confirmFamilyVisible,
      ),
    );
  }

  @Delete("expenses/:id/receipt-links/:linkId")
  async unlinkReceipt(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Param("linkId", ParseUUIDPipe) linkId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.unlinkReceipt(
        expenseId,
        linkId,
        request.account!.id,
        version,
      ),
    );
  }

  @Get("categories")
  async categories(@Req() request: AuthenticatedRequest) {
    return apiSuccess(request, await this.ledger.categories());
  }

  @Get("expenses")
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(expenseListQuerySchema, query);
    return apiSuccess(
      request,
      await this.ledger.list(request.account!.id, input),
    );
  }

  @Post("expenses")
  async create(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(expenseCreateRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.create(request.account!.id, input, this.key(key)),
    );
  }

  @Get("expenses/:id/audit")
  async audit(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(10),
      })
      .parse(query);
    return apiSuccess(
      request,
      await this.ledger.audit(expenseId, request.account!.id, input),
    );
  }

  @Get("expenses/:id")
  async get(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.ledger.get(expenseId, request.account!.id),
    );
  }

  @Patch("expenses/:id")
  async update(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(expensePatchRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.update(expenseId, request.account!.id, input),
    );
  }

  @Delete("expenses/:id")
  async remove(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.remove(expenseId, request.account!.id, version),
    );
  }

  @Post("expenses/:id/restore")
  async restoreExpense(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.restoreExpense(expenseId, request.account!.id, version),
    );
  }

  @Post("expenses/:id/refunds")
  async createRefund(
    @Param("id", ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(refundCreateRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.createRefund(
        expenseId,
        request.account!.id,
        input,
        this.key(key),
      ),
    );
  }

  @Patch("refunds/:id")
  async updateRefund(
    @Param("id", ParseUUIDPipe) refundId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(refundPatchRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.updateRefund(refundId, request.account!.id, input),
    );
  }

  @Delete("refunds/:id")
  async removeRefund(
    @Param("id", ParseUUIDPipe) refundId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.removeRefund(refundId, request.account!.id, version),
    );
  }

  @Post("refunds/:id/restore")
  async restoreRefund(
    @Param("id", ParseUUIDPipe) refundId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.ledger.restoreRefund(refundId, request.account!.id, version),
    );
  }
}
