import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { reportQuerySchema } from "@homedata/contracts";
import { Prisma } from "../../../prisma/generated/client/client.js";
import type { z } from "zod";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { ReceiptStorageService } from "../ledger/receipt-storage.service.js";
import { ReportsService } from "../reports/reports.service.js";
import { AiProvider, validateAnalysisOutput } from "./ai-provider.js";
import { validateEnvironment } from "../../shared/config/environment.js";

type ReportInput = z.infer<typeof reportQuerySchema>;
type RunType = "RECEIPT_EXTRACTION" | "ANALYSIS";

const AI_LIMITS = { recognition: 20, analysis: 5 } as const;
const MAX_ATTEMPTS = 2;
const RUN_STALE_AFTER_MS = 5 * 60 * 1000;

function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  return new Date(
    `${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`,
  );
}

function sameJson(left: unknown, right: unknown) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function errorCode(error: unknown) {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "PROVIDER_UNAVAILABLE";
}

function retryable(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "retryable" in error &&
    error.retryable,
  );
}

@Injectable()
export class AiService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReceiptStorageService)
    private readonly receiptStorage: ReceiptStorageService,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(AiProvider) private readonly provider: AiProvider,
  ) {}

  private bucket(type: RunType) {
    return type === "ANALYSIS" ? "analysis" : "recognition";
  }

  private async enqueue(
    actorId: string,
    type: RunType,
    idempotencyKey: string,
    input: Prisma.InputJsonObject,
    fields: {
      familyId?: string;
      membershipId?: string;
      receiptId?: string;
    } = {},
  ) {
    const bucket = this.bucket(type);
    const usageDate = beijingDate();
    const limit = AI_LIMITS[bucket];
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.aiRun.findUnique({
        where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
      });
      if (existing) {
        if (existing.type !== type || !sameJson(existing.input, input)) {
          throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
        }
        return existing;
      }
      const reserved = await tx.$queryRaw<Array<{ account_id: string }>>`
        INSERT INTO ai_daily_usage (account_id, usage_date, bucket, reserved, succeeded, updated_at)
        VALUES (${actorId}::uuid, ${usageDate}::date, ${bucket}, 1, 0, now())
        ON CONFLICT (account_id, usage_date, bucket) DO UPDATE SET
          reserved = ai_daily_usage.reserved + 1,
          updated_at = now()
        WHERE ai_daily_usage.reserved + ai_daily_usage.succeeded < ${limit}
        RETURNING account_id
      `;
      if (!reserved.length) {
        throw new ConflictException({ code: "AI_QUOTA_EXCEEDED" });
      }
      return tx.aiRun.create({
        data: {
          actorId,
          type,
          status: "PENDING",
          idempotencyKey,
          input,
          usageDate,
          ...(fields.familyId ? { familyId: fields.familyId } : {}),
          ...(fields.membershipId ? { membershipId: fields.membershipId } : {}),
          ...(fields.receiptId ? { receiptId: fields.receiptId } : {}),
        },
      });
    });
  }

  async createReceiptExtraction(
    actorId: string,
    receiptId: string,
    key: string,
  ) {
    this.assertConfigured();
    const receipt = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      select: {
        id: true,
        uploadedById: true,
        privacyLock: true,
        links: { select: { expense: { select: { familyId: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
    let familyDependency:
      { familyId: string; membershipId: string } | undefined;
    if (receipt.uploadedById !== actorId) {
      if (receipt.privacyLock !== "FAMILY")
        throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
      const familyIds = [
        ...new Set(
          receipt.links.flatMap(({ expense }) =>
            expense.familyId ? [expense.familyId] : [],
          ),
        ),
      ];
      const membership = await this.prisma.membership.findFirst({
        where: {
          accountId: actorId,
          familyId: { in: familyIds },
          leftAt: null,
          family: { status: "ACTIVE" },
        },
        select: { id: true, familyId: true },
      });
      if (!membership)
        throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
      familyDependency = {
        familyId: membership.familyId,
        membershipId: membership.id,
      };
    }
    const run = await this.enqueue(
      actorId,
      "RECEIPT_EXTRACTION",
      key,
      { receiptId, ...familyDependency },
      { receiptId },
    );
    return this.runDto(run);
  }

  async createAnalysis(actorId: string, input: ReportInput, key: string) {
    if (input.space === "family" && !input.familyId) {
      throw new ConflictException({ code: "FAMILY_ID_REQUIRED" });
    }
    const membership = input.familyId
      ? await this.prisma.membership.findFirst({
          where: {
            familyId: input.familyId,
            accountId: actorId,
            leftAt: null,
            family: { status: "ACTIVE" },
          },
          select: { id: true },
        })
      : null;
    if (input.familyId && !membership) {
      throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    }
    const [summary, trend, categories] = [
      await this.reports.summary(actorId, { ...input, basis: "net" }),
      await this.reports.trend(actorId, { ...input, basis: "net" }),
      await this.reports.categories(actorId, { ...input, basis: "net" }),
    ];
    if (!summary.hasData) {
      return {
        id: null,
        status: "SUCCEEDED",
        result: {
          changes: [],
          evidence: [],
          thingsToVerify: ["所选周期没有支出记录，暂无可分析内容。"],
        },
      };
    }
    this.assertConfigured();
    const evidence = [
      ...categories.map((category) => ({
        id: `category:${category.code}`,
        label: `${category.name}净支出`,
        value: category.net,
      })),
      ...trend.points.map((point) => ({
        id: `period:${point.period}`,
        label: `${point.period}净支出`,
        value: point.net,
      })),
    ];
    const safeInput = {
      range: { from: summary.from, to: summary.to },
      comparisonRange: {
        from: summary.comparison.from,
        to: summary.comparison.to,
      },
      totals: {
        expense: summary.expense,
        refund: summary.refund,
        net: summary.net,
        previousNet: summary.comparison.net,
      },
      categories: categories.map(({ code, name, expense, refund, net }) => ({
        code,
        name,
        expense,
        refund,
        net,
      })),
      periods: trend.points,
      evidence,
    } satisfies Prisma.InputJsonObject;
    const run = await this.enqueue(
      actorId,
      "ANALYSIS",
      key,
      safeInput,
      input.familyId
        ? { familyId: input.familyId, membershipId: membership!.id }
        : {},
    );
    return this.runDto(run);
  }

  private assertConfigured() {
    const config = validateEnvironment();
    if (config.AI_PROVIDER === "disabled" || !config.AI_API_KEY) {
      throw new ConflictException({ code: "AI_NOT_CONFIGURED" });
    }
  }

  availability() {
    const config = validateEnvironment();
    return {
      enabled: config.AI_PROVIDER !== "disabled" && Boolean(config.AI_API_KEY),
      provider: config.AI_PROVIDER,
      limits: AI_LIMITS,
    };
  }

  private runDto(run: {
    id: string;
    type: RunType;
    status: string;
    errorCode: string | null;
    result: Prisma.JsonValue | null;
    createdAt: Date;
    finishedAt: Date | null;
  }) {
    return {
      id: run.id,
      type: run.type,
      status: run.status,
      errorCode: run.errorCode,
      result: run.result,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
  }

  async getRun(actorId: string, runId: string) {
    const run = await this.prisma.aiRun.findFirst({
      where: { id: runId, actorId },
    });
    if (!run) throw new NotFoundException({ code: "AI_RUN_NOT_FOUND" });
    if (run.familyId) {
      const membership = await this.prisma.membership.findFirst({
        where: {
          id: run.membershipId ?? "00000000-0000-0000-0000-000000000000",
          familyId: run.familyId,
          accountId: actorId,
          leftAt: null,
          family: { status: "ACTIVE" },
        },
        select: { id: true },
      });
      if (!membership) {
        await this.cancel(run.id);
        return this.runDto({
          ...run,
          status: "CANCELLED",
          result: null,
          errorCode: "AI_ACCESS_REVOKED",
        });
      }
    }
    return this.runDto(run);
  }

  private async cancel(runId: string) {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!run || ["CANCELLED", "FAILED", "SUCCEEDED"].includes(run.status))
      return;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.aiRun.updateMany({
        where: { id: runId, status: { in: ["PENDING", "RUNNING"] } },
        data: {
          status: "CANCELLED",
          result: Prisma.JsonNull,
          errorCode: "AI_ACCESS_REVOKED",
          finishedAt: new Date(),
        },
      });
      if (updated.count) {
        await tx.aiDailyUsage.updateMany({
          where: {
            accountId: run.actorId,
            usageDate: run.usageDate,
            bucket: this.bucket(run.type),
            reserved: { gt: 0 },
          },
          data: { reserved: { decrement: 1 } },
        });
      }
    });
  }

  async processNext() {
    await this.recoverStaleRuns();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM ai_runs WHERE status = 'PENDING'::"AiRunStatus"
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const id = rows[0]?.id;
      if (!id) return null;
      return tx.aiRun.update({
        where: { id },
        data: {
          status: "RUNNING",
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    });
    if (!claimed) return false;
    const usageBucket = this.bucket(claimed.type);
    try {
      const access = await this.executionAccess(claimed);
      if (!access) {
        await this.cancel(claimed.id);
        return true;
      }
      let result: unknown;
      let usage: unknown;
      if (claimed.type === "RECEIPT_EXTRACTION") {
        const receiptId = (claimed.input as { receiptId: string }).receiptId;
        const receipt = await this.loadReceipt(claimed.actorId, receiptId);
        const categories = await this.prisma.category.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { sortOrder: "asc" },
        });
        const extracted = await this.provider.extractReceipt({
          image: receipt.buffer,
          mime: receipt.mimeType,
          categories,
        });
        usage = extracted.usage;
        const byCode = new Map(
          categories.map((category) => [category.code, category]),
        );
        result = {
          receiptId,
          ...extracted.data,
          items: extracted.data.items.map((item) => ({
            ...item,
            categoryId: item.categoryCode
              ? (byCode.get(item.categoryCode)?.id ?? null)
              : null,
            categoryCode:
              item.categoryCode && byCode.has(item.categoryCode)
                ? item.categoryCode
                : null,
          })),
        };
      } else {
        const safeInput = claimed.input as {
          evidence: Array<{ id: string; label: string; value: string }>;
        };
        const analysis = await this.provider.analyze(claimed.input);
        usage = analysis.usage;
        const validated = validateAnalysisOutput(
          analysis.data,
          new Set(safeInput.evidence.map(({ id }) => id)),
        );
        const byId = new Map(safeInput.evidence.map((item) => [item.id, item]));
        result = {
          changes: validated.changes,
          evidence: validated.evidence.map(({ id }) => byId.get(id)),
          thingsToVerify: validated.thingsToVerify,
        };
      }
      if (!(await this.executionAccess(claimed))) {
        await this.cancel(claimed.id);
        return true;
      }
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.aiRun.updateMany({
          where: { id: claimed.id, status: "RUNNING" },
          data: {
            status: "SUCCEEDED",
            result: result as Prisma.InputJsonValue,
            providerUsage:
              usage === undefined
                ? Prisma.JsonNull
                : (usage as Prisma.InputJsonValue),
            finishedAt: new Date(),
          },
        });
        if (updated.count) {
          await tx.aiDailyUsage.update({
            where: {
              accountId_usageDate_bucket: {
                accountId: claimed.actorId,
                usageDate: claimed.usageDate,
                bucket: usageBucket,
              },
            },
            data: { reserved: { decrement: 1 }, succeeded: { increment: 1 } },
          });
        }
      });
    } catch (error) {
      if (retryable(error) && claimed.attempts < MAX_ATTEMPTS) {
        await this.prisma.aiRun.updateMany({
          where: { id: claimed.id, status: "RUNNING" },
          data: { status: "PENDING" },
        });
      } else {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.aiRun.updateMany({
            where: { id: claimed.id, status: "RUNNING" },
            data: {
              status: "FAILED",
              errorCode: errorCode(error),
              finishedAt: new Date(),
            },
          });
          if (updated.count) {
            await tx.aiDailyUsage.update({
              where: {
                accountId_usageDate_bucket: {
                  accountId: claimed.actorId,
                  usageDate: claimed.usageDate,
                  bucket: usageBucket,
                },
              },
              data: { reserved: { decrement: 1 } },
            });
          }
        });
      }
    }
    return true;
  }

  private async executionAccess(run: {
    actorId: string;
    familyId: string | null;
    membershipId: string | null;
  }) {
    const account = await this.prisma.account.findUnique({
      where: { id: run.actorId },
      select: { status: true },
    });
    if (!account || account.status !== "ACTIVE") return false;
    if (!run.familyId) return true;
    return Boolean(
      await this.prisma.membership.findFirst({
        where: {
          id: run.membershipId ?? "00000000-0000-0000-0000-000000000000",
          familyId: run.familyId,
          accountId: run.actorId,
          leftAt: null,
          family: { status: "ACTIVE" },
        },
        select: { id: true },
      }),
    );
  }

  private lastRecoveryAt = 0;

  private async recoverStaleRuns() {
    if (Date.now() - this.lastRecoveryAt < 30_000) return;
    this.lastRecoveryAt = Date.now();
    const staleBefore = new Date(Date.now() - RUN_STALE_AFTER_MS);
    const stale = await this.prisma.aiRun.findMany({
      where: { status: "RUNNING", startedAt: { lt: staleBefore } },
      take: 50,
      orderBy: { startedAt: "asc" },
    });
    for (const run of stale) {
      if (run.attempts < MAX_ATTEMPTS) {
        await this.prisma.aiRun.updateMany({
          where: {
            id: run.id,
            status: "RUNNING",
            startedAt: { lt: staleBefore },
          },
          data: { status: "PENDING" },
        });
      } else {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.aiRun.updateMany({
            where: {
              id: run.id,
              status: "RUNNING",
              startedAt: { lt: staleBefore },
            },
            data: {
              status: "FAILED",
              errorCode: "PROVIDER_TIMEOUT",
              finishedAt: new Date(),
            },
          });
          if (updated.count) {
            await tx.aiDailyUsage.updateMany({
              where: {
                accountId: run.actorId,
                usageDate: run.usageDate,
                bucket: this.bucket(run.type),
                reserved: { gt: 0 },
              },
              data: { reserved: { decrement: 1 } },
            });
          }
        });
      }
    }
  }

  private async loadReceipt(actorId: string, receiptId: string) {
    const receipt = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      select: {
        uploadedById: true,
        storageKey: true,
        mimeType: true,
        privacyLock: true,
        links: { select: { expense: { select: { familyId: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
    if (receipt.uploadedById !== actorId) {
      const familyIds = [
        ...new Set(
          receipt.links.flatMap(({ expense }) =>
            expense.familyId ? [expense.familyId] : [],
          ),
        ),
      ];
      const membership =
        receipt.privacyLock === "FAMILY" && familyIds.length
          ? await this.prisma.membership.findFirst({
              where: {
                accountId: actorId,
                familyId: { in: familyIds },
                leftAt: null,
                family: { status: "ACTIVE" },
              },
              select: { id: true },
            })
          : null;
      if (!membership)
        throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
    }
    return {
      buffer: await this.receiptStorage.read(receipt.storageKey),
      mimeType: receipt.mimeType,
    };
  }
}
