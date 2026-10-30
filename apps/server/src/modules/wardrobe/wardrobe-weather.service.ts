import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 45 * 60 * 1000;
const MANUAL_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const LOCATION_TTL_MS = 60 * 60 * 1000;
const FORECAST_DAYS = 16;

type City = {
  name: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

type WeatherDay = {
  date: string;
  available: boolean;
  temperatureMax: number | null;
  temperatureMin: number | null;
  apparentTemperatureMax: number | null;
  apparentTemperatureMin: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  windSpeedMax: number | null;
};

function localToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function locationKey(city: City) {
  return `${city.latitude.toFixed(4)},${city.longitude.toFixed(4)},${city.timezone}`;
}

function weatherDays(payload: unknown): WeatherDay[] {
  if (!payload || typeof payload !== "object" || !("daily" in payload)) {
    throw new Error("WEATHER_RESPONSE_INVALID");
  }
  const daily = payload.daily;
  if (!daily || typeof daily !== "object" || !("time" in daily)) {
    throw new Error("WEATHER_RESPONSE_INVALID");
  }
  const values = daily as Record<string, unknown>;
  if (!Array.isArray(values.time)) throw new Error("WEATHER_RESPONSE_INVALID");
  const array = (key: string) =>
    Array.isArray(values[key]) ? (values[key] as unknown[]) : [];
  const nullableNumber = (entries: unknown[], index: number) => {
    const value = entries[index];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return values.time.map((date, index) => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("WEATHER_RESPONSE_INVALID");
    }
    const temperatureMax = nullableNumber(array("temperature_2m_max"), index);
    const temperatureMin = nullableNumber(array("temperature_2m_min"), index);
    const apparentTemperatureMax = nullableNumber(
      array("apparent_temperature_max"),
      index,
    );
    const apparentTemperatureMin = nullableNumber(
      array("apparent_temperature_min"),
      index,
    );
    const precipitationMm = nullableNumber(array("precipitation_sum"), index);
    const weatherCode = nullableNumber(array("weather_code"), index);
    const windSpeedMax = nullableNumber(array("wind_speed_10m_max"), index);
    const available =
      temperatureMax !== null ||
      temperatureMin !== null ||
      precipitationMm !== null ||
      weatherCode !== null;
    return {
      date,
      available,
      temperatureMax,
      temperatureMin,
      apparentTemperatureMax,
      apparentTemperatureMin,
      precipitationMm,
      weatherCode,
      windSpeedMax,
    };
  });
}

@Injectable()
export class WardrobeWeatherService {
  private readonly locationCache = new Map<
    string,
    { expiresAt: number; items: City[] }
  >();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async searchLocations(query: string) {
    const name = query.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 100) return [];
    const cacheKey = name.toLocaleLowerCase();
    const cached = this.locationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const params = new URLSearchParams({
      name,
      count: "8",
      language: "zh",
      format: "json",
    });
    const response = await this.fetchJson(`${GEOCODING_URL}?${params}`);
    const results =
      response && typeof response === "object" && "results" in response
        ? response.results
        : null;
    const items = Array.isArray(results)
      ? results.flatMap((entry): City[] => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          const latitude = item.latitude;
          const longitude = item.longitude;
          const countryCode = item.country_code;
          const timezone = item.timezone;
          const cityName = item.name;
          if (
            typeof latitude !== "number" ||
            typeof longitude !== "number" ||
            typeof countryCode !== "string" ||
            typeof timezone !== "string" ||
            typeof cityName !== "string"
          ) {
            return [];
          }
          const admin = typeof item.admin1 === "string" ? item.admin1 : "";
          const country = typeof item.country === "string" ? item.country : "";
          return [
            {
              name: [cityName, admin, country].filter(Boolean).join(" · "),
              countryCode: countryCode.toUpperCase(),
              latitude,
              longitude,
              timezone,
            },
          ];
        })
      : [];
    this.locationCache.set(cacheKey, {
      expiresAt: Date.now() + LOCATION_TTL_MS,
      items,
    });
    return items;
  }

  async forecast(
    input: { city: City; startDate: string; days: number },
    options: { forceRefresh?: boolean } = {},
  ) {
    const today = localToday();
    const forecastTo = addDays(today, FORECAST_DAYS - 1);
    const key = locationKey(input.city);
    const fromDate = new Date(`${today}T00:00:00.000Z`);
    const toDate = new Date(`${forecastTo}T00:00:00.000Z`);
    const cached = await this.prisma.wardrobeWeatherCache.findUnique({
      where: {
        locationKey_forecastFrom_forecastTo: {
          locationKey: key,
          forecastFrom: fromDate,
          forecastTo: toDate,
        },
      },
    });
    let data: WeatherDay[];
    let fetchedAt: Date;
    let isStale = false;
    let fetchedFromSource = false;
    const forceRefreshAllowed =
      options.forceRefresh === true &&
      (!cached ||
        Date.now() - cached.fetchedAt.getTime() >=
          MANUAL_REFRESH_MIN_INTERVAL_MS);
    if (cached && cached.expiresAt > new Date() && !forceRefreshAllowed) {
      data = cached.data as unknown as WeatherDay[];
      fetchedAt = cached.fetchedAt;
    } else {
      try {
        const params = new URLSearchParams({
          latitude: String(input.city.latitude),
          longitude: String(input.city.longitude),
          daily: [
            "temperature_2m_max",
            "temperature_2m_min",
            "apparent_temperature_max",
            "apparent_temperature_min",
            "precipitation_sum",
            "weather_code",
            "wind_speed_10m_max",
          ].join(","),
          forecast_days: String(FORECAST_DAYS),
          timezone: input.city.timezone,
        });
        data = weatherDays(await this.fetchJson(`${FORECAST_URL}?${params}`));
        fetchedAt = new Date();
        fetchedFromSource = true;
        await this.prisma.wardrobeWeatherCache.upsert({
          where: {
            locationKey_forecastFrom_forecastTo: {
              locationKey: key,
              forecastFrom: fromDate,
              forecastTo: toDate,
            },
          },
          create: {
            locationKey: key,
            timezone: input.city.timezone,
            forecastFrom: fromDate,
            forecastTo: toDate,
            data: data as unknown as Prisma.InputJsonValue,
            fetchedAt,
            expiresAt: new Date(fetchedAt.getTime() + CACHE_TTL_MS),
          },
          update: {
            timezone: input.city.timezone,
            data: data as unknown as Prisma.InputJsonValue,
            fetchedAt,
            expiresAt: new Date(fetchedAt.getTime() + CACHE_TTL_MS),
          },
        });
      } catch (error) {
        if (!cached) throw error;
        data = cached.data as unknown as WeatherDay[];
        fetchedAt = cached.fetchedAt;
        isStale = true;
      }
    }
    const byDate = new Map(data.map((item) => [item.date, item]));
    const days = Array.from({ length: input.days }, (_, index) => {
      const date = addDays(input.startDate, index);
      return (
        byDate.get(date) ?? {
          date,
          available: false,
          temperatureMax: null,
          temperatureMin: null,
          apparentTemperatureMax: null,
          apparentTemperatureMin: null,
          precipitationMm: null,
          weatherCode: null,
          windSpeedMax: null,
        }
      );
    });
    return {
      city: input.city,
      timezone: input.city.timezone,
      days,
      source: "Open-Meteo",
      attribution: "天气数据：Open-Meteo（CC BY 4.0）",
      fetchedAt,
      isStale,
      fetchedFromSource,
      forecastThrough: forecastTo,
    };
  }

  private async fetchJson(url: string) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
    } catch {
      throw new ConflictException({ code: "WEATHER_UNAVAILABLE" });
    }
    if (!response.ok) {
      throw new ConflictException({ code: "WEATHER_UNAVAILABLE" });
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ConflictException({ code: "WEATHER_RESPONSE_INVALID" });
    }
  }
}
