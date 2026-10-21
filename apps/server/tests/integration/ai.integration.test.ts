import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import { expenseCategories } from "@homedata/contracts";
import { AiProvider } from "../../src/modules/ai/ai-provider.js";
import { AiService } from "../../src/modules/ai/ai.service.js";
import { ReportsService } from "../../src/modules/reports/reports.service.js";
import type { PrismaService } from "../../src/shared/database/prisma.service.js";

const databaseUrl = "postgresql://homedata:test@127.0.0.1:55437/homedata";
const oldEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_URL,
  aiProvider: process.env.AI_PROVIDER,
  aiApiKey: process.env.AI_API_KEY,
};
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient | undefined;
let ai: AiService;
let accountId = "";
let categoryId = "";
let extractReceipt: ReturnType<typeof vi.fn>;
let recommendDailyWardrobe: ReturnType<typeof vi.fn>;
let recommendTripWardrobe: ReturnType<typeof vi.fn>;

const input = {
  space: "personal" as const,
  origin: "all" as const,
  from: "2026-10-01",
  to: "2026-10-31",
  period: "month" as const,
  granularity: "day" as const,
  basis: "net" as const,
};

describe("user-triggered AI runs", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl;
    process.env.AI_PROVIDER = "deepseek";
    process.env.AI_API_KEY = "test-only-key";
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55437,
    });
    await socketServer.start();
    for (const migration of [
      "20261015000000_init/migration.sql",
      "20261015010000_identity/migration.sql",
      "20261015010100_family_default_city/migration.sql",
      "20261015020000_ledger/migration.sql",
      "20261015030000_tasks_recurring/migration.sql",
      "20261015040000_recurring_effective_period/migration.sql",
      "20261015050000_share_snapshots/migration.sql",
      "20261015060000_ai_runs/migration.sql",
      "20261020000000_wardrobe_core/migration.sql",
      "20261021000000_wardrobe_owner_only/migration.sql",
      "20261021010000_wardrobe_styling_advice/migration.sql",
    ]) {
      await database.exec(
        await readFile(
          resolve(process.cwd(), "prisma/migrations", migration),
          "utf8",
        ),
      );
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    accountId = (
      await prisma.account.create({
        data: {
          username: "ai-owner",
          usernameNormalized: "ai-owner",
          nickname: "用户姓名不进入模型",
          passwordHash: "test-only",
          mustChangePassword: false,
        },
      })
    ).id;
    const category = await prisma.category.create({
      data: { ...expenseCategories[3]!, sortOrder: 1 },
    });
    categoryId = category.id;
    await prisma.expense.create({
      data: {
        payerId: accountId,
        categoryId: category.id,
        title: "私人商户和条目名称不进入模型",
        occurredOn: new Date("2026-10-12T00:00:00.000Z"),
        amountCents: 1299n,
      },
    });
    const client = prisma as unknown as PrismaService;
    extractReceipt = vi.fn(async () => ({
      data: {
        occurredOn: "2026-10-12",
        totalAmount: "12.99",
        items: [
          {
            title: "日常用品",
            categoryCode: expenseCategories[3]!.code,
            amount: "12.99",
            quantity: null,
            unit: null,
            unitPrice: null,
            confidence: 0.96,
          },
        ],
        thingsToVerify: [],
      },
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    }));
    const provider = {
      analyze: vi.fn(async (value: unknown) => {
        const evidence = (value as { evidence: Array<{ id: string }> })
          .evidence;
        const id = evidence[0]?.id;
        return {
          data: {
            changes: id
              ? [
                  {
                    title: "分类有支出",
                    description: "这段变化来自统计数据。",
                    evidenceIds: [id],
                  },
                ]
              : [],
            evidence: id ? [{ id, label: "模型不能自定义金额" }] : [],
            thingsToVerify: ["请结合实际情况核对。"],
          },
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        };
      }),
      extractReceipt,
      recognizeWardrobe: vi.fn(async () => ({
        data: {
          name: "米色针织衫",
          category: "TOP",
          color: "米色",
          stylingAdvice: "适合日常通勤，可搭配简洁的下装与外套。",
          seasons: ["SPRING", "AUTUMN"],
          layers: ["MID"],
          scenes: ["CASUAL"],
          thingsToVerify: [],
        },
        usage: { prompt_tokens: 60, completion_tokens: 20 },
      })),
      recommendDailyWardrobe: (recommendDailyWardrobe = vi.fn(
        async (value: unknown) => {
          expect(value).toMatchObject({
            idea: "需要叠穿",
            scene: "CASUAL",
            condition: "MILD",
            candidates: [
              {
                id: "daily-1",
                items: [
                  {
                    name: "针织衫",
                    role: "TOP",
                    stylingAdvice: "适合日常通勤，可搭配简洁下装。",
                  },
                ],
              },
            ],
          });
          return {
            data: {
              recommendations: [
                { id: "daily-1", reason: "根据你的叠穿想法选择了这套组合。" },
              ],
            },
            usage: { prompt_tokens: 180, completion_tokens: 40 },
          };
        },
      )),
      recommendTripWardrobe: (recommendTripWardrobe = vi.fn(
        async (value: unknown) => {
          expect(value).toMatchObject({
            scene: "CASUAL",
            idea: "需要叠穿",
            days: [
              {
                date: "2026-10-22",
                condition: "COLD",
                candidates: [
                  { id: "2026-10-22:daily-1" },
                  { id: "2026-10-22:daily-2" },
                ],
              },
            ],
          });
          return {
            data: {
              days: [
                {
                  date: "2026-10-22",
                  candidateId: "2026-10-22:daily-2",
                  reason: "这天按你的想法选择了更适合降温的外套组合。",
                },
              ],
            },
            usage: { prompt_tokens: 240, completion_tokens: 50 },
          };
        },
      )),
    } as unknown as AiProvider;
    const candidate = {
      id: "daily-1",
      name: "休闲搭配 1",
      scene: "CASUAL",
      score: 10,
      warnings: [],
      reason: "规则版理由",
      items: [
        {
          garmentId: randomUUID(),
          role: "TOP",
          sortOrder: 0,
          name: "针织衫",
          category: "TOP",
          stylingAdvice: "适合日常通勤，可搭配简洁下装。",
          imageUrl: "/api/v1/wardrobe/images/test/content?size=thumbnail",
        },
      ],
    };
    const wardrobeOutfits = {
      recommendDaily: vi.fn(async () => ({
        date: "2026-10-21",
        scene: "CASUAL",
        city: null,
        weather: null,
        weatherSource: null,
        weatherError: null,
        condition: "MILD",
        recommendations: [{ ...candidate }],
        message: null,
      })),
      recommendTrip: vi.fn(
        async (_actorId: string, value: { startOn: string }) => {
          const first = { ...candidate, id: "daily-1" };
          const second = {
            ...candidate,
            id: "daily-2",
            name: "休闲搭配 2",
            items: candidate.items.map((item) => ({
              ...item,
              name: "轻薄外套",
              role: "OUTER",
            })),
          };
          return {
            city: {
              name: "京都",
              countryCode: "JP",
              latitude: 35,
              longitude: 135,
              timezone: "Asia/Tokyo",
            },
            timezone: "Asia/Tokyo",
            startOn: value.startOn,
            days: [
              {
                date: value.startOn,
                weather: null,
                condition: "COLD",
                recommendation: first,
                candidates: [first, second],
                message: null,
                weatherMissing: true,
              },
            ],
            weatherSource: null,
            weatherAttribution: null,
            weatherFetchedAt: null,
            weatherStale: false,
            weatherError: null,
          };
        },
      ),
    };
    ai = new AiService(
      client,
      { read: async () => Buffer.from("private-image-bytes") } as never,
      new ReportsService(client),
      provider,
      { read: async () => Buffer.from("private-wardrobe-image") } as never,
      wardrobeOutfits as never,
    );
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await socketServer?.stop();
    await database?.close();
    for (const [key, value] of Object.entries({
      NODE_ENV: oldEnvironment.nodeEnv,
      DATABASE_URL: oldEnvironment.databaseUrl,
      AI_PROVIDER: oldEnvironment.aiProvider,
      AI_API_KEY: oldEnvironment.aiApiKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reserves one daily analysis, sanitizes input, and stores server-bound evidence", async () => {
    const key = randomUUID();
    const run = await ai.createAnalysis(accountId, input, key);
    expect(run.status).toBe("PENDING");
    const stored = await prisma!.aiRun.findUniqueOrThrow({
      where: { id: run.id! },
    });
    const serializedInput = JSON.stringify(stored.input);
    expect(serializedInput).not.toContain("私人商户和条目名称");
    expect(serializedInput).not.toContain("用户姓名不进入模型");
    const duplicate = await ai.createAnalysis(accountId, input, key);
    expect(duplicate.id).toBe(run.id);
    await expect(
      ai.createAnalysis(accountId, { ...input, from: "2026-10-02" }, key),
    ).rejects.toMatchObject({ response: { code: "IDEMPOTENCY_MISMATCH" } });

    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, run.id!);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toMatchObject({
      evidence: [{ value: "12.99" }],
    });
    const usage = await prisma!.aiDailyUsage.findFirstOrThrow({
      where: { accountId, bucket: "analysis" },
    });
    expect(usage).toMatchObject({ reserved: 0, succeeded: 1 });
  });

  it("returns a deterministic no-data result without creating an AI run", async () => {
    const empty = await ai.createAnalysis(
      accountId,
      { ...input, from: "2025-10-01", to: "2025-10-31" },
      randomUUID(),
    );
    expect(empty.id).toBeNull();
    expect(empty.status).toBe("SUCCEEDED");
    expect(empty.result).toMatchObject({ changes: [], evidence: [] });
    expect(await prisma!.aiRun.count()).toBe(1);
  });

  it("turns the selected private receipt into a review draft, never an expense", async () => {
    const receipt = await prisma!.receipt.create({
      data: {
        uploadedById: accountId,
        storageKey: "private-test.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 128,
        contentHash: "a".repeat(64),
      },
    });
    const run = await ai.createReceiptExtraction(
      accountId,
      receipt.id,
      randomUUID(),
    );
    expect(run.status).toBe("PENDING");
    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, run.id);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toMatchObject({
      receiptId: receipt.id,
      items: [{ title: "日常用品", categoryId, amount: "12.99" }],
    });
    expect(await prisma!.expense.count()).toBe(1);
    expect(extractReceipt).toHaveBeenCalledOnce();
  });

  it("recognizes an owned temporary wardrobe image into a reviewable draft", async () => {
    const image = await prisma!.wardrobeImage.create({
      data: {
        uploadedById: accountId,
        storageKey: `wardrobe/${randomUUID()}.webp`,
        thumbnailKey: `wardrobe/${randomUUID()}-thumb.webp`,
        mimeType: "image/webp",
        sizeBytes: 64,
        width: 32,
        height: 48,
        contentHash: randomUUID()
          .replaceAll("-", "a")
          .slice(0, 64)
          .padEnd(64, "a"),
      },
    });
    const run = await ai.createWardrobeRecognition(
      accountId,
      image.id,
      randomUUID(),
    );
    expect(run.status).toBe("PENDING");
    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, run.id);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toMatchObject({
      name: "米色针织衫",
      category: "TOP",
      stylingAdvice: "适合日常通勤，可搭配简洁的下装与外套。",
      seasons: ["SPRING", "AUTUMN"],
    });
    expect(await prisma!.expense.count()).toBe(1);
    expect(
      await prisma!.aiDailyUsage.findFirstOrThrow({
        where: { accountId, bucket: "wardrobe_recognition" },
      }),
    ).toMatchObject({ reserved: 0, succeeded: 1 });
  });

  it("sends a user-entered outfit idea with candidates and stores AI selection", async () => {
    const key = randomUUID();
    const queued = await ai.createWardrobeRecommendation(
      accountId,
      {
        mode: "DAILY",
        scene: "CASUAL",
        idea: "需要叠穿",
        idempotencyKey: key,
      },
      key,
    );
    expect(queued.aiUsed).toBe(true);
    expect(queued.run.status).toBe("PENDING");
    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, queued.run.id!);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toMatchObject({
      recommendations: [
        {
          id: "daily-1",
          reason: "根据你的叠穿想法选择了这套组合。",
        },
      ],
    });
    const usage = await prisma!.aiDailyUsage.findFirstOrThrow({
      where: { accountId, bucket: "wardrobe_recommendation" },
    });
    expect(usage).toMatchObject({ reserved: 0, succeeded: 1 });
  });

  it("aggregates a trip into one AI run and selects only that day's candidates", async () => {
    const key = randomUUID();
    const queued = await ai.createWardrobeRecommendation(
      accountId,
      {
        mode: "TRIP",
        scene: "CASUAL",
        city: {
          name: "京都",
          countryCode: "JP",
          latitude: 35,
          longitude: 135,
          timezone: "Asia/Tokyo",
        },
        startOn: "2026-10-22",
        days: 1,
        idea: "需要叠穿",
        idempotencyKey: key,
      },
      key,
    );
    expect(queued.aiUsed).toBe(true);
    expect(
      await prisma!.aiRun.count({ where: { type: "WARDROBE_RECOMMENDATION" } }),
    ).toBe(2);
    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, queued.run.id!);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toMatchObject({
      days: [
        {
          date: "2026-10-22",
          recommendation: {
            id: "daily-2",
            reason: "这天按你的想法选择了更适合降温的外套组合。",
          },
        },
      ],
    });
    expect(recommendTripWardrobe).toHaveBeenCalledOnce();
  });

  it("rejects model-invented outfit ids and releases the recommendation quota", async () => {
    recommendDailyWardrobe.mockResolvedValueOnce({
      data: {
        recommendations: [
          { id: "not-in-the-closet", reason: "模型不允许发明衣物。" },
        ],
      },
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const key = randomUUID();
    const queued = await ai.createWardrobeRecommendation(
      accountId,
      {
        mode: "DAILY",
        scene: "CASUAL",
        idea: "需要叠穿",
        idempotencyKey: key,
      },
      key,
    );
    expect(await ai.processNext()).toBe(true);
    const failed = await ai.getRun(accountId, queued.run.id!);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("AI_OUTPUT_INVALID");
    expect(
      await prisma!.aiDailyUsage.findFirstOrThrow({
        where: { accountId, bucket: "wardrobe_recommendation" },
      }),
    ).toMatchObject({ reserved: 0, succeeded: 2 });
  });

  it("does not retry a transient wardrobe recommendation provider failure", async () => {
    recommendDailyWardrobe.mockRejectedValueOnce({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    const key = randomUUID();
    const queued = await ai.createWardrobeRecommendation(
      accountId,
      {
        mode: "DAILY",
        scene: "CASUAL",
        idea: "需要叠穿",
        idempotencyKey: key,
      },
      key,
    );

    expect(await ai.processNext()).toBe(true);
    const failed = await ai.getRun(accountId, queued.run.id!);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(recommendDailyWardrobe).toHaveBeenCalledOnce();
    expect(
      await prisma!.aiDailyUsage.findFirstOrThrow({
        where: { accountId, bucket: "wardrobe_recommendation" },
      }),
    ).toMatchObject({ reserved: 0 });
  });

  it("falls back to rules after the shared daily recommendation quota is used", async () => {
    for (let index = 0; index < 3; index += 1) {
      const key = randomUUID();
      const queued = await ai.createWardrobeRecommendation(
        accountId,
        {
          mode: "DAILY",
          scene: "CASUAL",
          idea: "需要叠穿",
          idempotencyKey: key,
        },
        key,
      );
      expect(queued.aiUsed).toBe(true);
      expect(await ai.processNext()).toBe(true);
    }
    const key = randomUUID();
    const limited = await ai.createWardrobeRecommendation(
      accountId,
      {
        mode: "DAILY",
        scene: "CASUAL",
        idea: "需要叠穿",
        idempotencyKey: key,
      },
      key,
    );
    expect(limited.aiUsed).toBe(false);
    expect(limited.notice).toContain("次数已用完");
    expect(limited.run.result).toMatchObject({
      recommendations: [{ id: "daily-1", reason: "规则版理由" }],
    });
  });

  it("revokes a pending recognition after its image is gifted to another owner", async () => {
    const recipient = await prisma!.account.create({
      data: {
        username: "wardrobe-recipient",
        usernameNormalized: "wardrobe-recipient",
        nickname: "收衣人",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    const image = await prisma!.wardrobeImage.create({
      data: {
        uploadedById: accountId,
        storageKey: `wardrobe/${randomUUID()}.webp`,
        thumbnailKey: `wardrobe/${randomUUID()}-thumb.webp`,
        mimeType: "image/webp",
        sizeBytes: 64,
        width: 32,
        height: 48,
        contentHash: randomUUID()
          .replaceAll("-", "b")
          .slice(0, 64)
          .padEnd(64, "b"),
      },
    });
    const run = await ai.createWardrobeRecognition(
      accountId,
      image.id,
      randomUUID(),
    );
    await prisma!.garment.create({
      data: {
        ownerId: recipient.id,
        createdById: accountId,
        mainImageId: image.id,
        name: "转交给家庭成员",
        category: "TOP",
        visibility: "PRIVATE",
      },
    });
    expect(await ai.processNext()).toBe(true);
    const completed = await ai.getRun(accountId, run.id);
    expect(completed.status).toBe("FAILED");
    expect(completed.errorCode).toBe("WARDROBE_IMAGE_NOT_FOUND");
  });

  it("limits active plus completed requests in the Beijing business day", async () => {
    for (let index = 0; index < 4; index += 1) {
      await ai.createAnalysis(accountId, input, randomUUID());
    }
    await expect(
      ai.createAnalysis(accountId, input, randomUUID()),
    ).rejects.toMatchObject({
      response: { code: "AI_QUOTA_EXCEEDED" },
    });
  });
});
