import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../../shared/auth/password.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { ReportsService } from "../reports/reports.service.js";

type CreateShare = {
  space: "personal" | "family";
  familyId?: string | undefined;
  origin: "all" | "personal" | "family";
  from: string;
  to: string;
  period: "day" | "month" | "year";
  expiresInDays: 1 | 7 | 30;
  passcode?: string | undefined;
};

const MAX_UNLOCK_ATTEMPTS = 8;
const SHARE_SESSION_MS = 30 * 60 * 1000;
const SHARE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function maxDate(left: string, right: string) {
  return left > right ? left : right;
}

@Injectable()
export class SharesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  async create(ownerId: string, input: CreateShare) {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + input.expiresInDays * 86_400_000,
    );
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token);
    const familyIds = new Set<string>();
    const dependencyRoles = new Map<string, "MEMBER" | "ADMIN">();

    if (input.space === "family") {
      const family = await this.prisma.family.findUnique({
        where: { id: input.familyId! },
        select: { id: true, adminAccountId: true, status: true },
      });
      const membership = await this.prisma.membership.findFirst({
        where: { familyId: input.familyId!, accountId: ownerId, leftAt: null },
        select: { id: true },
      });
      if (!family || !membership)
        throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
      if (family.status !== "ACTIVE")
        throw new ConflictException({ code: "FAMILY_ARCHIVED" });
      if (family.adminAccountId !== ownerId)
        throw new ForbiddenException({ code: "FAMILY_ADMIN_REQUIRED" });
      familyIds.add(family.id);
      dependencyRoles.set(family.id, "ADMIN");
    } else if (input.origin !== "personal") {
      const range = { gte: date(input.from), lte: date(input.to) };
      const dependencies = await this.prisma.expense.findMany({
        where: {
          payerId: ownerId,
          familyId: { not: null },
          deletedAt: null,
          OR: [
            { occurredOn: range },
            { refunds: { some: { deletedAt: null, occurredOn: range } } },
          ],
        },
        select: { familyId: true },
      });
      for (const dependency of dependencies) {
        if (dependency.familyId) {
          familyIds.add(dependency.familyId);
          dependencyRoles.set(dependency.familyId, "MEMBER");
        }
      }
    }

    const reportQuery = {
      space: input.space,
      ...(input.familyId ? { familyId: input.familyId } : {}),
      origin: input.origin,
      from: input.from,
      to: input.to,
      period: input.period,
      granularity:
        input.period === "year" ? ("month" as const) : ("day" as const),
      basis: "net" as const,
    };
    // Keep the report reads sequential: the local PGlite adapter only supports
    // one active connection, and parallel Prisma queries can close its socket.
    const summary = await this.reports.summary(ownerId, reportQuery);
    const trend = await this.reports.trend(ownerId, reportQuery);
    const categories = await this.reports.categories(ownerId, reportQuery);
    const payload = {
      summary,
      trend: trend.points,
      categories: categories.map(({ code, name, expense, refund, net }) => ({
        code,
        name,
        expense,
        refund,
        net,
      })),
    } satisfies Prisma.InputJsonObject;
    const passcodeHash = input.passcode
      ? await hashPassword(input.passcode)
      : null;

    const snapshot = await this.prisma.$transaction(async (tx) => {
      for (const familyId of [...familyIds].sort()) {
        await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${familyId}::uuid`;
        const family = await tx.family.findUnique({
          where: { id: familyId },
          select: { status: true, adminAccountId: true },
        });
        const membership = await tx.membership.findFirst({
          where: { familyId, accountId: ownerId, leftAt: null },
          select: { id: true },
        });
        if (
          !family ||
          family.status !== "ACTIVE" ||
          !membership ||
          (dependencyRoles.get(familyId) === "ADMIN" &&
            family.adminAccountId !== ownerId)
        ) {
          throw new ConflictException({ code: "SHARE_SCOPE_CHANGED" });
        }
      }
      const created = await tx.shareSnapshot.create({
        data: {
          ownerId,
          familyId: input.space === "family" ? input.familyId! : null,
          tokenHash,
          passcodeHash,
          aggregatePayload: payload,
          rangeFrom: date(input.from),
          rangeTo: date(input.to),
          period: input.period,
          scopeLabel: summary.scopeLabel,
          expiresAt,
          dependencies: {
            create: await Promise.all(
              [...familyIds].map(async (familyId) => {
                const membership = await tx.membership.findFirstOrThrow({
                  where: { familyId, accountId: ownerId, leftAt: null },
                  select: { id: true },
                });
                return {
                  familyId,
                  membershipId: membership.id,
                  requiredRole: dependencyRoles.get(familyId) ?? "MEMBER",
                };
              }),
            ),
          },
        },
        select: {
          id: true,
          familyId: true,
          version: true,
          generatedAt: true,
          expiresAt: true,
          rangeFrom: true,
          rangeTo: true,
          period: true,
          scopeLabel: true,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: ownerId,
          action: "SHARE_SNAPSHOT_CREATED",
          subjectType: "SHARE_SNAPSHOT",
          subjectId: created.id,
          details: {
            familyId: created.familyId,
            expiresInDays: input.expiresInDays,
          },
        },
      });
      return created;
    });

    return {
      ...this.publicMetadata(snapshot),
      token,
      path: `/s/${token}`,
      hasPasscode: Boolean(passcodeHash),
    };
  }

  private publicMetadata(snapshot: {
    id: string;
    generatedAt: Date;
    expiresAt: Date;
    rangeFrom: Date;
    rangeTo: Date;
    period: string;
    scopeLabel: string;
  }) {
    return {
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      expiresAt: snapshot.expiresAt,
      from: snapshot.rangeFrom.toISOString().slice(0, 10),
      to: snapshot.rangeTo.toISOString().slice(0, 10),
      period: snapshot.period,
      scopeLabel: snapshot.scopeLabel,
    };
  }

  private async invalidate(snapshotId: string, now: Date) {
    await this.prisma.shareSnapshot.updateMany({
      where: { id: snapshotId, invalidatedAt: null },
      data: {
        invalidatedAt: now,
        purgeAfter: new Date(now.getTime() + SHARE_RETENTION_MS),
        version: { increment: 1 },
      },
    });
  }

  private async authorizationStillValid(snapshot: {
    id: string;
    ownerId: string;
    familyId: string | null;
    owner: { status: string };
    dependencies: Array<{
      familyId: string;
      membershipId: string | null;
      requiredRole: string;
    }>;
  }) {
    if (snapshot.owner.status !== "ACTIVE") return false;
    for (const dependency of snapshot.dependencies) {
      if (!dependency.membershipId) return false;
      const family = await this.prisma.family.findUnique({
        where: { id: dependency.familyId },
        select: { status: true, adminAccountId: true },
      });
      const membership = await this.prisma.membership.findFirst({
        where: {
          id: dependency.membershipId,
          familyId: dependency.familyId,
          accountId: snapshot.ownerId,
          leftAt: null,
        },
        select: { id: true },
      });
      if (
        !family ||
        family.status !== "ACTIVE" ||
        !membership ||
        (dependency.requiredRole === "ADMIN" &&
          family.adminAccountId !== snapshot.ownerId)
      ) {
        return false;
      }
    }
    if (snapshot.familyId && !snapshot.dependencies.length) return false;
    return true;
  }

  private async loadSnapshotByToken(token: string) {
    const snapshot = await this.prisma.shareSnapshot.findUnique({
      where: { tokenHash: hash(token) },
    });
    if (!snapshot) return null;
    const owner = await this.prisma.account.findUnique({
      where: { id: snapshot.ownerId },
      select: { status: true },
    });
    const dependencies = await this.prisma.shareDependency.findMany({
      where: { snapshotId: snapshot.id },
    });
    return {
      ...snapshot,
      owner: owner ?? { status: "DISABLED" },
      dependencies,
    };
  }

  private async status(
    snapshot: NonNullable<
      Awaited<ReturnType<SharesService["loadSnapshotByToken"]>>
    >,
  ) {
    const now = new Date();
    if (snapshot.revokedAt || snapshot.invalidatedAt)
      return "unavailable" as const;
    if (snapshot.expiresAt <= now) {
      await this.prisma.shareSnapshot.updateMany({
        where: { id: snapshot.id, purgeAfter: null },
        data: {
          purgeAfter: new Date(
            snapshot.expiresAt.getTime() + SHARE_RETENTION_MS,
          ),
        },
      });
      return "unavailable" as const;
    }
    if (!(await this.authorizationStillValid(snapshot))) {
      await this.invalidate(snapshot.id, now);
      return "unavailable" as const;
    }
    return "available" as const;
  }

  async publicView(token: string, cookieToken?: string) {
    const snapshot = await this.loadSnapshotByToken(token);
    if (!snapshot) return { status: "unavailable" as const };
    if ((await this.status(snapshot)) !== "available")
      return { status: "unavailable" as const };
    if (snapshot.passcodeHash) {
      if (!cookieToken) return { status: "locked" as const };
      const accessSession = await this.prisma.shareAccessSession.findUnique({
        where: { tokenHash: hash(cookieToken) },
        select: { snapshotId: true, expiresAt: true },
      });
      if (
        !accessSession ||
        accessSession.snapshotId !== snapshot.id ||
        accessSession.expiresAt <= new Date()
      ) {
        return { status: "locked" as const };
      }
    }
    return {
      status: "available" as const,
      ...this.publicMetadata(snapshot),
      payload: snapshot.aggregatePayload,
    };
  }

  private async consumeUnlockAttempt(tokenHash: string, ip: string) {
    const keyHash = hash(`${tokenHash}\0${ip}`);
    const rows = await this.prisma.$queryRaw<Array<{ attempts: number }>>`
      INSERT INTO share_unlock_attempts (key_hash, window_at, attempts)
      VALUES (${keyHash}, now(), 1)
      ON CONFLICT (key_hash) DO UPDATE SET
        attempts = CASE
          WHEN share_unlock_attempts.window_at <= now() - interval '15 minutes' THEN 1
          ELSE share_unlock_attempts.attempts + 1
        END,
        window_at = CASE
          WHEN share_unlock_attempts.window_at <= now() - interval '15 minutes' THEN now()
          ELSE share_unlock_attempts.window_at
        END
      RETURNING attempts
    `;
    if ((rows[0]?.attempts ?? MAX_UNLOCK_ATTEMPTS + 1) > MAX_UNLOCK_ATTEMPTS) {
      throw new HttpException(
        { code: "SHARE_UNLOCK_RATE_LIMITED" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return keyHash;
  }

  async unlock(token: string, passcode: string, ip: string) {
    const tokenHash = hash(token);
    const attemptKey = await this.consumeUnlockAttempt(tokenHash, ip);
    const snapshot = await this.loadSnapshotByToken(token);
    if (
      !snapshot ||
      !snapshot.passcodeHash ||
      (await this.status(snapshot)) !== "available" ||
      !(await verifyPassword(snapshot.passcodeHash, passcode).catch(
        () => false,
      ))
    ) {
      throw new ForbiddenException({ code: "SHARE_UNLOCK_INVALID" });
    }
    await this.prisma.shareUnlockAttempt.deleteMany({
      where: { keyHash: attemptKey },
    });
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Math.min(Date.now() + SHARE_SESSION_MS, snapshot.expiresAt.getTime()),
    );
    await this.prisma.shareAccessSession.create({
      data: {
        snapshotId: snapshot.id,
        tokenHash: hash(rawToken),
        expiresAt,
      },
    });
    return { rawToken, expiresAt };
  }

  private async owned(snapshotId: string, ownerId: string) {
    const snapshot = await this.prisma.shareSnapshot.findFirst({
      where: { id: snapshotId, ownerId },
    });
    if (!snapshot) throw new NotFoundException({ code: "SHARE_NOT_FOUND" });
    const owner = await this.prisma.account.findUnique({
      where: { id: snapshot.ownerId },
      select: { status: true },
    });
    const dependencies = await this.prisma.shareDependency.findMany({
      where: { snapshotId: snapshot.id },
    });
    return {
      ...snapshot,
      owner: owner ?? { status: "DISABLED" },
      dependencies,
    };
  }

  private async managementStatus(
    snapshot: NonNullable<Awaited<ReturnType<SharesService["owned"]>>>,
  ) {
    if (snapshot.revokedAt) return "REVOKED" as const;
    if (snapshot.invalidatedAt) return "INVALIDATED" as const;
    if (snapshot.expiresAt <= new Date()) {
      await this.prisma.shareSnapshot.updateMany({
        where: { id: snapshot.id, purgeAfter: null },
        data: {
          purgeAfter: new Date(
            snapshot.expiresAt.getTime() + SHARE_RETENTION_MS,
          ),
        },
      });
      return "EXPIRED" as const;
    }
    if (!(await this.authorizationStillValid(snapshot))) {
      await this.invalidate(snapshot.id, new Date());
      return "INVALIDATED" as const;
    }
    return "ACTIVE" as const;
  }

  private async managementDto(
    snapshot: NonNullable<Awaited<ReturnType<SharesService["owned"]>>>,
  ) {
    return {
      ...this.publicMetadata(snapshot),
      version: snapshot.version,
      hasPasscode: Boolean(snapshot.passcodeHash),
      status: await this.managementStatus(snapshot),
    };
  }

  async listOwned(ownerId: string) {
    const snapshots = await this.prisma.shareSnapshot.findMany({
      where: { ownerId },
      orderBy: { generatedAt: "desc" },
      take: 100,
    });
    const items = [];
    for (const snapshot of snapshots) {
      items.push(
        await this.managementDto(await this.owned(snapshot.id, ownerId)),
      );
    }
    return items;
  }

  async getOwned(snapshotId: string, ownerId: string) {
    return this.managementDto(await this.owned(snapshotId, ownerId));
  }

  async revoke(snapshotId: string, ownerId: string, version: number) {
    const snapshot = await this.owned(snapshotId, ownerId);
    if (
      snapshot.version !== version ||
      snapshot.revokedAt ||
      snapshot.invalidatedAt
    )
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    const now = new Date();
    const updated = await this.prisma.shareSnapshot.updateMany({
      where: {
        id: snapshotId,
        ownerId,
        version,
        revokedAt: null,
        invalidatedAt: null,
      },
      data: {
        revokedAt: now,
        purgeAfter: new Date(now.getTime() + SHARE_RETENTION_MS),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    await this.prisma.shareAccessSession.deleteMany({ where: { snapshotId } });
    return { id: snapshotId, revokedAt: now, version: version + 1 };
  }

  async cleanup() {
    const now = new Date();
    await this.prisma.$executeRaw`
      UPDATE share_snapshots
      SET purge_after = expires_at + interval '30 days'
      WHERE expires_at <= ${now} AND purge_after IS NULL
    `;
    const expired = await this.prisma.shareSnapshot.findMany({
      where: { purgeAfter: { lte: now } },
      select: { id: true },
      take: 100,
      orderBy: { purgeAfter: "asc" },
    });
    for (const { id } of expired) {
      await this.prisma.$transaction(async (tx) => {
        await tx.shareAccessSession.deleteMany({ where: { snapshotId: id } });
        await tx.shareDependency.deleteMany({ where: { snapshotId: id } });
        await tx.shareSnapshot.deleteMany({
          where: { id, purgeAfter: { lte: now } },
        });
      });
    }
    await this.prisma.shareUnlockAttempt.deleteMany({
      where: {
        windowAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    });
    return { purged: expired.length };
  }
}
