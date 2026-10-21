import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import {
  expenseCategories,
  garmentCreateRequestSchema,
  garmentListQuerySchema,
  garmentPatchRequestSchema,
  outfitCreateRequestSchema,
  outfitPatchRequestSchema,
} from "@homedata/contracts";
import type { PrismaService } from "../../src/shared/database/prisma.service.js";
import { WardrobeImageStorageService } from "../../src/modules/wardrobe/wardrobe-image-storage.service.js";
import { WardrobeService } from "../../src/modules/wardrobe/wardrobe.service.js";
import { WardrobeWeatherService } from "../../src/modules/wardrobe/wardrobe-weather.service.js";
import { FamiliesService } from "../../src/modules/families/families.service.js";
import { WardrobeOutfitService } from "../../src/modules/wardrobe/wardrobe-outfit.service.js";
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";
import type { ReceiptStorageService } from "../../src/modules/ledger/receipt-storage.service.js";

const databaseUrl = "postgresql://homedata:test@127.0.0.1:55438/homedata";
const previousEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_URL,
  wardrobeStoragePath: process.env.WARDROBE_STORAGE_PATH,
};
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPY3dGxu6ODAUIBADMOBy3W07hNAAAAAElFTkSuQmCC",
  "base64",
);
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient | undefined;
let storage: WardrobeImageStorageService;
let wardrobe: WardrobeService;
let ledger: LedgerService;
let clothingCategoryId = "";
let ownerId = "";
let memberId = "";
let familyId = "";
let storagePath = "";

describe("private wardrobe and images", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl;
    storagePath = await mkdtemp(join(tmpdir(), "homedata-wardrobe-"));
    process.env.WARDROBE_STORAGE_PATH = storagePath;
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55438,
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
    const owner = await prisma.account.create({
      data: {
        username: "wardrobe-owner",
        usernameNormalized: "wardrobe-owner",
        nickname: "衣柜主人",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    const member = await prisma.account.create({
      data: {
        username: "wardrobe-member",
        usernameNormalized: "wardrobe-member",
        nickname: "家庭成员",
        passwordHash: "test-only",
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    memberId = member.id;
    const family = await prisma.family.create({
      data: { name: "测试家庭", adminAccountId: ownerId },
    });
    familyId = family.id;
    await prisma.membership.createMany({
      data: [
        { familyId, accountId: ownerId },
        { familyId, accountId: memberId },
      ],
    });
    const clothingCategory = await prisma.category.create({
      data: { ...expenseCategories[3]!, sortOrder: 1 },
    });
    clothingCategoryId = clothingCategory.id;
    storage = new WardrobeImageStorageService();
    ledger = new LedgerService(
      prisma as unknown as PrismaService,
      {} as ReceiptStorageService,
    );
    wardrobe = new WardrobeService(
      prisma as unknown as PrismaService,
      storage,
      ledger,
    );
  });

  afterAll(async () => {
    if (prisma) {
      const images = await prisma.wardrobeImage.findMany({
        select: { storageKey: true, thumbnailKey: true },
      });
      for (const image of images)
        await storage.removeImage(image.storageKey, image.thumbnailKey);
      await prisma.$disconnect();
    }
    await socketServer?.stop();
    await database?.close();
    await rm(storagePath, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      const envKey =
        key === "nodeEnv"
          ? "NODE_ENV"
          : key === "databaseUrl"
            ? "DATABASE_URL"
            : "WARDROBE_STORAGE_PATH";
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it("resizes uploaded photos into a private main image and thumbnail", async () => {
    const uploaded = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const main = await wardrobe.imageContent(uploaded.id, ownerId, undefined);
    const thumb = await wardrobe.imageContent(
      uploaded.id,
      ownerId,
      "thumbnail",
    );
    expect(uploaded.mimeType).toBe("image/webp");
    expect(main.mimeType).toBe("image/webp");
    expect(thumb.buffer.length).toBeGreaterThan(0);
    await expect(
      wardrobe.imageContent(uploaded.id, memberId, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    await prisma!.wardrobeImage.update({
      where: { id: uploaded.id },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
    expect(await wardrobe.cleanupTemporaryImages()).toEqual({ purged: 1 });
    await expect(
      wardrobe.imageContent(uploaded.id, ownerId, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("keeps every garment owner-only, including legacy family-shared records", async () => {
    const privateImage = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const privateGarment = garmentCreateRequestSchema.parse({
      name: "春秋针织衫",
      category: "TOP",
      ownerId,
      mainImageId: privateImage.id,
      seasons: ["SPRING", "AUTUMN"],
      layers: ["INNER"],
      scenes: ["CASUAL"],
      status: "WEARABLE",
      acquiredOn: "2025-03-08",
      expenseMode: "NONE",
    });
    const createdPrivate = await wardrobe.createGarment(
      ownerId,
      privateGarment,
      randomUUID(),
    );
    expect(createdPrivate.seasons).toEqual(["SPRING", "AUTUMN"]);
    await expect(
      wardrobe.getGarment(createdPrivate.id, memberId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      wardrobe.imageContent(privateImage.id, memberId, "thumbnail"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const legacyImage = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const memberMembership = await prisma!.membership.findFirstOrThrow({
      where: { familyId, accountId: memberId, leftAt: null },
    });
    const legacyShared = await prisma!.garment.create({
      data: {
        ownerId,
        createdById: ownerId,
        familyId,
        mainImageId: legacyImage.id,
        name: "旧家庭共享外套",
        category: "OUTERWEAR",
        seasons: ["AUTUMN", "WINTER"],
        layers: ["OUTER"],
        scenes: ["COMMUTE"],
        status: "WEARABLE",
        visibility: "FAMILY",
        shares: { create: { membershipId: memberMembership.id } },
      },
    });
    await database!.exec(
      await readFile(
        resolve(
          process.cwd(),
          "prisma/migrations/20261021000000_wardrobe_owner_only/migration.sql",
        ),
        "utf8",
      ),
    );
    const migratedLegacy = await prisma!.garment.findUniqueOrThrow({
      where: { id: legacyShared.id },
    });
    expect(migratedLegacy.visibility).toBe("PRIVATE");
    expect(migratedLegacy.familyId).toBeNull();
    expect(
      await prisma!.garmentShare.count({
        where: { garmentId: legacyShared.id },
      }),
    ).toBe(0);
    await expect(
      wardrobe.getGarment(legacyShared.id, memberId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      wardrobe.imageContent(legacyImage.id, memberId, "thumbnail"),
    ).rejects.toBeInstanceOf(NotFoundException);
    const familyList = await wardrobe.listGarments(
      memberId,
      garmentListQuerySchema.parse({ space: "family", familyId }),
    );
    expect(familyList.items.map(({ id }) => id)).not.toContain(legacyShared.id);
    expect(familyList.items.map(({ id }) => id)).not.toContain(
      createdPrivate.id,
    );
    const downgraded = await wardrobe.updateGarment(
      legacyShared.id,
      ownerId,
      garmentPatchRequestSchema.parse({
        version: legacyShared.version,
        name: "仅本人可见的外套",
      }),
    );
    expect(downgraded.visibility).toBe("PRIVATE");
    expect(downgraded.familyId).toBeNull();
    expect(
      await prisma!.garmentShare.count({
        where: { garmentId: legacyShared.id },
      }),
    ).toBe(0);
  });

  it("rejects invalid image bytes and allows owner edits and soft removal", async () => {
    await expect(
      wardrobe.uploadImage(ownerId, {
        buffer: Buffer.from("not an image"),
        size: 12,
      }),
    ).rejects.toMatchObject({ code: "WARDROBE_IMAGE_DECODE_FAILED" });
    const image = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const garment = await wardrobe.createGarment(
      ownerId,
      garmentCreateRequestSchema.parse({
        name: "状态测试衣物",
        category: "BOTTOM",
        ownerId,
        mainImageId: image.id,
        seasons: [],
        layers: [],
        scenes: [],
        expenseMode: "NONE",
      }),
      randomUUID(),
    );
    const updated = await wardrobe.updateGarment(
      garment.id,
      ownerId,
      garmentPatchRequestSchema.parse({
        version: garment.version,
        status: "STORED",
        seasons: ["SPRING", "SUMMER"],
      }),
    );
    expect(updated.status).toBe("STORED");
    expect(updated.seasons).toEqual(["SPRING", "SUMMER"]);
    await wardrobe.deleteGarment(garment.id, ownerId, updated.version);
    await expect(
      wardrobe.getGarment(garment.id, ownerId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not accept image identifiers or owners from another account", async () => {
    const image = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const foreignOwnerInput = garmentCreateRequestSchema.parse({
      name: "越权尝试",
      category: "TOP",
      ownerId: memberId,
      mainImageId: image.id,
      seasons: [],
      layers: [],
      scenes: [],
      expenseMode: "NONE",
    });
    await expect(
      wardrobe.createGarment(ownerId, foreignOwnerInput, randomUUID()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const foreignImage = await wardrobe.uploadImage(memberId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    await expect(
      wardrobe.createGarment(
        ownerId,
        garmentCreateRequestSchema.parse({
          name: "错误图片归属",
          category: "TOP",
          ownerId,
          mainImageId: foreignImage.id,
          seasons: [],
          layers: [],
          scenes: [],
          expenseMode: "NONE",
        }),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("atomically records a purchase, gifts ownership, and replays by idempotency key", async () => {
    for (const accountId of [ownerId, memberId]) {
      if (
        !(await prisma!.membership.findFirst({
          where: { familyId, accountId, leftAt: null },
        }))
      ) {
        await prisma!.membership.create({ data: { familyId, accountId } });
      }
    }
    const image = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const receiptId = randomUUID();
    await prisma!.receipt.create({
      data: {
        id: receiptId,
        uploadedById: ownerId,
        storageKey: `receipt-${receiptId}.webp`,
        mimeType: "image/webp",
        sizeBytes: imageBytes.length,
        contentHash: "c".repeat(64),
      },
    });
    const input = garmentCreateRequestSchema.parse({
      name: "送给家庭成员的外套",
      category: "OUTERWEAR",
      ownerId: memberId,
      recipientFamilyId: familyId,
      mainImageId: image.id,
      stylingAdvice: "适合通勤，可搭配简洁下装。",
      seasons: ["WINTER"],
      layers: ["OUTER"],
      scenes: ["CASUAL"],
      expenseMode: "NEW",
      expense: {
        title: "冬季外套",
        categoryId: clothingCategoryId,
        occurredOn: "2026-10-20",
        amount: "89.90",
        receiptId,
        confirmReceiptFamilyVisible: false,
      },
    });
    const invalidInput = garmentCreateRequestSchema.parse({
      category: input.category,
      ownerId: input.ownerId,
      recipientFamilyId: input.recipientFamilyId,
      mainImageId: input.mainImageId,
      seasons: input.seasons,
      layers: input.layers,
      scenes: input.scenes,
      status: input.status,
      name: "失败回滚测试",
      expenseMode: "NEW",
      expense: {
        title: "冬季外套",
        categoryId: randomUUID(),
        occurredOn: "2026-10-20",
        amount: "89.90",
      },
    });
    await expect(
      wardrobe.createGarment(ownerId, invalidInput, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma!.garment.count({ where: { name: "失败回滚测试" } }),
    ).toBe(0);
    expect(await prisma!.expense.count({ where: { title: "冬季外套" } })).toBe(
      0,
    );
    const key = "8bf713a4-dc22-4c9a-a9a6-3ec47134c4bf";
    const first = await wardrobe.createGarment(ownerId, input, key);
    const retry = await wardrobe.createGarment(ownerId, input, key);
    expect(retry.id).toBe(first.id);
    const expense = await prisma!.expense.findFirstOrThrow({
      where: { title: "冬季外套" },
    });
    const garment = await prisma!.garment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(expense.payerId).toBe(ownerId);
    expect(expense.amountCents).toBe(8990n);
    expect(garment.ownerId).toBe(memberId);
    expect(garment.createdById).toBe(ownerId);
    expect(garment.stylingAdvice).toBe("适合通勤，可搭配简洁下装。");
    expect(first.stylingAdvice).toBe("适合通勤，可搭配简洁下装。");
    expect(garment.expenseId).toBe(expense.id);
    expect(
      await prisma!.receiptLink.findUnique({
        where: { receiptId_expenseId: { receiptId, expenseId: expense.id } },
      }),
    ).not.toBeNull();
    expect(
      (await prisma!.receipt.findUniqueOrThrow({ where: { id: receiptId } }))
        .privacyLock,
    ).toBe("PRIVATE");
    expect((await wardrobe.getGarment(garment.id, memberId)).name).toBe(
      "送给家庭成员的外套",
    );
    await expect(
      wardrobe.getGarment(garment.id, ownerId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(ledger.get(expense.id, memberId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      wardrobe.updateGarment(
        garment.id,
        ownerId,
        garmentPatchRequestSchema.parse({ version: 1, name: "未授权修改" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const secondImage = await wardrobe.uploadImage(ownerId, {
      buffer: imageBytes,
      size: imageBytes.length,
    });
    const secondInput = garmentCreateRequestSchema.parse({
      category: input.category,
      ownerId: input.ownerId,
      recipientFamilyId: input.recipientFamilyId,
      name: "同一账单的第二件衣物",
      mainImageId: secondImage.id,
      seasons: input.seasons,
      layers: input.layers,
      scenes: input.scenes,
      status: input.status,
      expenseMode: "EXISTING",
      expenseId: expense.id,
    });
    const second = await wardrobe.createGarment(
      ownerId,
      secondInput,
      "6c174e67-7de8-4a0d-81e1-9863137d070d",
    );
    expect(
      await prisma!.garment.count({ where: { expenseId: expense.id } }),
    ).toBe(2);
    expect(await prisma!.expense.count({ where: { title: "冬季外套" } })).toBe(
      1,
    );
    expect(second.ownerId).toBe(memberId);
  });

  it("disambiguates locations and caches local-day forecasts with explicit missing days", async () => {
    const families = new FamiliesService(prisma as unknown as PrismaService);
    const currentFamily = await prisma!.family.findUniqueOrThrow({
      where: { id: familyId },
    });
    const updatedFamily = await families.setDefaultCity(familyId, ownerId, {
      version: currentFamily.version,
      city: {
        name: "城市 A · 省份 · 中国",
        countryCode: "CN",
        latitude: 31.2,
        longitude: 121.4,
        timezone: "Asia/Shanghai",
      },
    });
    expect(updatedFamily?.defaultCity?.name).toContain("城市 A");
    await expect(
      families.setDefaultCity(familyId, randomUUID(), {
        version: currentFamily.version + 1,
        city: null,
      }),
    ).rejects.toMatchObject({ response: { code: "FAMILY_NOT_FOUND" } });
    const weather = new WardrobeWeatherService(
      prisma as unknown as PrismaService,
    );
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const times = Array.from({ length: 16 }, (_, index) => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("geocoding-api")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                name: "Springfield",
                admin1: "State A",
                country: "Country A",
                country_code: "aa",
                latitude: 31.2,
                longitude: 121.4,
                timezone: "Asia/Shanghai",
              },
              {
                name: "Springfield",
                admin1: "State B",
                country: "Country B",
                country_code: "bb",
                latitude: 40.2,
                longitude: -70.4,
                timezone: "America/New_York",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          daily: {
            time: times,
            temperature_2m_max: times.map(() => 20),
            temperature_2m_min: times.map(() => 10),
            apparent_temperature_max: times.map(() => 19),
            apparent_temperature_min: times.map(() => 9),
            precipitation_sum: times.map(() => 0),
            weather_code: times.map(() => 1),
            wind_speed_10m_max: times.map(() => 8),
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", request);
    try {
      const locations = await weather.searchLocations("Springfield");
      expect(locations).toHaveLength(2);
      expect(locations[0]!.name).toContain("State A");
      const city = {
        name: "Springfield · State A · Country A",
        countryCode: "AA",
        latitude: 31.2,
        longitude: 121.4,
        timezone: "Asia/Shanghai",
      };
      const result = await weather.forecast({
        city,
        startDate: today,
        days: 30,
      });
      expect(result.days[0]).toMatchObject({
        date: today,
        available: true,
        temperatureMax: 20,
      });
      expect(result.days[29]).toMatchObject({
        available: false,
        temperatureMax: null,
      });
      expect(result.attribution).toContain("Open-Meteo");
      await weather.forecast({ city, startDate: today, days: 2 });
      expect(request).toHaveBeenCalledTimes(2);
      await prisma!.wardrobeWeatherCache.updateMany({
        where: { locationKey: "31.2000,121.4000,Asia/Shanghai" },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      request.mockRejectedValueOnce(new Error("offline"));
      const stale = await weather.forecast({ city, startDate: today, days: 1 });
      expect(stale.isStale).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds a layered rule-based outfit and invalidates it when an item changes state", async () => {
    const weather = new WardrobeWeatherService(
      prisma as unknown as PrismaService,
    );
    const outfits = new WardrobeOutfitService(
      prisma as unknown as PrismaService,
      weather,
    );
    const addGarment = async (
      name: string,
      category: "TOP" | "OUTERWEAR" | "BOTTOM" | "SHOES",
      layers: Array<"INNER" | "MID" | "OUTER">,
    ) => {
      const image = await wardrobe.uploadImage(ownerId, {
        buffer: imageBytes,
        size: imageBytes.length,
      });
      return wardrobe.createGarment(
        ownerId,
        garmentCreateRequestSchema.parse({
          name,
          category,
          ownerId,
          mainImageId: image.id,
          seasons: ["AUTUMN"],
          layers,
          scenes: ["CASUAL"],
          expenseMode: "NONE",
        }),
        randomUUID(),
      );
    };
    const inner = await addGarment("内搭衫", "TOP", ["INNER"]);
    const mid = await addGarment("针织中层", "TOP", ["MID"]);
    const bottom = await addGarment("长裤", "BOTTOM", []);
    const shoes = await addGarment("运动鞋", "SHOES", []);
    const outer = await addGarment("薄外套", "OUTERWEAR", ["OUTER"]);
    const ideaResult = await outfits.recommendDaily(ownerId, {
      scene: "CASUAL",
      weatherCondition: "MILD",
      idea: "想叠穿",
    });
    expect(
      ideaResult.recommendations.some((candidate) =>
        candidate.items.some(({ role }) => role === "OUTER"),
      ),
    ).toBe(true);
    expect(ideaResult.recommendations[0]?.reason).toContain("想叠穿");
    expect(ideaResult.recommendations[0]?.reason).toContain("休闲场景");

    const noOuterIdea = await outfits.recommendDaily(ownerId, {
      scene: "CASUAL",
      weatherCondition: "MILD",
      idea: "不需要外套",
    });
    expect(
      noOuterIdea.recommendations.every((candidate) =>
        candidate.items.every(({ role }) => role !== "OUTER"),
      ),
    ).toBe(true);

    const result = await outfits.recommendDaily(ownerId, {
      scene: "CASUAL",
      weatherCondition: "COLD",
    });
    expect(result.recommendations.length).toBeGreaterThan(0);
    const recommendation = result.recommendations.find((candidate) =>
      candidate.items.some(({ role }) => role === "MID"),
    );
    expect(recommendation?.items.map(({ role }) => role)).toEqual(
      expect.arrayContaining(["TOP", "MID", "BOTTOM", "SHOES", "OUTER"]),
    );
    const selectedMid = recommendation!.items.find(
      ({ role }) => role === "MID",
    )!;
    const saved = await outfits.create(
      ownerId,
      outfitCreateRequestSchema.parse({
        name: "冷天叠穿",
        scene: "CASUAL",
        items: recommendation!.items.map(({ garmentId, role, sortOrder }) => ({
          garmentId,
          role,
          sortOrder,
        })),
      }),
    );
    expect(saved.valid).toBe(true);
    await wardrobe.updateGarment(
      selectedMid.garmentId,
      ownerId,
      garmentPatchRequestSchema.parse({
        version: (await wardrobe.getGarment(selectedMid.garmentId, ownerId))
          .version,
        status: "LAUNDERING",
      }),
    );
    expect(
      (await outfits.list(ownerId)).find(({ id }) => id === saved.id)?.valid,
    ).toBe(false);
    const renamed = await outfits.update(
      saved.id,
      ownerId,
      outfitPatchRequestSchema.parse({
        version: saved.version,
        name: "冬季叠穿",
      }),
    );
    expect(renamed.name).toBe("冬季叠穿");
    expect(
      await outfits.remove(saved.id, ownerId, renamed.version),
    ).toMatchObject({
      deleted: true,
    });
  });

  it("builds one rule-based recommendation per trip day and marks missing weather", async () => {
    const weather = new WardrobeWeatherService(
      prisma as unknown as PrismaService,
    );
    const outfits = new WardrobeOutfitService(
      prisma as unknown as PrismaService,
      weather,
    );
    const city = {
      name: "京都 · 京都府 · 日本",
      countryCode: "JP",
      latitude: 35.0116,
      longitude: 135.7681,
      timezone: "Asia/Tokyo",
    };
    const startOn = new Date().toISOString().slice(0, 10);
    const forecastDay = {
      date: startOn,
      available: true,
      temperatureMax: 12,
      temperatureMin: 4,
      apparentTemperatureMax: 12,
      apparentTemperatureMin: 3,
      precipitationMm: 0,
      weatherCode: 0,
      windSpeedMax: 10,
    };
    vi.spyOn(weather, "forecast").mockResolvedValue({
      city,
      timezone: city.timezone,
      days: [forecastDay],
      source: "Open-Meteo",
      attribution: "天气数据：Open-Meteo（CC BY 4.0）",
      fetchedAt: new Date(),
      isStale: false,
      forecastThrough: startOn,
    });
    const recommendDaily = vi.spyOn(outfits, "recommendDaily");
    const result = await outfits.recommendTrip(ownerId, {
      scene: "CASUAL",
      city,
      startOn,
      days: 18,
      idea: "想叠穿",
    });
    expect(recommendDaily).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({ idea: "想叠穿" }),
    );
    expect(weather.forecast).toHaveBeenCalledTimes(1);
    expect(result.days).toHaveLength(18);
    expect(result.days[0]).toMatchObject({
      date: startOn,
      weather: forecastDay,
      weatherMissing: false,
    });
    expect(result.days[17]).toMatchObject({
      weather: null,
      weatherMissing: true,
    });
  });
});
