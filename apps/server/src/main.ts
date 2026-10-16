import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module.js";
import { validateEnvironment } from "./shared/config/environment.js";
import { AppLogger } from "./shared/logging/app-logger.js";
import { ApiExceptionFilter } from "./shared/http/api-exception.filter.js";

async function bootstrap() {
  validateEnvironment();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, process.env.HOST ?? "0.0.0.0");
  console.log(`家常账 API listening on http://127.0.0.1:${port}/api/v1`);
}

void bootstrap();
