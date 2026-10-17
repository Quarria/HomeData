import {
  Body,
  Controller,
  Inject,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  expenseVersionRequestSchema,
  occurrencePayRequestSchema,
  reminderPreferenceRequestSchema,
  recurringCreateRequestSchema,
  recurringPatchRequestSchema,
  taskCreateRequestSchema,
  taskListQuerySchema,
  taskPatchRequestSchema,
} from "@homedata/contracts";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import { TasksService } from "./tasks.service.js";

const idempotencyKeySchema = z.string().uuid();

@Controller()
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

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

  @Get("tasks")
  async listTasks(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(taskListQuerySchema, query);
    return apiSuccess(
      request,
      await this.tasks.listTasks(request.account!.id, input),
    );
  }

  @Post("tasks")
  async createTask(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(taskCreateRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.createTask(request.account!.id, input),
    );
  }

  @Get("tasks/:id")
  async getTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.tasks.getTask(id, request.account!.id),
    );
  }

  @Patch("tasks/:id")
  async updateTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(taskPatchRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.updateTask(id, request.account!.id, input),
    );
  }

  @Delete("tasks/:id")
  async deleteTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.deleteTask(id, request.account!.id, version),
    );
  }

  @Post("tasks/:id/complete")
  async completeTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.completeTask(id, request.account!.id, version),
    );
  }

  @Post("tasks/:id/reopen")
  async reopenTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.reopenTask(id, request.account!.id, version),
    );
  }

  @Get("recurring-rules")
  async listRecurring(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        space: z.enum(["personal", "family"]).default("personal"),
        familyId: z.string().uuid().optional(),
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(10),
      })
      .parse(query);
    return apiSuccess(
      request,
      await this.tasks.listRecurring(request.account!.id, input),
    );
  }

  @Post("recurring-rules")
  async createRecurring(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(recurringCreateRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.createRecurring(request.account!.id, input),
    );
  }

  @Patch("recurring-rules/:id")
  async updateRecurring(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(recurringPatchRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.updateRecurring(id, request.account!.id, input),
    );
  }

  @Post("recurring-rules/:id/pause")
  async pauseRecurring(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.setRecurringStatus(
        id,
        request.account!.id,
        version,
        "PAUSED",
      ),
    );
  }

  @Post("recurring-rules/:id/resume")
  async resumeRecurring(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.setRecurringStatus(
        id,
        request.account!.id,
        version,
        "ACTIVE",
      ),
    );
  }

  @Get("recurring-rules/:id/occurrences")
  async listRuleOccurrences(
    @Param("id", ParseUUIDPipe) id: string,
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
      await this.tasks.listOccurrences(id, request.account!.id, input),
    );
  }

  @Post("occurrences/:id/pay")
  async payOccurrence(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(occurrencePayRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.payOccurrence(
        id,
        request.account!.id,
        input,
        this.key(key),
      ),
    );
  }

  @Post("occurrences/:id/skip")
  async skipOccurrence(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(expenseVersionRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.skipOccurrence(id, request.account!.id, version),
    );
  }

  @Get("notifications")
  async notifications(
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
      await this.tasks.listNotifications(request.account!.id, input),
    );
  }

  @Post("notifications/:id/read")
  async markNotificationRead(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.tasks.markNotificationRead(id, request.account!.id),
    );
  }

  @Get("notification-preferences")
  async getNotificationPreferences(@Req() request: AuthenticatedRequest) {
    return apiSuccess(
      request,
      await this.tasks.getReminderPreference(request.account!.id),
    );
  }

  @Put("notification-preferences")
  async updateNotificationPreferences(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(reminderPreferenceRequestSchema, body);
    return apiSuccess(
      request,
      await this.tasks.updateReminderPreference(request.account!.id, input),
    );
  }
}
