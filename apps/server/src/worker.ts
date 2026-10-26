import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module.js";
import { TasksService } from "./modules/tasks/tasks.service.js";
import { AppLogger } from "./shared/logging/app-logger.js";
import { AiService } from "./modules/ai/ai.service.js";
import { SharesService } from "./modules/shares/shares.service.js";
import { WardrobeService } from "./modules/wardrobe/wardrobe.service.js";
import { PushPlusService } from "./modules/tasks/pushplus.service.js";

const intervalMs = 60_000;
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
});
const logger = app.get(AppLogger);
const tasks = app.get(TasksService);
const ai = app.get(AiService);
const shares = app.get(SharesService);
const wardrobe = app.get(WardrobeService);
const pushPlus = app.get(PushPlusService);
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

async function scanPushPlus() {
  if (stopping) return;
  try {
    const result = await pushPlus.runCycle();
    if (result.accepted)
      logger.log("PushPlus reminders accepted", { ...result });
  } catch (error) {
    logger.error("PushPlus reminder cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await scan();
const timer = setInterval(() => void scan(), intervalMs);
await scanPushPlus();
const pushPlusTimer = setInterval(() => void scanPushPlus(), intervalMs);
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
const wardrobeCleanupIntervalMs = 6 * 60 * 60 * 1000;
async function cleanupWardrobeImages() {
  try {
    const result = await wardrobe.cleanupTemporaryImages();
    if (result.purged) logger.log("Temporary wardrobe images purged", result);
  } catch (error) {
    logger.error("Wardrobe image cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
await cleanupWardrobeImages();
const wardrobeCleanupTimer = setInterval(
  () => void cleanupWardrobeImages(),
  wardrobeCleanupIntervalMs,
);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(pushPlusTimer);
  clearInterval(aiTimer);
  clearInterval(shareCleanupTimer);
  clearInterval(wardrobeCleanupTimer);
  await app.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
