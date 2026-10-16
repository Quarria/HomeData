import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";
import {
  ReceiptStorageService,
  type UploadedReceipt,
} from "./receipt-storage.service.js";

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Scope = "personal" | "family";
type ExpenseInput = {
  title: string;
  categoryId: string;
  occurredOn: string;
  amount: string;
  quantity?: string | undefined;
  unit?: string | undefined;
  unitPrice?: string | undefined;
  familyId?: string | null | undefined;
  confirmFamilyVisible?: boolean | undefined;
  note?: string | null | undefined;
};
type ExpensePatchInput = {
  version: number;
  title?: string | undefined;
  categoryId?: string | undefined;
  occurredOn?: string | undefined;
  amount?: string | undefined;
  quantity?: string | null | undefined;
  unit?: string | null | undefined;
  unitPrice?: string | null | undefined;
  familyId?: string | null | undefined;
  confirmFamilyVisible?: boolean | undefined;
  note?: string | null | undefined;
};

function cents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function money(value: bigint) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateString(value: Date) {
  return value.toISOString().slice(0, 10);
}

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const expenseInclude = {
  category: true,
  payer: { select: { id: true, nickname: true } },
  family: { select: { id: true, name: true, status: true } },
  refunds: {
    where: { deletedAt: null },
    select: { id: true, amountCents: true, occurredOn: true, version: true },
  },
  receiptLinks: {
    include: {
      receipt: {
        select: {
          id: true,
          mimeType: true,
          privacyLock: true,
          uploadedById: true,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.ExpenseInclude;

@Injectable()
export class LedgerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReceiptStorageService)
    private readonly receiptStorage: ReceiptStorageService,
  ) {}

  async uploadReceipt(accountId: string, file: UploadedReceipt) {
    const stored = await this.receiptStorage.store(file);
    try {
      const receipt = await this.prisma.receipt.create({
        data: { uploadedById: accountId, ...stored },
        select: { id: true, mimeType: true, sizeBytes: true },
      });
      return {
        ...receipt,
        contentUrl: `/api/v1/receipts/${receipt.id}/content`,
      };
    } catch (error) {
      await this.receiptStorage.remove(stored.storageKey);
      throw error;
    }
  }

  async receiptContent(receiptId: string, accountId: string) {
    const receipt = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      include: {
        links: {
          select: {
            expense: { select: { payerId: true, familyId: true } },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
    let canRead = receipt.uploadedById === accountId;
    if (!canRead && receipt.privacyLock === "FAMILY") {
      for (const { expense } of receipt.links) {
        if (!expense.familyId) continue;
        if (expense.payerId === accountId) {
          canRead = true;
          break;
        }
        const membership = await this.prisma.membership.findFirst({
          where: { familyId: expense.familyId, accountId, leftAt: null },
          select: { id: true },
        });
        if (membership) {
          canRead = true;
          break;
        }
      }
    }
    if (!canRead) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
    return {
      buffer: await this.receiptStorage.read(receipt.storageKey),
      mimeType: receipt.mimeType,
      sizeBytes: receipt.sizeBytes,
    };
  }

  async linkReceipt(
    expenseId: string,
    receiptId: string,
    accountId: string,
    confirmFamilyVisible: boolean,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense || expense.deletedAt)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      await this.assertWritable(tx, expense, accountId);
      const receipt = await tx.receipt.findUnique({
        where: { id: receiptId },
        include: {
          links: { include: { expense: { select: { familyId: true } } } },
        },
      });
      if (!receipt || receipt.uploadedById !== accountId)
        throw new NotFoundException({ code: "RECEIPT_NOT_FOUND" });
      const canShareWithFamily =
        Boolean(expense.familyId) &&
        confirmFamilyVisible &&
        receipt.links.length === 0;
      const mustRemainPrivate =
        !expense.familyId ||
        receipt.links.some(
          ({ expense: linkedExpense }) =>
            !linkedExpense.familyId ||
            linkedExpense.familyId !== expense.familyId,
        );
      if (mustRemainPrivate) {
        await tx.receipt.update({
          where: { id: receiptId },
          data: { privacyLock: "PRIVATE" },
        });
      } else if (canShareWithFamily) {
        await tx.receipt.update({
          where: { id: receiptId },
          data: { privacyLock: "FAMILY" },
        });
      }
      const link = await tx.receiptLink.upsert({
        where: { receiptId_expenseId: { receiptId, expenseId } },
        create: { receiptId, expenseId },
        update: {},
        select: { id: true },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "RECEIPT_LINKED",
          subjectType: "EXPENSE",
          subjectId: expenseId,
          details: { receiptId },
        },
      });
      return {
        id: link.id,
        receiptId,
        privacy: mustRemainPrivate
          ? "PRIVATE"
          : canShareWithFamily
            ? "FAMILY"
            : receipt.privacyLock,
      };
    });
  }

  async unlinkReceipt(
    expenseId: string,
    linkId: string,
    accountId: string,
    version: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense || expense.deletedAt)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      await this.assertWritable(tx, expense, accountId);
      if (expense.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const link = await tx.receiptLink.findFirst({
        where: { id: linkId, expenseId },
        select: { id: true },
      });
      if (!link)
        throw new NotFoundException({ code: "RECEIPT_LINK_NOT_FOUND" });
      await tx.receiptLink.delete({ where: { id: linkId } });
      await tx.expense.update({
        where: { id: expenseId },
        data: { version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "RECEIPT_UNLINKED",
          subjectType: "EXPENSE",
          subjectId: expenseId,
          details: { linkId },
        },
      });
      return { deleted: true, id: linkId };
    });
  }

  categories() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, code: true, name: true, sortOrder: true },
    });
  }

  private async readExpense(
    expenseId: string,
    accountId: string,
    allowDeleted = true,
  ) {
    // Keep the related reads on a single connection. Prisma's pg adapter can
    // pipeline relation queries through a pooled client, which the local
    // PGlite wire server does not safely support outside a transaction.
    const expense = await this.prisma.$transaction((tx) =>
      tx.expense.findUnique({
        where: { id: expenseId },
        include: expenseInclude,
      }),
    );
    if (!expense || (!allowDeleted && expense.deletedAt)) {
      throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
    }
    await this.assertReadable(expense, accountId);
    const currentFamilyMember = expense.familyId
      ? Boolean(
          await this.prisma.membership.findFirst({
            where: { familyId: expense.familyId, accountId, leftAt: null },
            select: { id: true },
          }),
        )
      : true;
    return this.dto(expense, accountId, currentFamilyMember);
  }

  private async assertReadable(
    expense: { payerId: string; familyId: string | null },
    accountId: string,
  ) {
    if (expense.familyId && expense.payerId !== accountId) {
      const membership = await this.prisma.membership.findFirst({
        where: {
          familyId: expense.familyId,
          accountId,
          leftAt: null,
          account: { status: "ACTIVE" },
        },
      });
      if (!membership)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
    } else if (!expense.familyId && expense.payerId !== accountId) {
      throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
    }
  }

  private async assertWritable(
    tx: Prisma.TransactionClient,
    expense: { payerId: string; familyId: string | null },
    accountId: string,
  ) {
    if (expense.payerId !== accountId) {
      throw new ForbiddenException({ code: "EXPENSE_PAYER_REQUIRED" });
    }
    if (expense.familyId) {
      await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${expense.familyId}::uuid`;
      const family = await tx.family.findUnique({
        where: { id: expense.familyId },
      });
      const membership = await tx.membership.findFirst({
        where: { familyId: expense.familyId, accountId, leftAt: null },
      });
      if (!family || !membership) {
        throw new ForbiddenException({ code: "FAMILY_MEMBERSHIP_REQUIRED" });
      }
      if (family.status !== "ACTIVE") {
        throw new ConflictException({ code: "FAMILY_ARCHIVED" });
      }
    }
  }

  private async assertTargetFamily(
    tx: Prisma.TransactionClient,
    familyId: string | null | undefined,
    accountId: string,
  ) {
    if (!familyId) return null;
    await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${familyId}::uuid`;
    const family = await tx.family.findUnique({ where: { id: familyId } });
    const membership = await tx.membership.findFirst({
      where: { familyId, accountId, leftAt: null },
    });
    if (!family || !membership) {
      throw new ForbiddenException({ code: "FAMILY_MEMBERSHIP_REQUIRED" });
    }
    if (family.status !== "ACTIVE") {
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    }
    return family;
  }

  private async lockExpense(tx: Prisma.TransactionClient, expenseId: string) {
    await tx.$executeRaw`UPDATE expenses SET version = version WHERE id = ${expenseId}::uuid`;
    const expense = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
    return expense;
  }

  private async lockOccurrence(
    tx: Prisma.TransactionClient,
    occurrenceId: string,
  ) {
    await tx.$executeRaw`UPDATE occurrences SET version = version WHERE id = ${occurrenceId}::uuid`;
  }

  private async activeRefundTotal(
    tx: Prisma.TransactionClient,
    expenseId: string,
    exceptRefundId?: string,
  ) {
    const result = await tx.refund.aggregate({
      where: {
        expenseId,
        deletedAt: null,
        ...(exceptRefundId ? { id: { not: exceptRefundId } } : {}),
      },
      _sum: { amountCents: true },
    });
    return result._sum.amountCents ?? 0n;
  }

  private dto(
    expense: Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>,
    accountId: string,
    currentFamilyMember: boolean,
  ) {
    const refundCents = expense.refunds.reduce(
      (sum, refund) => sum + refund.amountCents,
      0n,
    );
    const canWrite =
      expense.payerId === accountId &&
      currentFamilyMember &&
      (!expense.familyId || expense.family?.status === "ACTIVE");
    const restorable =
      expense.deletedAt !== null &&
      expense.purgeAfter !== null &&
      expense.purgeAfter.getTime() > Date.now();
    return {
      id: expense.id,
      title: expense.title,
      category: expense.category,
      occurredOn: dateString(expense.occurredOn),
      amount: money(expense.amountCents),
      quantity: expense.quantity?.toString() ?? null,
      unit: expense.unit,
      unitPrice: expense.unitPrice?.toFixed(2) ?? null,
      note: expense.note,
      familyId: expense.familyId,
      scope: expense.familyId ? "FAMILY" : "PERSONAL",
      familyName: expense.family?.name ?? null,
      payer: expense.payer,
      refund: money(refundCents),
      net: money(expense.amountCents - refundCents),
      refunds: expense.refunds.map((refund) => ({
        id: refund.id,
        amount: money(refund.amountCents),
        occurredOn: dateString(refund.occurredOn),
        version: refund.version,
      })),
      receipts: expense.receiptLinks
        .filter(
          ({ receipt }) =>
            receipt.uploadedById === accountId ||
            (Boolean(expense.familyId) &&
              currentFamilyMember &&
              receipt.privacyLock === "FAMILY"),
        )
        .map(({ id, receipt }) => ({
          linkId: id,
          id: receipt.id,
          mimeType: receipt.mimeType,
          contentUrl: `/api/v1/receipts/${receipt.id}/content`,
        })),
      deletedAt: expense.deletedAt?.toISOString() ?? null,
      purgeAfter: expense.purgeAfter?.toISOString() ?? null,
      version: expense.version,
      capabilities: {
        canEdit: canWrite && !expense.deletedAt,
        canRefund: canWrite && !expense.deletedAt,
        canDelete: canWrite && !expense.deletedAt,
        canRestore: canWrite && restorable,
      },
    };
  }

  async list(
    accountId: string,
    input: {
      space: Scope;
      familyId?: string | undefined;
      origin: "all" | "personal" | "family";
      from?: string | undefined;
      to?: string | undefined;
      categoryId?: string | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
      limit: number;
      deleted: "true" | "false";
    },
  ) {
    const where: Prisma.ExpenseWhereInput = {
      ...(input.deleted === "true"
        ? { deletedAt: { not: null }, purgeAfter: { gt: new Date() } }
        : { deletedAt: null }),
      ...(input.from || input.to
        ? {
            occurredOn: {
              ...(input.from ? { gte: date(input.from) } : {}),
              ...(input.to ? { lte: date(input.to) } : {}),
            },
          }
        : {}),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      ...(input.q
        ? {
            OR: [
              { title: { contains: input.q, mode: "insensitive" } },
              { note: { contains: input.q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(input.space === "personal"
        ? {
            payerId: accountId,
            ...(input.origin === "personal"
              ? { familyId: null }
              : input.origin === "family"
                ? { familyId: { not: null } }
                : {}),
          }
        : await this.familyReadWhere(accountId, input.familyId)),
    };
    const rows = await this.prisma.$transaction((tx) =>
      tx.expense.findMany({
        where,
        include: expenseInclude,
        orderBy: [
          { occurredOn: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
    );
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const activeFamilyId = await this.currentFamilyId(accountId);
    return {
      items: page.map((row) =>
        this.dto(
          row,
          accountId,
          !row.familyId || row.familyId === activeFamilyId,
        ),
      ),
      nextCursor: hasMore ? page.at(-1)!.id : null,
    };
  }

  private async familyReadWhere(accountId: string, familyId?: string) {
    if (!familyId) throw new ConflictException({ code: "FAMILY_ID_REQUIRED" });
    const membership = await this.prisma.membership.findFirst({
      where: { familyId, accountId, leftAt: null },
    });
    if (!membership) throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    return { familyId };
  }

  private async currentFamilyId(accountId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { accountId, leftAt: null },
      select: { familyId: true },
    });
    return membership?.familyId ?? null;
  }

  async get(expenseId: string, accountId: string) {
    return this.readExpense(expenseId, accountId);
  }

  private async idempotent<T>(
    accountId: string,
    operation: string,
    key: string,
    input: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const hash = requestHash(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const where = {
          actorId_operation_key: { actorId: accountId, operation, key },
        };
        const existing = await tx.idempotencyRecord.findUnique({ where });
        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestHash !== hash) {
            throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
          }
          if (existing.response === null) {
            throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
          }
          return existing.response as T;
        }
        if (existing) {
          await tx.idempotencyRecord.delete({ where: { id: existing.id } });
        }
        const reservation = await tx.idempotencyRecord.create({
          data: {
            actorId: accountId,
            operation,
            key,
            requestHash: hash,
            response: Prisma.DbNull,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
          },
        });
        const result = await work(tx);
        await tx.idempotencyRecord.update({
          where: { id: reservation.id },
          data: { response: result as Prisma.InputJsonValue },
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: {
            actorId_operation_key: { actorId: accountId, operation, key },
          },
        });
        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestHash !== hash) {
            throw new ConflictException({ code: "IDEMPOTENCY_MISMATCH" });
          }
          if (existing.response !== null) return existing.response as T;
          throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
        }
      }
      throw error;
    }
  }

  async create(accountId: string, input: ExpenseInput, key: string) {
    return this.idempotent(
      accountId,
      "expense.create",
      key,
      input,
      async (tx) => {
        await this.assertTargetFamily(tx, input.familyId, accountId);
        const category = await tx.category.findUnique({
          where: { id: input.categoryId },
        });
        if (!category || !category.isActive) {
          throw new ConflictException({ code: "CATEGORY_UNAVAILABLE" });
        }
        const expense = await tx.expense.create({
          data: {
            payerId: accountId,
            familyId: input.familyId ?? null,
            categoryId: input.categoryId,
            title: input.title,
            occurredOn: date(input.occurredOn),
            amountCents: cents(input.amount),
            quantity: input.quantity
              ? new Prisma.Decimal(input.quantity)
              : null,
            unit: input.unit ?? null,
            unitPrice: input.unitPrice
              ? new Prisma.Decimal(input.unitPrice)
              : null,
            note: input.note || null,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: accountId,
            action: "EXPENSE_CREATED",
            subjectType: "EXPENSE",
            subjectId: expense.id,
            details: {
              amount: input.amount,
              familyId: input.familyId ?? null,
              categoryId: input.categoryId,
            },
          },
        });
        const result = await tx.expense.findUniqueOrThrow({
          where: { id: expense.id },
          include: expenseInclude,
        });
        return this.dto(result, accountId, true);
      },
    );
  }

  async update(expenseId: string, accountId: string, input: ExpensePatchInput) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!current || current.deletedAt) {
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      }
      if (current.familyId) await this.assertWritable(tx, current, accountId);
      else if (current.payerId !== accountId)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      await this.lockExpense(tx, expenseId);
      const fresh = await tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
      });
      if (fresh.familyId !== current.familyId) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      if (fresh.version !== input.version) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      const targetFamilyId =
        input.familyId === undefined ? fresh.familyId : input.familyId;
      if (targetFamilyId !== fresh.familyId) {
        if (targetFamilyId && !input.confirmFamilyVisible) {
          throw new ConflictException({
            code: "FAMILY_VISIBILITY_CONFIRMATION_REQUIRED",
          });
        }
        await this.assertTargetFamily(tx, targetFamilyId, accountId);
      }
      const categoryId = input.categoryId ?? fresh.categoryId;
      if (categoryId !== fresh.categoryId) {
        const category = await tx.category.findUnique({
          where: { id: categoryId },
        });
        if (!category || !category.isActive)
          throw new ConflictException({ code: "CATEGORY_UNAVAILABLE" });
      }
      const amountCents =
        input.amount === undefined ? fresh.amountCents : cents(input.amount);
      if (amountCents < (await this.activeRefundTotal(tx, expenseId))) {
        throw new ConflictException({ code: "REFUND_EXCEEDS_EXPENSE" });
      }
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.categoryId !== undefined ? { categoryId } : {}),
          ...(input.occurredOn !== undefined
            ? { occurredOn: date(input.occurredOn) }
            : {}),
          ...(input.amount !== undefined ? { amountCents } : {}),
          ...(input.quantity !== undefined
            ? {
                quantity: input.quantity
                  ? new Prisma.Decimal(input.quantity)
                  : null,
              }
            : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.unitPrice !== undefined
            ? {
                unitPrice: input.unitPrice
                  ? new Prisma.Decimal(input.unitPrice)
                  : null,
              }
            : {}),
          ...(input.familyId !== undefined ? { familyId: targetFamilyId } : {}),
          ...(input.note !== undefined ? { note: input.note || null } : {}),
          version: { increment: 1 },
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "EXPENSE_UPDATED",
          subjectType: "EXPENSE",
          subjectId: expenseId,
          details: { version: input.version + 1 },
        },
      });
      const result = await tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
        include: expenseInclude,
      });
      return this.dto(result, accountId, true);
    });
  }

  async remove(expenseId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!current || current.deletedAt)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      await this.assertWritable(tx, current, accountId);
      if (current.occurrenceId)
        await this.lockOccurrence(tx, current.occurrenceId);
      await this.lockExpense(tx, expenseId);
      const expense = await tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
      });
      if (expense.familyId !== current.familyId) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      if (expense.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const occurrence = expense.occurrenceId
        ? await tx.occurrence.findUnique({
            where: { id: expense.occurrenceId },
          })
        : null;
      if (
        expense.occurrenceId &&
        (!occurrence ||
          occurrence.status !== "PAID" ||
          occurrence.activeExpenseId !== expense.id)
      ) {
        throw new ConflictException({ code: "PERIOD_ALREADY_PAID" });
      }
      const now = new Date();
      const deleteBatchId = randomUUID();
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + RESTORE_WINDOW_MS),
          deleteBatchId,
          version: { increment: 1 },
        },
      });
      await tx.refund.updateMany({
        where: { expenseId, deletedAt: null },
        data: {
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + RESTORE_WINDOW_MS),
          deleteBatchId,
          version: { increment: 1 },
        },
      });
      if (occurrence) {
        await tx.occurrence.update({
          where: { id: occurrence.id },
          data: {
            status: "PENDING",
            activeExpenseId: null,
            version: { increment: 1 },
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "EXPENSE_DELETED",
          subjectType: "EXPENSE",
          subjectId: expenseId,
          details: {
            purgeAfter: new Date(
              now.getTime() + RESTORE_WINDOW_MS,
            ).toISOString(),
          },
        },
      });
      return {
        deleted: true,
        id: expenseId,
        purgeAfter: new Date(now.getTime() + RESTORE_WINDOW_MS).toISOString(),
      };
    });
  }

  async restoreExpense(expenseId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!current || !current.deletedAt || !current.deleteBatchId)
        throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
      await this.assertWritable(tx, current, accountId);
      if (current.occurrenceId)
        await this.lockOccurrence(tx, current.occurrenceId);
      await this.lockExpense(tx, expenseId);
      const expense = await tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
      });
      if (expense.familyId !== current.familyId) {
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      }
      if (expense.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (!expense.purgeAfter || expense.purgeAfter.getTime() <= Date.now())
        throw new ConflictException({ code: "RESTORE_EXPIRED" });
      const occurrence = expense.occurrenceId
        ? await tx.occurrence.findUnique({
            where: { id: expense.occurrenceId },
          })
        : null;
      if (expense.occurrenceId && !occurrence)
        throw new ConflictException({ code: "OCCURRENCE_NOT_FOUND" });
      if (occurrence?.status === "SKIPPED")
        throw new ConflictException({ code: "PERIOD_SKIPPED" });
      if (
        occurrence &&
        (occurrence.status !== "PENDING" || occurrence.activeExpenseId !== null)
      ) {
        throw new ConflictException({ code: "PERIOD_ALREADY_PAID" });
      }
      const restoreRefunds = await tx.refund.findMany({
        where: {
          expenseId,
          deleteBatchId: expense.deleteBatchId,
          deletedAt: { not: null },
          purgeAfter: { gt: new Date() },
        },
        select: { amountCents: true },
      });
      const total = restoreRefunds.reduce(
        (sum, refund) => sum + refund.amountCents,
        0n,
      );
      if (total > expense.amountCents)
        throw new ConflictException({ code: "REFUND_EXCEEDS_EXPENSE" });
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          deletedAt: null,
          purgeAfter: null,
          deleteBatchId: null,
          version: { increment: 1 },
        },
      });
      await tx.refund.updateMany({
        where: {
          expenseId,
          deleteBatchId: expense.deleteBatchId,
          deletedAt: { not: null },
          purgeAfter: { gt: new Date() },
        },
        data: {
          deletedAt: null,
          purgeAfter: null,
          deleteBatchId: null,
          version: { increment: 1 },
        },
      });
      if (occurrence) {
        await tx.occurrence.update({
          where: { id: occurrence.id },
          data: {
            status: "PAID",
            activeExpenseId: expense.id,
            version: { increment: 1 },
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "EXPENSE_RESTORED",
          subjectType: "EXPENSE",
          subjectId: expenseId,
        },
      });
      const restored = await tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
        include: expenseInclude,
      });
      return this.dto(restored, accountId, true);
    });
  }

  async createRefund(
    expenseId: string,
    accountId: string,
    input: { amount: string; occurredOn: string },
    key: string,
  ) {
    return this.idempotent(
      accountId,
      "refund.create",
      key,
      { expenseId, ...input },
      async (tx) => {
        const current = await tx.expense.findUnique({
          where: { id: expenseId },
        });
        if (!current || current.deletedAt)
          throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
        await this.assertWritable(tx, current, accountId);
        await this.lockExpense(tx, expenseId);
        const expense = await tx.expense.findUniqueOrThrow({
          where: { id: expenseId },
        });
        const next = cents(input.amount);
        if (
          next + (await this.activeRefundTotal(tx, expenseId)) >
          expense.amountCents
        ) {
          throw new ConflictException({ code: "REFUND_EXCEEDS_EXPENSE" });
        }
        const refund = await tx.refund.create({
          data: {
            expenseId,
            amountCents: next,
            occurredOn: date(input.occurredOn),
          },
        });
        await tx.expense.update({
          where: { id: expenseId },
          data: { version: { increment: 1 } },
        });
        await tx.auditEvent.create({
          data: {
            actorId: accountId,
            action: "REFUND_CREATED",
            subjectType: "REFUND",
            subjectId: refund.id,
            details: {
              expenseId,
              amount: input.amount,
              occurredOn: input.occurredOn,
            },
          },
        });
        return {
          id: refund.id,
          expenseId,
          amount: money(refund.amountCents),
          occurredOn: dateString(refund.occurredOn),
          version: refund.version,
        };
      },
    );
  }

  async updateRefund(
    refundId: string,
    accountId: string,
    input: {
      amount?: string | undefined;
      occurredOn?: string | undefined;
      version: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUnique({
        where: { id: refundId },
        include: { expense: true },
      });
      if (!current || current.deletedAt || current.expense.deletedAt)
        throw new NotFoundException({ code: "REFUND_NOT_FOUND" });
      await this.assertWritable(tx, current.expense, accountId);
      await this.lockExpense(tx, current.expenseId);
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
      });
      if (refund.version !== input.version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const amount =
        input.amount === undefined ? refund.amountCents : cents(input.amount);
      if (
        amount +
          (await this.activeRefundTotal(tx, refund.expenseId, refundId)) >
        current.expense.amountCents
      ) {
        throw new ConflictException({ code: "REFUND_EXCEEDS_EXPENSE" });
      }
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: {
          ...(input.amount ? { amountCents: amount } : {}),
          ...(input.occurredOn ? { occurredOn: date(input.occurredOn) } : {}),
          version: { increment: 1 },
        },
      });
      await tx.expense.update({
        where: { id: current.expenseId },
        data: { version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "REFUND_UPDATED",
          subjectType: "REFUND",
          subjectId: refundId,
          details: { expenseId: current.expenseId },
        },
      });
      return {
        id: updated.id,
        expenseId: updated.expenseId,
        amount: money(updated.amountCents),
        occurredOn: dateString(updated.occurredOn),
        version: updated.version,
      };
    });
  }

  async removeRefund(refundId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUnique({
        where: { id: refundId },
        include: { expense: true },
      });
      if (!current || current.deletedAt || current.expense.deletedAt)
        throw new NotFoundException({ code: "REFUND_NOT_FOUND" });
      await this.assertWritable(tx, current.expense, accountId);
      await this.lockExpense(tx, current.expenseId);
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
      });
      if (refund.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      const now = new Date();
      const purgeAfter = new Date(now.getTime() + RESTORE_WINDOW_MS);
      await tx.refund.update({
        where: { id: refundId },
        data: {
          deletedAt: now,
          purgeAfter,
          deleteBatchId: randomUUID(),
          version: { increment: 1 },
        },
      });
      await tx.expense.update({
        where: { id: current.expenseId },
        data: { version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "REFUND_DELETED",
          subjectType: "REFUND",
          subjectId: refundId,
          details: { purgeAfter: purgeAfter.toISOString() },
        },
      });
      return {
        deleted: true,
        id: refundId,
        purgeAfter: purgeAfter.toISOString(),
      };
    });
  }

  async restoreRefund(refundId: string, accountId: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUnique({
        where: { id: refundId },
        include: { expense: true },
      });
      if (!current || !current.deletedAt || current.expense.deletedAt)
        throw new NotFoundException({ code: "REFUND_NOT_FOUND" });
      await this.assertWritable(tx, current.expense, accountId);
      await this.lockExpense(tx, current.expenseId);
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
      });
      if (refund.version !== version)
        throw new ConflictException({ code: "VERSION_CONFLICT" });
      if (!refund.purgeAfter || refund.purgeAfter.getTime() <= Date.now())
        throw new ConflictException({ code: "RESTORE_EXPIRED" });
      if (
        refund.amountCents +
          (await this.activeRefundTotal(tx, refund.expenseId)) >
        current.expense.amountCents
      ) {
        throw new ConflictException({ code: "REFUND_EXCEEDS_EXPENSE" });
      }
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: {
          deletedAt: null,
          purgeAfter: null,
          deleteBatchId: null,
          version: { increment: 1 },
        },
      });
      await tx.expense.update({
        where: { id: current.expenseId },
        data: { version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "REFUND_RESTORED",
          subjectType: "REFUND",
          subjectId: refundId,
        },
      });
      return {
        id: updated.id,
        expenseId: updated.expenseId,
        amount: money(updated.amountCents),
        occurredOn: dateString(updated.occurredOn),
        version: updated.version,
      };
    });
  }

  async audit(expenseId: string, accountId: string) {
    await this.readExpense(expenseId, accountId);
    return this.prisma.auditEvent.findMany({
      where: { subjectType: "EXPENSE", subjectId: expenseId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { action: true, details: true, createdAt: true },
    });
  }
}
