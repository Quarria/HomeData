import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { hashPassword } from "../../shared/auth/password.js";
import { normalizeUsername, accountSummary } from "../auth/auth.service.js";

const USERNAME_PATTERN = /^[\p{L}\p{N}._-]{1,40}$/u;
const SYSTEM_ADMIN_LOCK = 620261015;

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

@Injectable()
export class AccountsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list() {
    const accounts = await this.prisma.account.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return accounts.map(accountSummary);
  }

  async create(
    input: { username: string; nickname: string; initialPassword: string },
    actorId: string,
  ) {
    if (!USERNAME_PATTERN.test(input.username)) {
      throw new ConflictException({ code: "USERNAME_FORMAT_INVALID" });
    }
    const normalized = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.initialPassword);
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const created = await tx.account.create({
          data: {
            username: input.username,
            usernameNormalized: normalized,
            nickname: input.nickname,
            passwordHash,
            mustChangePassword: true,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId,
            action: "ACCOUNT_CREATED",
            subjectType: "ACCOUNT",
            subjectId: created.id,
          },
        });
        return created;
      });
      return accountSummary(account);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: "USERNAME_ALREADY_EXISTS" });
      }
      throw error;
    }
  }

  async resetPassword(
    accountId: string,
    initialPassword: string,
    actorId: string,
  ) {
    const passwordHash = await hashPassword(initialPassword);
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({ where: { id: accountId } });
      if (!account) throw new NotFoundException({ code: "ACCOUNT_NOT_FOUND" });
      const updated = await tx.account.update({
        where: { id: accountId },
        data: {
          passwordHash,
          mustChangePassword: true,
          authVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await tx.session.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId,
          action: "ACCOUNT_PASSWORD_RESET",
          subjectType: "ACCOUNT",
          subjectId: accountId,
        },
      });
      return accountSummary(updated);
    });
  }

  async setEnabled(
    accountId: string,
    enabled: boolean,
    version: number,
    actorId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked WHERE pg_advisory_xact_lock(${SYSTEM_ADMIN_LOCK}) IS NULL`;
      const account = await tx.account.findUnique({ where: { id: accountId } });
      if (!account) throw new NotFoundException({ code: "ACCOUNT_NOT_FOUND" });
      if (account.version !== version) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      if ((account.status === "ACTIVE") === enabled)
        return accountSummary(account);

      if (!enabled && account.systemRole === "SYSTEM_ADMIN") {
        const activeAdmins = await tx.account.count({
          where: { systemRole: "SYSTEM_ADMIN", status: "ACTIVE" },
        });
        if (activeAdmins <= 1) {
          throw new ConflictException({ code: "LAST_SYSTEM_ADMIN_REQUIRED" });
        }
      }
      if (!enabled) {
        const familyAdmin = await tx.family.findFirst({
          where: {
            adminAccountId: accountId,
            status: "ACTIVE",
            memberships: { some: { accountId, leftAt: null } },
          },
        });
        if (familyAdmin) {
          throw new ConflictException({
            code: "FAMILY_ADMIN_HANDOVER_REQUIRED",
          });
        }
        const memberships = await tx.membership.findMany({
          where: { accountId, leftAt: null },
          include: { family: { select: { adminAccountId: true } } },
        });
        for (const membership of memberships) {
          const adminId = membership.family.adminAccountId;
          const adminMembership = await tx.membership.findFirst({
            where: {
              familyId: membership.familyId,
              accountId: adminId,
              leftAt: null,
            },
            select: { id: true },
          });
          if (!adminMembership) {
            throw new ConflictException({
              code: "TASK_HANDOVER_TARGET_UNAVAILABLE",
            });
          }
          await tx.task.updateMany({
            where: {
              familyId: membership.familyId,
              managerId: accountId,
              status: "OPEN",
              deletedAt: null,
            },
            data: {
              managerId: adminId,
              managerMembershipId: adminMembership.id,
              version: { increment: 1 },
            },
          });
          await tx.task.updateMany({
            where: {
              familyId: membership.familyId,
              assigneeId: accountId,
              status: "OPEN",
              deletedAt: null,
            },
            data: { assigneeId: null, version: { increment: 1 } },
          });
          const rules = await tx.recurringRule.findMany({
            where: { familyId: membership.familyId, managerId: accountId },
            select: { id: true },
          });
          await tx.recurringRule.updateMany({
            where: { familyId: membership.familyId, managerId: accountId },
            data: {
              managerId: adminId,
              managerMembershipId: adminMembership.id,
              version: { increment: 1 },
            },
          });
          for (const rule of rules) {
            await tx.occurrence.updateMany({
              where: {
                ruleId: rule.id,
                managerId: accountId,
                status: "PENDING",
              },
              data: { managerId: adminId, version: { increment: 1 } },
            });
          }
        }
      }

      const changed = await tx.account.updateMany({
        where: { id: accountId, version, status: account.status },
        data: {
          status: enabled ? "ACTIVE" : "DISABLED",
          authVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const updated = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      if (!enabled) {
        await tx.session.updateMany({
          where: { accountId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await tx.auditEvent.create({
        data: {
          actorId,
          action: enabled ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED",
          subjectType: "ACCOUNT",
          subjectId: accountId,
        },
      });
      return accountSummary(updated);
    });
  }
}
