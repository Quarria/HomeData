import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import { PrismaService } from "../../shared/database/prisma.service.js";

type ReportRange = {
  space: "personal" | "family";
  familyId?: string | undefined;
  origin: "all" | "personal" | "family";
  from: string;
  to: string;
};
type ReportQuery = ReportRange & {
  period: "day" | "month" | "year";
  granularity: "day" | "month";
  basis: "net" | "expense";
};
type DetailQuery = ReportRange & {
  categoryId?: string | undefined;
  payerId?: string | undefined;
  kind: "all" | "expense" | "refund";
  cursor: number;
  limit: number;
};

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function money(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function monthEnd(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

function shiftedDate(value: Date, years: number, months: number, days: number) {
  const targetMonth = value.getUTCMonth() + months;
  const year = value.getUTCFullYear() + years + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(value.getUTCDate(), monthEnd(year, month).getUTCDate());
  return new Date(Date.UTC(year, month, day + days));
}

export function comparisonRange(query: ReportQuery) {
  const from = date(query.from);
  const to = date(query.to);
  if (query.period === "day") {
    const previous = shiftedDate(from, 0, 0, -1);
    return { from: dateKey(previous), to: dateKey(previous) };
  }
  if (query.period === "month") {
    const previousMonthEnd = monthEnd(
      from.getUTCFullYear(),
      from.getUTCMonth() - 1,
    );
    const previousFrom = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1),
    );
    const selectedMonthEnd = monthEnd(to.getUTCFullYear(), to.getUTCMonth());
    const fullPeriod = to.getTime() >= selectedMonthEnd.getTime();
    const previousTo = fullPeriod
      ? previousMonthEnd
      : shiftedDate(to, 0, -1, 0);
    return { from: dateKey(previousFrom), to: dateKey(previousTo) };
  }
  const previousYear = from.getUTCFullYear() - 1;
  const previousFrom = new Date(Date.UTC(previousYear, 0, 1));
  const fullPeriod = to.getUTCMonth() === 11 && to.getUTCDate() === 31;
  const previousTo = fullPeriod
    ? new Date(Date.UTC(previousYear, 11, 31))
    : shiftedDate(to, -1, 0, 0);
  return { from: dateKey(previousFrom), to: dateKey(previousTo) };
}

@Injectable()
export class ReportsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async accessWhere(accountId: string, input: ReportRange) {
    if (input.space === "personal") {
      return {
        payerId: accountId,
        ...(input.origin === "personal"
          ? { familyId: null }
          : input.origin === "family"
            ? { familyId: { not: null } }
            : {}),
      } satisfies Prisma.ExpenseWhereInput;
    }
    if (!input.familyId) {
      throw new ConflictException({ code: "FAMILY_ID_REQUIRED" });
    }
    const membership = await this.prisma.membership.findFirst({
      where: { familyId: input.familyId, accountId, leftAt: null },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    return { familyId: input.familyId } satisfies Prisma.ExpenseWhereInput;
  }

  private rangeWhere(input: ReportRange) {
    return { gte: date(input.from), lte: date(input.to) };
  }

  private async totals(
    accountId: string,
    input: ReportRange,
  ): Promise<{ expense: bigint; refund: bigint; hasData: boolean }> {
    const access = await this.accessWhere(accountId, input);
    const range = this.rangeWhere(input);
    const expenses = await this.prisma.expense.aggregate({
      where: { ...access, deletedAt: null, occurredOn: range },
      _sum: { amountCents: true },
      _count: true,
    });
    const refunds = await this.prisma.refund.aggregate({
      where: {
        deletedAt: null,
        occurredOn: range,
        expense: { is: { ...access, deletedAt: null } },
      },
      _sum: { amountCents: true },
      _count: true,
    });
    return {
      expense: expenses._sum.amountCents ?? 0n,
      refund: refunds._sum.amountCents ?? 0n,
      hasData: expenses._count > 0 || refunds._count > 0,
    };
  }

  async summary(accountId: string, input: ReportQuery) {
    const current = await this.totals(accountId, input);
    const comparisonRangeValue = comparisonRange(input);
    const previous = await this.totals(accountId, {
      ...input,
      ...comparisonRangeValue,
    });
    const net = current.expense - current.refund;
    const previousNet = previous.expense - previous.refund;
    const difference = net - previousNet;
    const percent =
      previousNet > 0n
        ? Number((difference * 10000n) / previousNet) / 100
        : null;
    return {
      space: input.space,
      origin: input.space === "personal" ? input.origin : "all",
      from: input.from,
      to: input.to,
      hasData: current.hasData,
      scopeLabel:
        input.space === "family"
          ? "家庭归属费用"
          : input.origin === "personal"
            ? "本人支付的个人费用"
            : input.origin === "family"
              ? "本人支付的家庭费用"
              : "本人支付，含家庭费用",
      expense: money(current.expense),
      refund: money(current.refund),
      net: money(net),
      comparison: {
        ...comparisonRangeValue,
        expense: money(previous.expense),
        refund: money(previous.refund),
        net: money(previousNet),
        difference: money(difference),
        percent,
        hasData: previous.hasData,
      },
    };
  }

  async trend(
    accountId: string,
    input: ReportQuery & { categoryId?: string | undefined },
  ) {
    const access = await this.accessWhere(accountId, input);
    const where: Prisma.ExpenseWhereInput = {
      ...access,
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      deletedAt: null,
      occurredOn: this.rangeWhere(input),
    };
    const expenseRows = await this.prisma.expense.groupBy({
      by: ["occurredOn"],
      where,
      _sum: { amountCents: true },
    });
    const refundRows = await this.prisma.refund.findMany({
      where: {
        deletedAt: null,
        occurredOn: this.rangeWhere(input),
        expense: {
          is: {
            ...access,
            ...(input.categoryId ? { categoryId: input.categoryId } : {}),
            deletedAt: null,
          },
        },
      },
      select: { occurredOn: true, amountCents: true },
    });
    const buckets = new Map<string, { expense: bigint; refund: bigint }>();
    const bucketKey = (value: Date) =>
      input.granularity === "day" ? dateKey(value) : dateKey(value).slice(0, 7);
    for (const row of expenseRows) {
      const key = bucketKey(row.occurredOn);
      const bucket = buckets.get(key) ?? { expense: 0n, refund: 0n };
      bucket.expense += row._sum.amountCents ?? 0n;
      buckets.set(key, bucket);
    }
    for (const row of refundRows) {
      const key = bucketKey(row.occurredOn);
      const bucket = buckets.get(key) ?? { expense: 0n, refund: 0n };
      bucket.refund += row.amountCents;
      buckets.set(key, bucket);
    }
    const points: Array<{
      period: string;
      expense: string;
      refund: string;
      net: string;
      value: string;
    }> = [];
    let cursor = date(input.from);
    const end = date(input.to);
    while (cursor <= end) {
      const period = bucketKey(cursor);
      const values = buckets.get(period) ?? { expense: 0n, refund: 0n };
      const net = values.expense - values.refund;
      points.push({
        period,
        expense: money(values.expense),
        refund: money(values.refund),
        net: money(net),
        value: money(input.basis === "expense" ? values.expense : net),
      });
      cursor =
        input.granularity === "day"
          ? shiftedDate(cursor, 0, 0, 1)
          : new Date(
              Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
            );
    }
    return {
      from: input.from,
      to: input.to,
      granularity: input.granularity,
      basis: input.basis,
      points,
    };
  }

  async categories(accountId: string, input: ReportQuery) {
    const access = await this.accessWhere(accountId, input);
    const expenseRows = await this.prisma.expense.groupBy({
      by: ["categoryId"],
      where: {
        ...access,
        deletedAt: null,
        occurredOn: this.rangeWhere(input),
      },
      _sum: { amountCents: true },
    });
    const refundRows = await this.prisma.refund.findMany({
      where: {
        deletedAt: null,
        occurredOn: this.rangeWhere(input),
        expense: { is: { ...access, deletedAt: null } },
      },
      select: { expenseId: true, amountCents: true },
    });
    const refundExpenses = await this.prisma.expense.findMany({
      where: { id: { in: refundRows.map((row) => row.expenseId) } },
      select: { id: true, categoryId: true },
    });
    const refundCategoryByExpense = new Map(
      refundExpenses.map((expense) => [expense.id, expense.categoryId]),
    );
    const grouped = new Map<string, { expense: bigint; refund: bigint }>();
    for (const row of expenseRows) {
      grouped.set(row.categoryId, {
        expense: row._sum.amountCents ?? 0n,
        refund: 0n,
      });
    }
    for (const row of refundRows) {
      const categoryId = refundCategoryByExpense.get(row.expenseId);
      if (!categoryId) continue;
      const group = grouped.get(categoryId) ?? {
        expense: 0n,
        refund: 0n,
      };
      group.refund += row.amountCents;
      grouped.set(categoryId, group);
    }
    const categoryRows = await this.prisma.category.findMany({
      where: { id: { in: [...grouped.keys()] } },
      select: { id: true, code: true, name: true, sortOrder: true },
    });
    return categoryRows
      .map((category) => {
        const values = grouped.get(category.id)!;
        const net = values.expense - values.refund;
        return {
          categoryId: category.id,
          code: category.code,
          name: category.name,
          expense: money(values.expense),
          refund: money(values.refund),
          net: money(net),
          value: money(input.basis === "expense" ? values.expense : net),
        };
      })
      .sort((left, right) => {
        const a = BigInt(left.value.replace(".", ""));
        const b = BigInt(right.value.replace(".", ""));
        return a === b
          ? left.name.localeCompare(right.name, "zh-CN")
          : a > b
            ? -1
            : 1;
      });
  }

  async members(accountId: string, input: ReportQuery) {
    if (input.space !== "family") {
      throw new ConflictException({ code: "FAMILY_REPORT_REQUIRED" });
    }
    const access = await this.accessWhere(accountId, input);
    const expenseRows = await this.prisma.expense.groupBy({
      by: ["payerId"],
      where: {
        ...access,
        deletedAt: null,
        occurredOn: this.rangeWhere(input),
      },
      _sum: { amountCents: true },
    });
    const refundRows = await this.prisma.refund.findMany({
      where: {
        deletedAt: null,
        occurredOn: this.rangeWhere(input),
        expense: { is: { ...access, deletedAt: null } },
      },
      select: { expenseId: true, amountCents: true },
    });
    const refundExpenses = await this.prisma.expense.findMany({
      where: { id: { in: refundRows.map((row) => row.expenseId) } },
      select: { id: true, payerId: true },
    });
    const refundPayerByExpense = new Map(
      refundExpenses.map((expense) => [expense.id, expense.payerId]),
    );
    const grouped = new Map<string, { expense: bigint; refund: bigint }>();
    for (const row of expenseRows) {
      grouped.set(row.payerId, {
        expense: row._sum.amountCents ?? 0n,
        refund: 0n,
      });
    }
    for (const row of refundRows) {
      const payerId = refundPayerByExpense.get(row.expenseId);
      if (!payerId) continue;
      const group = grouped.get(payerId) ?? {
        expense: 0n,
        refund: 0n,
      };
      group.refund += row.amountCents;
      grouped.set(payerId, group);
    }
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [...grouped.keys()] } },
      select: { id: true, nickname: true },
    });
    return accounts
      .map((account) => {
        const values = grouped.get(account.id)!;
        const net = values.expense - values.refund;
        return {
          payer: account,
          expense: money(values.expense),
          refund: money(values.refund),
          net: money(net),
          value: money(input.basis === "expense" ? values.expense : net),
        };
      })
      .sort((left, right) => {
        const a = BigInt(left.value.replace(".", ""));
        const b = BigInt(right.value.replace(".", ""));
        return a === b
          ? left.payer.nickname.localeCompare(right.payer.nickname, "zh-CN")
          : a > b
            ? -1
            : 1;
      });
  }

  async details(accountId: string, input: DetailQuery) {
    const access = await this.accessWhere(accountId, input);
    const range = this.rangeWhere(input);
    const take = input.cursor + input.limit + 1;
    const expenseRows =
      input.kind === "refund"
        ? []
        : await this.prisma.expense.findMany({
            where: {
              ...access,
              deletedAt: null,
              occurredOn: range,
              ...(input.categoryId ? { categoryId: input.categoryId } : {}),
              ...(input.payerId ? { payerId: input.payerId } : {}),
            },
            include: {
              category: { select: { id: true, name: true } },
              payer: { select: { id: true, nickname: true } },
            },
            orderBy: [{ occurredOn: "desc" }, { id: "desc" }],
            take,
          });
    const refundRows =
      input.kind === "expense"
        ? []
        : await this.prisma.refund.findMany({
            where: {
              deletedAt: null,
              occurredOn: range,
              expense: {
                is: {
                  ...access,
                  deletedAt: null,
                  ...(input.categoryId ? { categoryId: input.categoryId } : {}),
                  ...(input.payerId ? { payerId: input.payerId } : {}),
                },
              },
            },
            select: {
              id: true,
              expenseId: true,
              amountCents: true,
              occurredOn: true,
            },
            orderBy: [{ occurredOn: "desc" }, { id: "desc" }],
            take,
          });
    const refundExpenses = await this.prisma.expense.findMany({
      where: { id: { in: refundRows.map((row) => row.expenseId) } },
      include: {
        category: { select: { id: true, name: true } },
        payer: { select: { id: true, nickname: true } },
      },
    });
    const refundExpenseById = new Map(
      refundExpenses.map((expense) => [expense.id, expense]),
    );
    const combined = [
      ...expenseRows.map((row) => ({
        id: row.id,
        kind: "expense" as const,
        occurredOn: dateKey(row.occurredOn),
        title: row.title,
        category: row.category,
        payer: row.payer,
        amount: money(row.amountCents),
      })),
      ...refundRows.flatMap((row) => {
        const expense = refundExpenseById.get(row.expenseId);
        return expense
          ? [
              {
                id: row.id,
                kind: "refund" as const,
                occurredOn: dateKey(row.occurredOn),
                title: `${expense.title} · 退款`,
                category: expense.category,
                payer: expense.payer,
                amount: money(-row.amountCents),
              },
            ]
          : [];
      }),
    ].sort((left, right) => {
      const dayOrder = right.occurredOn.localeCompare(left.occurredOn);
      if (dayOrder) return dayOrder;
      const idOrder = right.id.localeCompare(left.id);
      return idOrder || left.kind.localeCompare(right.kind);
    });
    const items = combined.slice(input.cursor, input.cursor + input.limit);
    return {
      items,
      nextCursor:
        combined.length > input.cursor + input.limit
          ? input.cursor + input.limit
          : null,
    };
  }
}
