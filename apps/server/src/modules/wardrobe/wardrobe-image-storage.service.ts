import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAIN_EDGE = 1024;
const THUMB_EDGE = 420;

export type WardrobeUpload = { buffer: Buffer; size: number };
export type StoredWardrobeImage = {
  storageKey: string;
  thumbnailKey: string;
  mimeType: "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  contentHash: string;
};

function invalid(code: string, status: number) {
  return Object.assign(new Error(code), { status, code });
}

@Injectable()
export class WardrobeImageStorageService {
  private readonly directory = resolve(
    process.env.WARDROBE_STORAGE_PATH ?? "../../data/wardrobe",
  );

  constructor() {
    sharp.cache({ memory: 32, files: 0, items: 4 });
    sharp.concurrency(1);
  }

  async store(file: WardrobeUpload): Promise<StoredWardrobeImage> {
    if (!file.buffer.length || file.buffer.length > MAX_UPLOAD_BYTES) {
      throw invalid("WARDROBE_IMAGE_SIZE_INVALID", 413);
    }

    let main: Buffer;
    let thumbnail: Buffer;
    let width: number;
    let height: number;
    try {
      const source = sharp(file.buffer, {
        limitInputPixels: MAX_PIXELS,
        failOn: "error",
        animated: false,
      });
      const metadata = await source.metadata();
      if (!metadata.width || !metadata.height || !metadata.format) {
        throw invalid("WARDROBE_IMAGE_FORMAT_INVALID", 422);
      }
      if (
        !(["jpeg", "png", "webp"] as const).includes(
          metadata.format as "jpeg" | "png" | "webp",
        )
      ) {
        throw invalid("WARDROBE_IMAGE_FORMAT_INVALID", 422);
      }
      if (metadata.width * metadata.height > MAX_PIXELS) {
        throw invalid("WARDROBE_IMAGE_PIXELS_INVALID", 422);
      }
      const mainOutput = await sharp(file.buffer, {
        limitInputPixels: MAX_PIXELS,
        failOn: "error",
        animated: false,
      })
        .rotate()
        .resize({
          width: MAIN_EDGE,
          height: MAIN_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 3 })
        .toBuffer({ resolveWithObject: true });
      main = mainOutput.data;
      width = mainOutput.info.width;
      height = mainOutput.info.height;
      thumbnail = await sharp(main, { limitInputPixels: MAX_PIXELS })
        .resize({
          width: THUMB_EDGE,
          height: THUMB_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 74, effort: 3 })
        .toBuffer();
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw invalid("WARDROBE_IMAGE_DECODE_FAILED", 422);
    }

    const base = randomUUID();
    const storageKey = `${base}.webp`;
    const thumbnailKey = `${base}-thumb.webp`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(resolve(this.directory, storageKey), main, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(resolve(this.directory, thumbnailKey), thumbnail, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await this.remove(storageKey);
      await this.remove(thumbnailKey);
      throw error;
    }
    return {
      storageKey,
      thumbnailKey,
      mimeType: "image/webp",
      sizeBytes: main.length,
      width,
      height,
      contentHash: createHash("sha256").update(main).digest("hex"),
    };
  }

  read(storageKey: string) {
    return readFile(resolve(this.directory, storageKey));
  }

  async remove(storageKey: string) {
    if (/^[0-9a-f-]{36}(?:-thumb)?\.webp$/i.test(storageKey)) {
      await rm(resolve(this.directory, storageKey), { force: true });
    }
  }

  async removeImage(storageKey: string, thumbnailKey: string) {
    await Promise.all([this.remove(storageKey), this.remove(thumbnailKey)]);
  }
}
