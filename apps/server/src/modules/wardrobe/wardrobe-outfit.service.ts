import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import {
  outfitCreateRequestSchema,
  outfitPatchRequestSchema,
  wardrobeCitySchema,
} from "@homedata/contracts";
import type { z } from "zod";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { WardrobeWeatherService } from "./wardrobe-weather.service.js";

type CreateInput = z.infer<typeof outfitCreateRequestSchema>;
type PatchInput = z.infer<typeof outfitPatchRequestSchema>;
type Scene = "COMMUTE" | "CASUAL" | "SPORT";
type WeatherCondition = "COLD" | "MILD" | "WARM" | "RAINY";
type ItemRole =
  "TOP" | "MID" | "OUTER" | "BOTTOM" | "ONE_PIECE" | "SHOES" | "ACCESSORY";
type City = z.infer<typeof wardrobeCitySchema>;
type OutfitIdeaPreferences = {
  wantsLayering: boolean;
  avoidsLayering: boolean;
  preferOnePiece: boolean;
  avoidOnePiece: boolean;
  preferredColors: string[];
  avoidedColors: string[];
  recognized: boolean;
};

const colorPreferenceTerms = [
  { term: "浅色", aliases: ["白", "米", "浅"] },
  { term: "深色", aliases: ["黑", "深", "藏青"] },
  { term: "黑色", aliases: ["黑"] },
  { term: "白色", aliases: ["白"] },
  { term: "米色", aliases: ["米", "燕麦"] },
  { term: "卡其", aliases: ["卡其"] },
  { term: "蓝色", aliases: ["蓝"] },
  { term: "棕色", aliases: ["棕", "咖"] },
  { term: "灰色", aliases: ["灰"] },
];

function isNegatedPreference(idea: string, term: string) {
  const index = idea.indexOf(term);
  if (index < 0) return false;
  const prefix = idea.slice(Math.max(0, index - 12), index);
  const suffix = idea.slice(index + term.length, index + term.length + 8);
  return (
    /(不想|不要|避免|不穿|不喜欢|别|拒绝|不需要|无需|不用)(?:穿|选|用|加)?\s*$/.test(
      prefix,
    ) || /^(?:不需要|无需|不用|不要|不想)/.test(suffix)
  );
}

function parseOutfitIdea(idea?: string): OutfitIdeaPreferences {
  const value = idea?.trim() ?? "";
  const layeringTerms = ["叠穿", "加一层", "外套", "保暖"];
  const wantsLayering = /叠穿|加一层|外套|保暖/.test(value);
  const avoidsLayering = layeringTerms.some(
    (term) => value.includes(term) && isNegatedPreference(value, term),
  );
  const preferOnePiece = /连衣裙|裙子|裙装/.test(value);
  const avoidOnePiece = ["连衣裙", "裙子", "裙装"].some(
    (term) => value.includes(term) && isNegatedPreference(value, term),
  );
  const colors = colorPreferenceTerms.filter(({ term }) =>
    value.includes(term),
  );
  const preferredColors = colors
    .filter(({ term }) => !isNegatedPreference(value, term))
    .map(({ term }) => term);
  const avoidedColors = colors
    .filter(({ term }) => isNegatedPreference(value, term))
    .map(({ term }) => term);
  return {
    wantsLayering: wantsLayering && !avoidsLayering,
    avoidsLayering,
    preferOnePiece: preferOnePiece && !avoidOnePiece,
    avoidOnePiece,
    preferredColors,
    avoidedColors,
    recognized:
      wantsLayering ||
      avoidsLayering ||
      preferOnePiece ||
      avoidOnePiece ||
      colors.length > 0,
  };
}

function preferenceScore(
  items: Array<{
    garment: { category: string; color: string | null };
    role: ItemRole;
  }>,
  preferences: OutfitIdeaPreferences,
  condition?: WeatherCondition,
) {
  let score = 0;
  const hasOuter = items.some(({ role }) => role === "OUTER");
  const hasOnePiece = items.some(({ role }) => role === "ONE_PIECE");
  if (preferences.wantsLayering) score += hasOuter ? 8 : -3;
  if (
    preferences.avoidsLayering &&
    hasOuter &&
    !["COLD", "RAINY"].includes(condition ?? "")
  )
    score -= 12;
  if (preferences.preferOnePiece) score += hasOnePiece ? 6 : -2;
  if (preferences.avoidOnePiece && hasOnePiece) score -= 8;
  for (const term of preferences.preferredColors) {
    const aliases = colorPreferenceTerms.find(
      (item) => item.term === term,
    )!.aliases;
    score += items.some(({ garment }) =>
      aliases.some((alias) => garment.color?.includes(alias)),
    )
      ? 4
      : -1;
  }
  for (const term of preferences.avoidedColors) {
    const aliases = colorPreferenceTerms.find(
      (item) => item.term === term,
    )!.aliases;
    if (
      items.some(({ garment }) =>
        aliases.some((alias) => garment.color?.includes(alias)),
      )
    )
      score -= 10;
  }
  return score;
}

function sceneLabel(scene: Scene) {
  return scene === "COMMUTE" ? "通勤" : scene === "SPORT" ? "运动" : "休闲";
}

function weatherLabel(condition?: WeatherCondition) {
  switch (condition) {
    case "COLD":
      return "偏冷";
    case "MILD":
      return "适中";
    case "WARM":
      return "偏热";
    case "RAINY":
      return "有雨";
    default:
      return "未知天气";
  }
}

const outfitInclude = {
  items: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      garment: { include: { mainImage: { select: { id: true } } } },
    },
  },
};

function seasonForDate(date: string) {
  const month = Number(date.slice(5, 7));
  if ([3, 4, 5].includes(month)) return "SPRING";
  if ([6, 7, 8].includes(month)) return "SUMMER";
  if ([9, 10, 11].includes(month)) return "AUTUMN";
  return "WINTER";
}

function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weatherCondition(day?: {
  available: boolean;
  apparentTemperatureMin: number | null;
  temperatureMin: number | null;
  temperatureMax: number | null;
  precipitationMm: number | null;
}): WeatherCondition | undefined {
  if (!day?.available) return undefined;
  if ((day.precipitationMm ?? 0) >= 2) return "RAINY";
  const apparentMin = day.apparentTemperatureMin ?? day.temperatureMin;
  if (apparentMin !== null && apparentMin !== undefined && apparentMin < 12)
    return "COLD";
  if (day.temperatureMax !== null && day.temperatureMax >= 24) return "WARM";
  return "MILD";
}

function stableTieBreak(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

@Injectable()
export class WardrobeOutfitService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WardrobeWeatherService)
    private readonly weather: WardrobeWeatherService,
  ) {}

  async recommendDaily(
    actorId: string,
    input: {
      scene: Scene;
      city?: City | undefined;
      weatherCondition?: WeatherCondition | undefined;
      date?: string | undefined;
      skipWeatherLookup?: boolean | undefined;
      idea?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const today =
      input.date ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: input.city?.timezone ?? "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    let city = input.city;
    if (!city) {
      const membership = await this.prisma.membership.findFirst({
        where: {
          accountId: actorId,
          leftAt: null,
          family: { status: "ACTIVE" },
          account: { status: "ACTIVE" },
        },
        select: {
          family: {
            select: {
              defaultCityName: true,
              defaultCityCountry: true,
              defaultCityLatitude: true,
              defaultCityLongitude: true,
              defaultCityTimezone: true,
            },
          },
        },
      });
      const familyCity = membership?.family;
      if (
        familyCity?.defaultCityName &&
        familyCity.defaultCityCountry &&
        familyCity.defaultCityLatitude !== null &&
        familyCity.defaultCityLongitude !== null &&
        familyCity.defaultCityTimezone
      ) {
        city = {
          name: familyCity.defaultCityName,
          countryCode: familyCity.defaultCityCountry,
          latitude: familyCity.defaultCityLatitude,
          longitude: familyCity.defaultCityLongitude,
          timezone: familyCity.defaultCityTimezone,
        };
      }
    }
    let weatherResult: Awaited<
      ReturnType<WardrobeWeatherService["forecast"]>
    > | null = null;
    let weatherError: string | null = null;
    if (city && !input.weatherCondition && !input.skipWeatherLookup) {
      try {
        weatherResult = await this.weather.forecast({
          city,
          startDate: today,
          days: 1,
        });
      } catch {
        weatherError = "天气暂不可用，已按季节与手选条件生成。";
      }
    }
    const day = weatherResult?.days[0];
    const condition = input.weatherCondition ?? weatherCondition(day);
    const garments = await this.prisma.garment.findMany({
      where: { ownerId: actorId, deletedAt: null, status: "WEARABLE" },
      include: { mainImage: { select: { id: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 200,
    });
    const season = seasonForDate(today);
    const idea = input.idea?.trim() ?? "";
    const preferences = parseOutfitIdea(idea);
    const eligible = garments.filter(
      (garment) =>
        (!garment.scenes.length || garment.scenes.includes(input.scene)) &&
        (!garment.seasons.length || garment.seasons.includes(season)),
    );
    const byCategory = (category: string) =>
      eligible.filter((garment) => garment.category === category).slice(0, 16);
    const tops = byCategory("TOP");
    const bottoms = byCategory("BOTTOM");
    const onePieces = byCategory("ONE_PIECE");
    const shoes = byCategory("SHOES");
    const outerwear = eligible
      .filter(
        (garment) =>
          garment.category === "OUTERWEAR" || garment.layers.includes("OUTER"),
      )
      .slice(0, 16);
    const midLayers = tops
      .filter((garment) => garment.layers.includes("MID"))
      .slice(0, 12);
    const bases = [
      ...onePieces.map((garment) => [
        { garment, role: "ONE_PIECE" as ItemRole },
      ]),
      ...tops
        .filter((garment) => !garment.layers.includes("MID"))
        .flatMap((top) =>
          bottoms.map((bottom) => [
            { garment: top, role: "TOP" as ItemRole },
            { garment: bottom, role: "BOTTOM" as ItemRole },
          ]),
        ),
    ];
    const needsOuter = condition === "COLD" || condition === "RAINY";
    const canAddPreferredOuter =
      preferences.wantsLayering && condition !== "WARM";
    const candidates: Array<{
      items: Array<{ garment: (typeof garments)[number]; role: ItemRole }>;
      score: number;
      warning: string[];
      reason: string;
    }> = [];
    for (const base of bases) {
      const baseTop = base.find((item) => item.role === "TOP");
      const needsMid = Boolean(
        baseTop?.garment.layers.includes("INNER") &&
        condition === "COLD" &&
        midLayers.some(({ id }) => id !== baseTop.garment.id),
      );
      const mids = needsMid
        ? midLayers
            .filter(({ id }) => id !== baseTop?.garment.id)
            .slice(0, 4)
            .map((garment) => ({ garment, role: "MID" as ItemRole }))
        : [null];
      const shoeOptions = shoes.length
        ? shoes
            .slice(0, 8)
            .map((garment) => ({ garment, role: "SHOES" as ItemRole }))
        : [null];
      const outerOptions =
        (needsOuter || canAddPreferredOuter) && outerwear.length
          ? outerwear
              .slice(0, 8)
              .map((garment) => ({ garment, role: "OUTER" as ItemRole }))
          : [null];
      for (const mid of mids) {
        for (const shoe of shoeOptions) {
          for (const outer of outerOptions) {
            const items = [
              ...base,
              ...(mid ? [mid] : []),
              ...(shoe ? [shoe] : []),
              ...(outer ? [outer] : []),
            ];
            const ids = new Set(items.map(({ garment }) => garment.id));
            if (ids.size !== items.length) continue;
            const warning: string[] = [];
            if (!shoe) warning.push("衣柜中没有可用鞋履，本套搭配不含鞋子。");
            if (needsOuter && !outer)
              warning.push("当前天气建议加外层，但衣柜中没有可穿外套。");
            if (preferences.avoidsLayering && outer && needsOuter) {
              warning.push(
                "你的想法倾向避免外层，但当前天气建议保暖或防雨；可按体感调整。",
              );
            }
            if (
              preferences.avoidedColors.length &&
              preferenceScore(items, preferences, condition) < 0
            ) {
              warning.push(
                "衣柜中符合全部颜色偏好的衣物有限，请检查这套搭配。",
              );
            }
            const score =
              items.reduce(
                (sum, item) =>
                  sum +
                  (item.garment.seasons.includes(season) ? 4 : 0) +
                  (item.garment.scenes.includes(input.scene) ? 4 : 0),
                0,
              ) +
              (outer ? (needsOuter ? 6 : condition === "WARM" ? -2 : 2) : 0) +
              (mid ? 2 : 0) +
              preferenceScore(items, preferences, condition);
            const basePiece =
              baseTop ?? base.find((item) => item.role === "ONE_PIECE");
            const layerReason = outer
              ? `${basePiece?.garment.name ?? "内搭"}配${outer.garment.name}，温度升高时可脱下外层。`
              : needsOuter
                ? "当前天气建议增加外层，但衣柜里没有合适的可穿外套。"
                : "组合没有额外外层，适合当前天气活动。";
            const weatherReason = day?.available
              ? `当地预报 ${day.temperatureMin ?? "—"}—${day.temperatureMax ?? "—"}℃，降水 ${day.precipitationMm ?? "—"} mm（${weatherLabel(condition)}）。`
              : condition
                ? `按${weatherLabel(condition)}条件搭配；没有可用的实时报温。`
                : "当天没有可用天气数据，未推断温度。";
            const ideaReason = idea
              ? preferences.recognized
                ? `已将“${idea}”作为轻量偏好参与排序。`
                : `已收到你的想法“${idea}”；其中未识别出明确衣物偏好，主要按天气和场景匹配。`
              : "";
            const reason = [
              `${weatherReason}${sceneLabel(input.scene)}场景下，${layerReason}`,
              ideaReason,
            ]
              .filter(Boolean)
              .join(" ");
            candidates.push({ items, score, warning, reason });
          }
        }
      }
    }
    const recommendations = candidates
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return (
          stableTieBreak(
            `${today}:${input.scene}:${left.items.map(({ garment }) => garment.id).join(":")}`,
          ) -
          stableTieBreak(
            `${today}:${input.scene}:${right.items.map(({ garment }) => garment.id).join(":")}`,
          )
        );
      })
      .slice(0, input.limit ?? 3)
      .map((candidate, index) => ({
        id: `daily-${index + 1}`,
        name: `${input.scene === "COMMUTE" ? "通勤" : input.scene === "SPORT" ? "运动" : "休闲"}搭配 ${index + 1}`,
        scene: input.scene,
        score: candidate.score,
        warnings: candidate.warning,
        reason: candidate.reason,
        items: candidate.items.map(({ garment, role }, sortOrder) => ({
          garmentId: garment.id,
          role,
          sortOrder,
          name: garment.name,
          category: garment.category,
          color: garment.color,
          stylingAdvice: garment.stylingAdvice,
          seasons: garment.seasons,
          layers: garment.layers,
          imageUrl: `/api/v1/wardrobe/images/${garment.mainImage.id}/content?size=thumbnail`,
        })),
      }));
    return {
      date: today,
      scene: input.scene,
      city: city ?? null,
      weather: day ?? null,
      weatherSource: weatherResult?.source ?? null,
      weatherError,
      condition: condition ?? null,
      recommendations,
      message: recommendations.length
        ? null
        : "现有可穿衣物暂时无法组成完整上下装或连体搭配；可补充鞋履、上装或下装资料。",
    };
  }

  async recommendTrip(
    actorId: string,
    input: {
      scene: Scene;
      city: City;
      startOn: string;
      days: number;
      weatherCondition?: WeatherCondition | undefined;
      idea?: string | undefined;
      candidateLimit?: number | undefined;
    },
  ) {
    let forecast: Awaited<
      ReturnType<WardrobeWeatherService["forecast"]>
    > | null = null;
    let weatherError: string | null = null;
    try {
      forecast = await this.weather.forecast({
        city: input.city,
        startDate: input.startOn,
        days: input.days,
      });
    } catch {
      weatherError = "目的地天气暂不可用；可调整天气条件后重新生成。";
    }
    const forecastByDate = new Map(
      (forecast?.days ?? []).map((day) => [day.date, day]),
    );
    const days = [];
    for (let index = 0; index < input.days; index += 1) {
      const date = addCalendarDays(input.startOn, index);
      const weather = forecastByDate.get(date) ?? null;
      const condition =
        input.weatherCondition ?? weatherCondition(weather ?? undefined);
      const daily = await this.recommendDaily(actorId, {
        scene: input.scene,
        city: input.city,
        date,
        weatherCondition: condition,
        skipWeatherLookup: true,
        idea: input.idea,
        limit: input.candidateLimit ?? 1,
      });
      days.push({
        date,
        weather,
        condition: condition ?? null,
        recommendation: daily.recommendations[0] ?? null,
        ...(input.candidateLimit && input.candidateLimit > 1
          ? { candidates: daily.recommendations }
          : {}),
        message: daily.recommendations.length ? null : daily.message,
        weatherMissing: !weather?.available,
      });
    }
    return {
      city: input.city,
      timezone: input.city.timezone,
      startOn: input.startOn,
      days,
      weatherSource: forecast?.source ?? null,
      weatherAttribution: forecast?.attribution ?? null,
      weatherFetchedAt: forecast?.fetchedAt ?? null,
      weatherStale: forecast?.isStale ?? false,
      weatherError,
    };
  }

  async list(actorId: string) {
    const outfits = await this.prisma.outfit.findMany({
      where: { ownerId: actorId, deletedAt: null },
      include: outfitInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 50,
    });
    return outfits.map((outfit) => this.dto(outfit, actorId));
  }

  async create(actorId: string, input: CreateInput) {
    await this.assertGarments(
      actorId,
      input.items.map(({ garmentId }) => garmentId),
    );
    const outfit = await this.prisma.outfit.create({
      data: {
        ownerId: actorId,
        name: input.name,
        scene: input.scene ?? null,
        notes: input.notes ?? null,
        items: {
          create: input.items.map(({ garmentId, ...item }) => ({
            ...item,
            garment: { connect: { id: garmentId } },
          })),
        },
      },
      include: outfitInclude,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorId,
        action: "OUTFIT_CREATED",
        subjectType: "OUTFIT",
        subjectId: outfit.id,
      },
    });
    return this.dto(outfit, actorId);
  }

  async update(outfitId: string, actorId: string, input: PatchInput) {
    const current = await this.prisma.outfit.findFirst({
      where: { id: outfitId, ownerId: actorId, deletedAt: null },
    });
    if (!current) throw new NotFoundException({ code: "OUTFIT_NOT_FOUND" });
    if (current.version !== input.version)
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    if (input.items)
      await this.assertGarments(
        actorId,
        input.items.map(({ garmentId }) => garmentId),
      );
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.outfit.updateMany({
        where: {
          id: outfitId,
          ownerId: actorId,
          version: input.version,
          deletedAt: null,
        },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scene !== undefined ? { scene: input.scene } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          version: { increment: 1 },
        },
      });
      if (!result.count)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (input.items) {
        await tx.outfitItem.deleteMany({ where: { outfitId } });
        await tx.outfitItem.createMany({
          data: input.items.map((item) => ({ ...item, outfitId })),
        });
      }
      return tx.outfit.findUniqueOrThrow({
        where: { id: outfitId },
        include: outfitInclude,
      });
    });
    return this.dto(updated, actorId);
  }

  async remove(outfitId: string, actorId: string, version: number) {
    const result = await this.prisma.outfit.updateMany({
      where: { id: outfitId, ownerId: actorId, version, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (!result.count)
      throw new NotFoundException({ code: "OUTFIT_NOT_FOUND" });
    await this.prisma.auditEvent.create({
      data: {
        actorId,
        action: "OUTFIT_DELETED",
        subjectType: "OUTFIT",
        subjectId: outfitId,
      },
    });
    return { id: outfitId, deleted: true };
  }

  private async assertGarments(actorId: string, ids: string[]) {
    const garments = await this.prisma.garment.findMany({
      where: { id: { in: ids }, ownerId: actorId, deletedAt: null },
      select: { id: true },
    });
    if (new Set(garments.map(({ id }) => id)).size !== new Set(ids).size) {
      throw new NotFoundException({ code: "WARDROBE_GARMENT_NOT_FOUND" });
    }
  }

  private dto(
    outfit: Prisma.OutfitGetPayload<{ include: typeof outfitInclude }>,
    actorId: string,
  ) {
    const items = outfit.items.map(({ garment, ...item }) => {
      const available = garment.ownerId === actorId && !garment.deletedAt;
      return {
        ...item,
        garment: available
          ? {
              id: garment.id,
              name: garment.name,
              category: garment.category,
              status: garment.status,
              imageUrl: `/api/v1/wardrobe/images/${garment.mainImage.id}/content?size=thumbnail`,
            }
          : null,
        available: available && garment.status === "WEARABLE",
      };
    });
    return {
      id: outfit.id,
      name: outfit.name,
      scene: outfit.scene,
      notes: outfit.notes,
      weatherSnapshot: outfit.weatherSnapshot,
      version: outfit.version,
      createdAt: outfit.createdAt,
      updatedAt: outfit.updatedAt,
      items,
      valid: items.every(({ available }) => available),
    };
  }
}
