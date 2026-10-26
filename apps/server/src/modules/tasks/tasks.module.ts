import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";
import { PushPlusService } from "./pushplus.service.js";

@Module({
  controllers: [TasksController],
  providers: [TasksService, PushPlusService],
})
export class TasksModule {}
