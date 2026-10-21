import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  reportQuerySchema,
  wardrobeDailyRecommendationRequestSchema,
  wardrobeRecommendationRequestSchema,
} from "@homedata/contracts";
import { Prisma } from "../../../prisma/generated/client/client.js";
import type { z } from "zod";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { ReceiptStorageService } from "../ledger/receipt-storage.service.js";
import { ReportsService } from "../reports/reports.service.js";
import { AiProvider, validateAnalysisOutput } from "./ai-provider.js";
import { validateEnvironment } from "../../shared/config/environment.js";
import { WardrobeImageStorageService } from "../wardrobe/wardrobe-image-storage.service.js";
import { WardrobeOutfitService } from "../wardrobe/wardrobe-outfit.service.js";

type ReportInput = z.infer<typeof reportQuerySchema>;
type WardrobeDailyInput = z.infer<
  typeof wardrobeDailyRecommendationRequestSchema
>;
type WardrobeRecommendationInput = z.infer<
  typeof wardrobeRecommendationRequestSchema
>;
type RunType =
  | "RECEIPT_EXTRACTION"
  | "ANALYSIS"
  | "WARDROBE_RECOGNITION"
  | "WARDROBE_RECOMMENDATION";

const AI_LIMITS = {
  recognition: 20,
  analysis: 5,
  wardrobe_recognition: 10,
  wardrobe_recommendation: 5,
} as const;
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
  if (!error || typeof error !== "object") return "PROVIDER_UNAVAILABLE";
  if ("code" in error && typeof error.code === "string") return error.code;
  if (
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "code" in error.response &&
    typeof error.response.code === "string"
  ) {
    return error.response.code;
  }
  return "PROVIDER_UNAVAILABLE";
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
    @Inject(WardrobeImageStorageService)
    private readonly wardrobeImageStorage: WardrobeImageStorageService,
    @Inject(WardrobeOutfitService)
    private readonly wardrobeOutfits: WardrobeOutfitService,
  ) {}

  private bucket(type: RunType) {
    switch (type) {
      case "RECEIPT_EXTRACTION":
        return "recognition";
      case "ANALYSIS":
        return "analysis";
      case "WARDROBE_RECOGNITION":
        return "wardrobe_recognition";
      case "WARDROBE_RECOMMENDATION":
        return "wardrobe_recommendation";
    }
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
      wardrobeImageId?: string;
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
          ...(fields.wardrobeImageId
            ? { wardrobeImageId: fields.wardrobeImageId }
            : {}),
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

  async createWardrobeRecognition(
    actorId: string,
    wardrobeImageId: string,
    key: string,
  ) {
    this.assertConfigured();
    const account = await this.prisma.account.findUnique({
      where: { id: actorId },
      select: { gender: true },
    });
    const gender = account?.gender ?? "UNSPECIFIED";
    const image = await this.prisma.wardrobeImage.findFirst({
      where: { id: wardrobeImageId, uploadedById: actorId, garment: null },
      select: { id: true, contentHash: true },
    });
    if (!image)
      throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    const cached = await this.prisma.aiRun.findFirst({
      where: {
        actorId,
        type: "WARDROBE_RECOGNITION",
        status: "SUCCEEDED",
        input: { equals: { wardrobeImageId, gender } },
        wardrobeImage: { contentHash: image.contentHash },
      },
      orderBy: { finishedAt: "desc" },
    });
    if (cached) return this.runDto(cached);
    const run = await this.enqueue(
      actorId,
      "WARDROBE_RECOGNITION",
      key,
      { wardrobeImageId, gender },
      { wardrobeImageId },
    );
    return this.runDto(run);
  }

  async createWardrobeRecommendation(
    actorId: string,
    input: WardrobeRecommendationInput,
    key: string,
  ) {
    const dailyInput: WardrobeDailyInput = {
      scene: input.scene,
      ...(input.city ? { city: input.city } : {}),
      ...(input.weatherCondition
        ? { weatherCondition: input.weatherCondition }
        : {}),
      ...(input.idea ? { idea: input.idea } : {}),
    };
    let fallback: unknown;
    let context: Prisma.InputJsonObject;
    let candidateResults: unknown[] = [];
    let candidateResultsByDay: Record<string, unknown[]> = {};
    let hasCandidates = false;
    if (input.mode === "TRIP") {
      const trip = await this.wardrobeOutfits.recommendTrip(actorId, {
        scene: input.scene,
        city: input.city!,
        startOn: input.startOn!,
        days: input.days!,
        ...(input.weatherCondition
          ? { weatherCondition: input.weatherCondition }
          : {}),
        ...(input.idea ? { idea: input.idea } : {}),
        candidateLimit: 2,
      });
      const { days, ...tripSummary } = trip;
      hasCandidates = days.some((day) => (day.candidates?.length ?? 0) > 0);
      fallback = {
        ...tripSummary,
        days: days.map(({ candidates: _candidates, ...day }) => day),
      };
      candidateResultsByDay = Object.fromEntries(
        days.map((day) => [day.date, day.candidates ?? []]),
      );
      context = {
        mode: "TRIP",
        scene: input.scene,
        idea: input.idea ?? "",
        city: { name: input.city!.name, timezone: input.city!.timezone },
        days: days.map((day) => ({
          date: day.date,
          weather: day.weather,
          condition: day.condition,
          candidates: (day.candidates ?? []).map((outfit) => ({
            id: `${day.date}:${outfit.id}`,
            outfitId: outfit.id,
            name: outfit.name,
            warnings: outfit.warnings,
            items: outfit.items.map(
              ({
                garmentId,
                name,
                category,
                role,
                color,
                seasons,
                layers,
                stylingAdvice,
              }) => ({
                garmentId,
                name,
                category,
                role,
                color,
                seasons,
                layers,
                stylingAdvice,
              }),
            ),
          })),
        })),
      } as Prisma.InputJsonObject;
    } else {
      const daily = await this.wardrobeOutfits.recommendDaily(actorId, {
        ...dailyInput,
        limit: 12,
      });
      fallback = {
        ...daily,
        recommendations: daily.recommendations.slice(0, 3),
      };
      candidateResults = daily.recommendations;
      hasCandidates = daily.recommendations.length > 0;
      context = {
        mode: "DAILY",
        scene: input.scene,
        idea: input.idea ?? "",
        city: daily.city
          ? { name: daily.city.name, timezone: daily.city.timezone }
          : null,
        weather: daily.weather,
        condition: daily.condition,
        weatherConstraints:
          daily.condition === "COLD" || daily.condition === "RAINY"
            ? "优先保暖／防雨，不能为满足偏好移除必需外层"
            : daily.condition === "WARM"
              ? "避免为了叠穿偏好增加不必要的外层"
              : "适中天气可参考用户的层次偏好",
        candidates: daily.recommendations.map((outfit) => ({
          id: outfit.id,
          name: outfit.name,
          warnings: outfit.warnings,
          items: outfit.items.map(
            ({
              garmentId,
              name,
              category,
              role,
              color,
              seasons,
              layers,
              stylingAdvice,
            }) => ({
              garmentId,
              name,
              category,
              color,
              seasons,
              layers,
              stylingAdvice,
              role,
            }),
          ),
        })),
      } as Prisma.InputJsonObject;
    }

    if (!hasCandidates) {
      return {
        run: { id: null, status: "SUCCEEDED", result: fallback },
        fallback,
        aiUsed: false,
        notice: null,
      };
    }
    const config = validateEnvironment();
    if (config.AI_PROVIDER === "disabled" || !config.AI_API_KEY) {
      return {
        run: { id: null, status: "SUCCEEDED", result: fallback },
        fallback,
        aiUsed: false,
        notice: "AI 尚未配置，已使用规则搭配。",
      };
    }
    try {
      const jobInput = JSON.parse(
        JSON.stringify({
          mode: input.mode,
          context,
          fallback,
          ...(input.mode === "DAILY" ? { candidateResults } : {}),
          ...(input.mode === "TRIP" ? { candidateResultsByDay } : {}),
        }),
      ) as Prisma.InputJsonObject;
      const run = await this.enqueue(
        actorId,
        "WARDROBE_RECOMMENDATION",
        key,
        jobInput,
      );
      return { run: this.runDto(run), fallback, aiUsed: true, notice: null };
    } catch (error) {
      if (
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === "AI_QUOTA_EXCEEDED"
      ) {
        return {
          run: { id: null, status: "SUCCEEDED", result: fallback },
          fallback,
          aiUsed: false,
          notice: "今日 AI 穿搭推荐次数已用完，已使用规则搭配。",
        };
      }
      throw error;
    }
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
      } else if (claimed.type === "ANALYSIS") {
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
      } else if (claimed.type === "WARDROBE_RECOGNITION") {
        const imageId = (claimed.input as { wardrobeImageId: string })
          .wardrobeImageId;
        const image = await this.loadWardrobeImage(claimed.actorId, imageId);
        const account = await this.prisma.account.findUnique({
          where: { id: claimed.actorId },
          select: { gender: true },
        });
        const recognition = await this.provider.recognizeWardrobe({
          image: await this.wardrobeImageStorage.read(image.storageKey),
          mime: image.mimeType,
          gender: account?.gender ?? "UNSPECIFIED",
        });
        usage = recognition.usage;
        result = recognition.data;
      } else if (claimed.type === "WARDROBE_RECOMMENDATION") {
        const input = claimed.input as {
          mode: "DAILY" | "TRIP";
          context: Prisma.JsonObject;
          fallback: Prisma.JsonObject;
          candidateResults?: Array<{ id: string; [key: string]: unknown }>;
          candidateResultsByDay?: Record<
            string,
            Array<{ id: string; [key: string]: unknown }>
          >;
        };
        if (input.mode === "DAILY") {
          const recommendation = await this.provider.recommendDailyWardrobe(
            input.context,
          );
          usage = recommendation.usage;
          const candidates = input.context.candidates as Array<{
            id: string;
          }>;
          const candidateIds = new Set(candidates.map(({ id }) => id));
          const selectedIds = recommendation.data.recommendations.map(
            ({ id }) => id,
          );
          if (
            new Set(selectedIds).size !== selectedIds.length ||
            selectedIds.some((id) => !candidateIds.has(id))
          ) {
            throw Object.assign(new Error("AI_OUTPUT_INVALID"), {
              code: "AI_OUTPUT_INVALID",
              retryable: false,
            });
          }
          const fallback = input.fallback as {
            recommendations: Array<{ id: string }>;
          };
          const allResults = input.candidateResults ?? [];
          const fallbackById = new Map(
            [...fallback.recommendations, ...allResults].map((item) => [
              item.id,
              item,
            ]),
          );
          const recommendations = recommendation.data.recommendations.map(
            ({ id, reason }) => ({ ...fallbackById.get(id), reason }),
          );
          result = {
            ...input.fallback,
            recommendations,
          } as Prisma.InputJsonObject;
        } else {
          const recommendation = await this.provider.recommendTripWardrobe(
            input.context,
          );
          usage = recommendation.usage;
          const tripContext = input.context.days as Array<{
            date: string;
            candidates: Array<{ id: string; outfitId: string }>;
          }>;
          const selections = new Map<string, string>();
          for (const selection of recommendation.data.days) {
            const day = tripContext.find(({ date }) => date === selection.date);
            if (
              !day ||
              !day.candidates.some(({ id }) => id === selection.candidateId) ||
              selections.has(selection.date)
            ) {
              throw Object.assign(new Error("AI_OUTPUT_INVALID"), {
                code: "AI_OUTPUT_INVALID",
                retryable: false,
              });
            }
            selections.set(selection.date, selection.candidateId);
          }
          const tripFallback = input.fallback as {
            days: Array<Record<string, unknown> & { date: string }>;
          };
          const selectedDays = tripFallback.days.map((day) => {
            const selectedId = selections.get(day.date);
            if (!selectedId) return day;
            const sourceDay = tripContext.find(
              ({ date }) => date === day.date,
            )!;
            const selected = sourceDay.candidates.find(
              ({ id }) => id === selectedId,
            )!;
            const fullCandidate = (
              input.candidateResultsByDay?.[day.date] ?? []
            ).find(({ id }) => id === selected.outfitId);
            if (!fullCandidate) {
              throw Object.assign(new Error("AI_OUTPUT_INVALID"), {
                code: "AI_OUTPUT_INVALID",
                retryable: false,
              });
            }
            const reason = recommendation.data.days.find(
              ({ date }) => date === day.date,
            )!.reason;
            return {
              ...day,
              recommendation: { ...fullCandidate, reason },
            };
          });
          result = {
            ...input.fallback,
            days: selectedDays,
          } as Prisma.InputJsonObject;
        }
      } else {
        throw new Error("AI_HANDLER_UNAVAILABLE");
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
      // A recommendation is explicitly a one-click, one-provider-attempt operation.
      // Retrying after a timeout/5xx can incur a second charge if the provider
      // completed the first request but its response was lost.
      if (
        claimed.type !== "WARDROBE_RECOMMENDATION" &&
        retryable(error) &&
        claimed.attempts < MAX_ATTEMPTS
      ) {
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
      if (
        run.type !== "WARDROBE_RECOMMENDATION" &&
        run.attempts < MAX_ATTEMPTS
      ) {
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

  private async loadWardrobeImage(actorId: string, imageId: string) {
    const image = await this.prisma.wardrobeImage.findUnique({
      where: { id: imageId },
      select: {
        uploadedById: true,
        storageKey: true,
        mimeType: true,
        garment: { select: { ownerId: true } },
      },
    });
    if (
      !image ||
      image.uploadedById !== actorId ||
      (image.garment && image.garment.ownerId !== actorId)
    ) {
      throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    }
    return image;
  }
}
