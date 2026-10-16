import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthModule } from "./health/health.module.js";
import { RequestIdMiddleware } from "../shared/http/request-id.middleware.js";
import { AppLogger } from "../shared/logging/app-logger.js";
import { DatabaseModule } from "../shared/database/database.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { AccountsModule } from "./accounts/accounts.module.js";
import { FamiliesModule } from "./families/families.module.js";
import { SessionGuard } from "../shared/auth/session.guard.js";
import { SystemAdminGuard } from "../shared/auth/system-admin.guard.js";
import { CsrfGuard } from "../shared/auth/csrf.guard.js";
import { LedgerModule } from "./ledger/ledger.module.js";
import { TasksModule } from "./tasks/tasks.module.js";
import { ReportsModule } from "./reports/reports.module.js";
import { SharesModule } from "./shares/shares.module.js";
import { AiModule } from "./ai/ai.module.js";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    AccountsModule,
    FamiliesModule,
    LedgerModule,
    TasksModule,
    ReportsModule,
    SharesModule,
    AiModule,
  ],
  providers: [
    AppLogger,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: SystemAdminGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes("{*path}");
  }
}
