import { Module } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module.js";
import { SharesController } from "./shares.controller.js";
import { SharesService } from "./shares.service.js";

@Module({
  imports: [ReportsModule],
  controllers: [SharesController],
  providers: [SharesService],
  exports: [SharesService],
})
export class SharesModule {}
