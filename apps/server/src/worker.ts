import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module.js";
import { TasksService } from "./modules/tasks/tasks.service.js";
import { AppLogger } from "./shared/logging/app-logger.js";
import { AiService } from "./modules/ai/ai.service.js";
import { SharesService } from "./modules/shares/shares.service.js";

const intervalMs = 60_000;
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
});
const logger = app.get(AppLogger);
const tasks = app.get(TasksService);
const ai = app.get(AiService);
const shares = app.get(SharesService);
let stopping = false;
let running = false;
let aiRunning = false;

async function scan() {
  if (stopping || running) return;
  running = true;
  try {
    const result = await tasks.runReminderCycle();
    if (result.generated || result.queued) {
      logger.log("Reminder cycle completed", { ...result });
    }
  } catch (error) {
    logger.error("Reminder cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}

await scan();
const timer = setInterval(() => void scan(), intervalMs);
async function processAi() {
  if (stopping || aiRunning) return;
  aiRunning = true;
  try {
    await ai.processNext();
  } catch (error) {
    logger.error("AI job failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    aiRunning = false;
  }
}
await processAi();
const aiTimer = setInterval(() => void processAi(), 2_000);
const shareCleanupIntervalMs = 60 * 60 * 1000;
async function cleanupShares() {
  try {
    const result = await shares.cleanup();
    if (result.purged) logger.log("Expired share snapshots purged", result);
  } catch (error) {
    logger.error("Share cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
await cleanupShares();
const shareCleanupTimer = setInterval(
  () => void cleanupShares(),
  shareCleanupIntervalMs,
);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(aiTimer);
  clearInterval(shareCleanupTimer);
  await app.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
