import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export type UploadedReceipt = {
  buffer: Buffer;
  size: number;
};

export type StoredReceipt = {
  storageKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  contentHash: string;
};

@Injectable()
export class ReceiptStorageService {
  private readonly directory = resolve(
    process.env.RECEIPT_STORAGE_PATH ?? "../../data/receipts",
  );

  async store(file: UploadedReceipt): Promise<StoredReceipt> {
    if (!file.buffer.length || file.buffer.length > MAX_RECEIPT_BYTES) {
      throw Object.assign(new Error("RECEIPT_SIZE_INVALID"), {
        status: 413,
        code: "RECEIPT_SIZE_INVALID",
      });
    }
    const mimeType = this.detectMimeType(file.buffer);
    const storageKey = `${randomUUID()}${mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : ".webp"}`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(resolve(this.directory, storageKey), file.buffer, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      storageKey,
      mimeType,
      sizeBytes: file.buffer.length,
      contentHash: createHash("sha256").update(file.buffer).digest("hex"),
    };
  }

  async read(storageKey: string) {
    return readFile(resolve(this.directory, storageKey));
  }

  async remove(storageKey: string) {
    await rm(resolve(this.directory, storageKey), { force: true });
  }

  private detectMimeType(buffer: Buffer): StoredReceipt["mimeType"] {
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      return "image/png";
    }
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return "image/jpeg";
    }
    if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }
    throw Object.assign(new Error("RECEIPT_FORMAT_INVALID"), {
      status: 422,
      code: "RECEIPT_FORMAT_INVALID",
    });
  }
}
