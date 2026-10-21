import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { ReportsModule } from "../reports/reports.module.js";
import { WardrobeModule } from "../wardrobe/wardrobe.module.js";
import { AiController } from "./ai.controller.js";
import { AiProvider } from "./ai-provider.js";
import { AiService } from "./ai.service.js";

@Module({
  imports: [LedgerModule, ReportsModule, WardrobeModule],
  controllers: [AiController],
  providers: [AiProvider, AiService],
  exports: [AiService],
})
export class AiModule {}
