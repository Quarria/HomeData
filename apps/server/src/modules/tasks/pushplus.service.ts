import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { PrismaService } from "../../shared/database/prisma.service.js";

type PushPlusResponse = { code?: number; msg?: string; data?: unknown };

function credentialKey() {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new ServiceUnavailableException({
      code: "PUSHPLUS_ENCRYPTION_NOT_CONFIGURED",
      message: "服务器尚未配置推送凭证加密密钥。",
    });
  }
  return createHash("sha256").update(secret).digest();
}

function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptToken(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue)
    throw new Error("Stored PushPlus token has invalid format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    credentialKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

@Injectable()
export class PushPlusService {
  private readonly logger = new Logger(PushPlusService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async saveToken(accountId: string, token: string) {
    const encryptedToken = encryptToken(token);
    await this.prisma.reminderPreference.upsert({
      where: { accountId },
      create: { accountId, pushPlusToken: encryptedToken },
      update: { pushPlusToken: encryptedToken },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorId: accountId,
        action: "PUSHPLUS_TOKEN_UPDATED",
        subjectType: "ACCOUNT",
        subjectId: accountId,
      },
    });
    return { configured: true };
  }

  async removeToken(accountId: string) {
    await this.prisma.reminderPreference.upsert({
      where: { accountId },
      create: { accountId },
      update: {
        pushPlusToken: null,
        pushPlusEnabled: false,
        pushPlusEnabledAt: null,
      },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorId: accountId,
        action: "PUSHPLUS_TOKEN_REMOVED",
        subjectType: "ACCOUNT",
        subjectId: accountId,
      },
    });
    return { configured: false, enabled: false };
  }

  async sendTest(accountId: string) {
    const preference = await this.prisma.reminderPreference.findUnique({
      where: { accountId },
      select: { pushPlusToken: true },
    });
    if (!preference?.pushPlusToken)
      throw new BadRequestException({ code: "PUSHPLUS_TOKEN_REQUIRED" });
    const result = await this.send(
      decryptToken(preference.pushPlusToken),
      "家常账测试通知",
      "PushPlus 已连接成功。后续提醒将按你的提醒设置发送。",
    );
    if (result.code !== 200)
      throw new ServiceUnavailableException({
        code: "PUSHPLUS_TEST_REJECTED",
        message: result.msg || "PushPlus 未接受测试消息，请检查 Token。",
      });
    return { accepted: true };
  }

  async runCycle(now = new Date()) {
    const staleBefore = new Date(now.getTime() - 5 * 60_000);
    await this.prisma.pushDelivery.updateMany({
      where: { status: "SENDING", updatedAt: { lt: staleBefore } },
      data: { status: "PENDING", nextAttemptAt: now },
    });

    const dueMessages = await this.prisma.inboxMessage.findMany({
      where: {
        slotAt: { lte: now },
        readAt: null,
        pushDelivery: null,
        recipient: {
          is: {
            status: "ACTIVE",
            reminderPreference: {
              is: {
                pushPlusEnabled: true,
                pushPlusToken: { not: null },
              },
            },
          },
        },
      },
      select: {
        id: true,
        createdAt: true,
        recipient: {
          select: {
            reminderPreference: { select: { pushPlusEnabledAt: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const newlyEnabledMessages = dueMessages.filter((message) => {
      const enabledAt = message.recipient.reminderPreference?.pushPlusEnabledAt;
      return enabledAt && message.createdAt >= enabledAt;
    });
    if (newlyEnabledMessages.length) {
      await this.prisma.pushDelivery.createMany({
        data: newlyEnabledMessages.map(({ id }) => ({ messageId: id })),
        skipDuplicates: true,
      });
    }

    const pending = await this.prisma.pushDelivery.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: 20,
      include: {
        message: {
          select: {
            id: true,
            createdAt: true,
            readAt: true,
            recipientId: true,
            recipient: {
              select: {
                status: true,
                reminderPreference: {
                  select: {
                    pushPlusEnabled: true,
                    pushPlusEnabledAt: true,
                    pushPlusToken: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    let accepted = 0;
    for (const delivery of pending) {
      const claimed = await this.prisma.pushDelivery.updateMany({
        where: { id: delivery.id, status: "PENDING" },
        data: { status: "SENDING", attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;
      const preference = delivery.message.recipient.reminderPreference;
      if (
        delivery.message.readAt ||
        !preference?.pushPlusEnabledAt ||
        delivery.message.createdAt < preference.pushPlusEnabledAt ||
        delivery.message.createdAt <
          new Date(now.getTime() - 24 * 60 * 60_000) ||
        delivery.message.recipient.status !== "ACTIVE" ||
        !preference?.pushPlusEnabled ||
        !preference.pushPlusToken
      ) {
        await this.prisma.pushDelivery.update({
          where: { id: delivery.id },
          data: { status: "SKIPPED" },
        });
        continue;
      }

      try {
        const items = await this.prisma.inboxItem.findMany({
          where: { messageId: delivery.message.id },
          select: { subjectType: true, subjectId: true },
        });
        const taskIds = items
          .filter(({ subjectType }) => subjectType === "TASK")
          .map(({ subjectId }) => subjectId);
        const occurrenceIds = items
          .filter(({ subjectType }) => subjectType === "OCCURRENCE")
          .map(({ subjectId }) => subjectId);
        const [activeTasks, activeOccurrences] = await Promise.all([
          taskIds.length
            ? this.prisma.task.count({
                where: {
                  id: { in: taskIds },
                  status: "OPEN",
                  deletedAt: null,
                  OR: [
                    { familyId: null, creatorId: delivery.message.recipientId },
                    {
                      family: {
                        status: "ACTIVE",
                        memberships: {
                          some: {
                            accountId: delivery.message.recipientId,
                            leftAt: null,
                            account: { status: "ACTIVE" },
                          },
                        },
                      },
                    },
                  ],
                },
              })
            : 0,
          occurrenceIds.length
            ? this.prisma.occurrence.count({
                where: {
                  id: { in: occurrenceIds },
                  status: "PENDING",
                  OR: [
                    {
                      rule: {
                        familyId: null,
                        managerId: delivery.message.recipientId,
                      },
                    },
                    {
                      rule: {
                        family: {
                          status: "ACTIVE",
                          memberships: {
                            some: {
                              accountId: delivery.message.recipientId,
                              leftAt: null,
                              account: { status: "ACTIVE" },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              })
            : 0,
        ]);
        const active = activeTasks + activeOccurrences;
        if (!active) {
          await this.prisma.pushDelivery.update({
            where: { id: delivery.id },
            data: { status: "SKIPPED" },
          });
          continue;
        }
        const response = await this.send(
          decryptToken(preference.pushPlusToken),
          "家常账提醒",
          `你有 ${active} 项待办或固定费用需要处理。${process.env.APP_ORIGIN ? `\n打开家常账：${process.env.APP_ORIGIN.replace(/\/$/, "")}` : ""}`,
        );
        if (response.code !== 200) {
          const error = (
            response.msg || `PushPlus 返回 ${response.code}`
          ).slice(0, 500);
          await this.retryOrFail(
            delivery.id,
            delivery.attempts + 1,
            error,
            now,
          );
          continue;
        }
        await this.prisma.pushDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "ACCEPTED",
            providerId:
              typeof response.data === "string"
                ? response.data.slice(0, 128)
                : null,
            lastError: null,
          },
        });
        accepted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.retryOrFail(
          delivery.id,
          delivery.attempts + 1,
          message,
          now,
        );
      }
    }
    return { accepted, checked: pending.length };
  }

  private async retryOrFail(
    id: string,
    attempts: number,
    reason: string,
    now: Date,
  ) {
    const delayMinutes = [1, 5, 30, 120][attempts - 1];
    await this.prisma.pushDelivery.update({
      where: { id },
      data: {
        status: delayMinutes ? "PENDING" : "FAILED",
        nextAttemptAt: new Date(now.getTime() + (delayMinutes ?? 0) * 60_000),
        lastError: reason.slice(0, 500),
      },
    });
    this.logger.warn("PushPlus delivery attempt failed", {
      deliveryId: id,
      attempts,
      reason: reason.slice(0, 200),
    });
  }

  private async send(token: string, title: string, content: string) {
    const response = await fetch("https://www.pushplus.plus/send/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        title,
        content,
        channel: "wechat",
        template: "txt",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response
      .json()
      .catch(() => null)) as PushPlusResponse | null;
    if (!response.ok) throw new Error(`PushPlus HTTP ${response.status}`);
    if (!body || typeof body.code !== "number")
      throw new Error("PushPlus returned an invalid response");
    return body;
  }
}
