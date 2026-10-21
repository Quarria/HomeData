import { Module } from "@nestjs/common";
import { WardrobeController } from "./wardrobe.controller.js";
import { WardrobeService } from "./wardrobe.service.js";
import { WardrobeImageStorageService } from "./wardrobe-image-storage.service.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { WardrobeWeatherService } from "./wardrobe-weather.service.js";
import { WardrobeOutfitService } from "./wardrobe-outfit.service.js";

@Module({
  imports: [LedgerModule],
  controllers: [WardrobeController],
  providers: [
    WardrobeService,
    WardrobeImageStorageService,
    WardrobeWeatherService,
    WardrobeOutfitService,
  ],
  exports: [
    WardrobeService,
    WardrobeImageStorageService,
    WardrobeWeatherService,
    WardrobeOutfitService,
  ],
})
export class WardrobeModule {}
