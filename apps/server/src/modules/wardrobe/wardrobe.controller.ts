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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { z } from "zod";
import { FileInterceptor } from "@nestjs/platform-express";
import type { AuthenticatedRequest } from "../../shared/auth/auth-types.js";
import { apiSuccess, parseBody } from "../../shared/http/api-response.js";
import {
  garmentCreateRequestSchema,
  garmentListQuerySchema,
  garmentPatchRequestSchema,
  outfitCreateRequestSchema,
  outfitPatchRequestSchema,
  versionRequestSchema,
  wardrobeDailyRecommendationRequestSchema,
  wardrobeRecommendationRequestSchema,
  wardrobeWeatherRequestSchema,
} from "@homedata/contracts";
import { WardrobeService } from "./wardrobe.service.js";
import { WardrobeWeatherService } from "./wardrobe-weather.service.js";
import { WardrobeOutfitService } from "./wardrobe-outfit.service.js";

type PassthroughResponse = { set(headers: Record<string, string>): unknown };

@Controller("wardrobe")
export class WardrobeController {
  constructor(
    @Inject(WardrobeService) private readonly wardrobe: WardrobeService,
    @Inject(WardrobeWeatherService)
    private readonly weather: WardrobeWeatherService,
    @Inject(WardrobeOutfitService)
    private readonly outfits: WardrobeOutfitService,
  ) {}

  @Get("locations")
  async locations(
    @Query("q") query: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(request, await this.weather.searchLocations(query ?? ""));
  }

  @Post("weather/forecast")
  async forecast(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parseBody(wardrobeWeatherRequestSchema, body);
    return apiSuccess(request, await this.weather.forecast(input));
  }

  @Post("recommendations/daily")
  async recommendDaily(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(wardrobeDailyRecommendationRequestSchema, body);
    return apiSuccess(
      request,
      await this.outfits.recommendDaily(request.account!.id, input),
    );
  }

  @Post("recommendations/trip")
  async recommendTrip(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseBody(wardrobeRecommendationRequestSchema, body);
    if (input.mode !== "TRIP" || !input.city || !input.startOn || !input.days) {
      return apiSuccess(request, {
        days: [],
        weatherError: "旅行推荐需要目的地、出发日期和天数。",
      });
    }
    return apiSuccess(
      request,
      await this.outfits.recommendTrip(request.account!.id, {
        scene: input.scene,
        city: input.city,
        startOn: input.startOn,
        days: input.days,
        weatherCondition: input.weatherCondition,
        idea: input.idea,
      }),
    );
  }

  @Get("outfits")
  async listOutfits(@Req() request: AuthenticatedRequest) {
    return apiSuccess(request, await this.outfits.list(request.account!.id));
  }

  @Post("outfits")
  async createOutfit(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.outfits.create(
        request.account!.id,
        parseBody(outfitCreateRequestSchema, body),
      ),
    );
  }

  @Patch("outfits/:id")
  async updateOutfit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.outfits.update(
        id,
        request.account!.id,
        parseBody(outfitPatchRequestSchema, body),
      ),
    );
  }

  @Delete("outfits/:id")
  async deleteOutfit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(versionRequestSchema, body);
    return apiSuccess(
      request,
      await this.outfits.remove(id, request.account!.id, version),
    );
  }

  private key(value: string | undefined) {
    if (z.string().uuid().safeParse(value).success) return value!;
    const error = Object.assign(new Error("IDEMPOTENCY_KEY_REQUIRED"), {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    throw error;
  }

  @Post("images")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  async uploadImage(
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!file) {
      const error = Object.assign(new Error("WARDROBE_IMAGE_REQUIRED"), {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: "WARDROBE_IMAGE_REQUIRED",
      });
      throw error;
    }
    return apiSuccess(
      request,
      await this.wardrobe.uploadImage(request.account!.id, file),
    );
  }

  @Get("images/:id/content")
  async imageContent(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("size") size: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ) {
    const image = await this.wardrobe.imageContent(
      id,
      request.account!.id,
      size,
    );
    response.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    return new StreamableFile(image.buffer, {
      type: image.mimeType,
      length: image.buffer.length,
    });
  }

  @Delete("images/:id")
  async deleteTemporaryImage(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.wardrobe.deleteTemporaryImage(id, request.account!.id),
    );
  }

  @Get("garments")
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    return apiSuccess(
      request,
      await this.wardrobe.listGarments(
        request.account!.id,
        parseBody(garmentListQuerySchema, query),
      ),
    );
  }

  @Post("garments")
  async create(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.wardrobe.createGarment(
        request.account!.id,
        parseBody(garmentCreateRequestSchema, body),
        this.key(key),
      ),
    );
  }

  @Get("garments/:id")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.wardrobe.getGarment(id, request.account!.id),
    );
  }

  @Patch("garments/:id")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return apiSuccess(
      request,
      await this.wardrobe.updateGarment(
        id,
        request.account!.id,
        parseBody(garmentPatchRequestSchema, body),
      ),
    );
  }

  @Delete("garments/:id")
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = parseBody(versionRequestSchema, body);
    return apiSuccess(
      request,
      await this.wardrobe.deleteGarment(id, request.account!.id, version),
    );
  }
}
