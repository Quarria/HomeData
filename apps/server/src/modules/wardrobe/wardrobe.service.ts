import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../prisma/generated/client/client.js";
import {
  garmentCreateRequestSchema,
  garmentListQuerySchema,
  garmentPatchRequestSchema,
} from "@homedata/contracts";
import type { z } from "zod";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { LedgerService, type ExpenseInput } from "../ledger/ledger.service.js";
import {
  WardrobeImageStorageService,
  type WardrobeUpload,
} from "./wardrobe-image-storage.service.js";

type CreateInput = z.infer<typeof garmentCreateRequestSchema>;
type PatchInput = z.infer<typeof garmentPatchRequestSchema>;
type ListInput = z.infer<typeof garmentListQuerySchema>;
const imageInclude = { mainImage: { select: { id: true, mimeType: true } } };

@Injectable()
export class WardrobeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WardrobeImageStorageService)
    private readonly imageStorage: WardrobeImageStorageService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async uploadImage(actorId: string, file: WardrobeUpload) {
    const stored = await this.imageStorage.store(file);
    try {
      const image = await this.prisma.wardrobeImage.create({
        data: { uploadedById: actorId, ...stored },
        select: {
          id: true,
          mimeType: true,
          sizeBytes: true,
          width: true,
          height: true,
        },
      });
      return {
        ...image,
        contentUrl: `/api/v1/wardrobe/images/${image.id}/content`,
        thumbnailUrl: `/api/v1/wardrobe/images/${image.id}/content?size=thumbnail`,
      };
    } catch (error) {
      await this.imageStorage.removeImage(
        stored.storageKey,
        stored.thumbnailKey,
      );
      throw error;
    }
  }

  async imageContent(
    imageId: string,
    actorId: string,
    size: string | undefined,
  ) {
    const image = await this.prisma.wardrobeImage.findUnique({
      where: { id: imageId },
      include: {
        garment: { select: { id: true, ownerId: true, deletedAt: true } },
      },
    });
    if (!image)
      throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    if (image.garment) {
      const garment = await this.readableGarment(image.garment.id, actorId);
      if (!garment)
        throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    } else if (image.uploadedById !== actorId) {
      throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    }
    const thumbnail = size === "thumbnail";
    return {
      buffer: await this.imageStorage.read(
        thumbnail ? image.thumbnailKey : image.storageKey,
      ),
      mimeType: image.mimeType,
    };
  }

  async deleteTemporaryImage(imageId: string, actorId: string) {
    const image = await this.prisma.wardrobeImage.findFirst({
      where: {
        id: imageId,
        uploadedById: actorId,
        garment: null,
        aiRuns: { none: {} },
      },
    });
    if (!image)
      throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
    await this.prisma.wardrobeImage.delete({ where: { id: imageId } });
    await this.imageStorage.removeImage(image.storageKey, image.thumbnailKey);
    return { id: imageId, deleted: true };
  }

  async cleanupTemporaryImages(now = new Date()) {
    const olderThan = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.wardrobeImage.findMany({
      where: {
        createdAt: { lt: olderThan },
        garment: null,
        aiRuns: { none: {} },
      },
      take: 50,
      orderBy: { createdAt: "asc" },
      select: { id: true, storageKey: true, thumbnailKey: true },
    });
    let purged = 0;
    for (const image of candidates) {
      const removed = await this.prisma.wardrobeImage.deleteMany({
        where: {
          id: image.id,
          createdAt: { lt: olderThan },
          garment: null,
          aiRuns: { none: {} },
        },
      });
      if (!removed.count) continue;
      await this.imageStorage.removeImage(image.storageKey, image.thumbnailKey);
      purged += 1;
    }
    return { purged };
  }

  async listGarments(actorId: string, query: ListInput) {
    let where: Prisma.GarmentWhereInput;
    if (query.space === "family") {
      if (!query.familyId)
        throw new ConflictException({ code: "FAMILY_ID_REQUIRED" });
      await this.currentMembership(actorId, query.familyId);
      if (query.ownerId && query.ownerId !== actorId) {
        throw new ForbiddenException({ code: "WARDROBE_OWNER_FORBIDDEN" });
      }
      where = { ownerId: actorId };
    } else {
      if (query.familyId)
        throw new ConflictException({ code: "PERSONAL_SCOPE_HAS_NO_FAMILY" });
      if (query.ownerId && query.ownerId !== actorId) {
        throw new ForbiddenException({ code: "WARDROBE_OWNER_FORBIDDEN" });
      }
      where = { ownerId: actorId };
    }
    where.deletedAt = null;
    if (query.q) where.name = { contains: query.q, mode: "insensitive" };
    if (query.category) where.category = query.category;
    if (query.color) where.color = { equals: query.color, mode: "insensitive" };
    if (query.status) where.status = query.status;
    if (query.season) where.seasons = { has: query.season };
    if (query.cursor) where.id = { gt: query.cursor };
    const rows = await this.prisma.garment.findMany({
      where,
      take: query.limit + 1,
      orderBy: { id: "asc" },
      include: imageInclude,
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => this.dto(row));
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async createGarment(actorId: string, input: CreateInput, key: string) {
    return this.ledger.runIdempotentTransaction(
      actorId,
      "wardrobe.garment.create",
      key,
      input,
      async (tx) => {
        const familyId = await this.lockOwnerFamily(
          tx,
          actorId,
          input.ownerId,
          input.ownerId === actorId ? undefined : input.recipientFamilyId,
        );
        const image = await tx.wardrobeImage.findFirst({
          where: {
            id: input.mainImageId,
            uploadedById: actorId,
            garment: null,
          },
        });
        if (!image)
          throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
        let expenseId: string | null = null;
        if (input.expenseMode === "NEW") {
          const { receiptId, confirmReceiptFamilyVisible, ...expenseInput } =
            input.expense;
          if (expenseInput.familyId && expenseInput.familyId !== familyId) {
            throw new ConflictException({
              code: "WARDROBE_EXPENSE_FAMILY_MISMATCH",
            });
          }
          const expense = await this.ledger.createInTransaction(
            tx,
            actorId,
            expenseInput,
          );
          expenseId = expense.id;
          if (receiptId) {
            await this.ledger.linkReceiptInTransaction(
              tx,
              expense.id,
              receiptId,
              actorId,
              confirmReceiptFamilyVisible ?? false,
            );
          }
        } else if (input.expenseMode === "EXISTING") {
          const expenseScope = await tx.expense.findUnique({
            where: { id: input.expenseId },
            select: { familyId: true },
          });
          if (!expenseScope)
            throw new NotFoundException({ code: "EXPENSE_NOT_FOUND" });
          if (expenseScope.familyId && expenseScope.familyId !== familyId) {
            throw new ConflictException({
              code: "WARDROBE_EXPENSE_FAMILY_MISMATCH",
            });
          }
          const expense = await this.ledger.assertWritableExpense(
            tx,
            input.expenseId,
            actorId,
          );
          expenseId = expense.id;
        }

        const garment = await tx.garment.create({
          data: {
            ownerId: input.ownerId,
            createdById: actorId,
            mainImageId: image.id,
            expenseId,
            name: input.name,
            category: input.category,
            color: input.color ?? null,
            stylingAdvice: input.stylingAdvice ?? null,
            seasons: [...new Set(input.seasons)],
            layers: [...new Set(input.layers)],
            scenes: [...new Set(input.scenes)],
            status: input.status,
            visibility: "PRIVATE",
            familyId: null,
            storageLocation: input.storageLocation ?? null,
            notes: input.notes ?? null,
            acquiredOn: input.acquiredOn
              ? new Date(`${input.acquiredOn}T00:00:00.000Z`)
              : null,
          },
          include: imageInclude,
        });
        await tx.auditEvent.create({
          data: {
            actorId,
            action: "GARMENT_CREATED",
            subjectType: "GARMENT",
            subjectId: garment.id,
            details: {
              visibility: "PRIVATE",
              category: garment.category,
              expenseId,
            },
          },
        });
        return this.dto(garment);
      },
    );
  }

  private async lockOwnerFamily(
    tx: Prisma.TransactionClient,
    actorId: string,
    ownerId: string,
    requestedFamilyId: string | undefined,
  ) {
    if (ownerId === actorId) {
      if (!requestedFamilyId) return null;
      const membership = await tx.membership.findFirst({
        where: {
          accountId: actorId,
          familyId: requestedFamilyId,
          leftAt: null,
          family: { status: "ACTIVE" },
          account: { status: "ACTIVE" },
        },
        select: { familyId: true },
      });
      if (!membership)
        throw new ForbiddenException({ code: "FAMILY_MEMBERSHIP_REQUIRED" });
      await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${membership.familyId}::uuid`;
      return membership.familyId;
    }
    if (!requestedFamilyId)
      throw new ForbiddenException({ code: "WARDROBE_OWNER_FORBIDDEN" });
    await tx.$executeRaw`UPDATE families SET version = version WHERE id = ${requestedFamilyId}::uuid`;
    const family = await tx.family.findUnique({
      where: { id: requestedFamilyId },
    });
    if (!family || family.status !== "ACTIVE")
      throw new ConflictException({ code: "FAMILY_ARCHIVED" });
    const memberships = await tx.membership.findMany({
      where: {
        familyId: requestedFamilyId,
        accountId: { in: [actorId, ownerId] },
        leftAt: null,
        account: { status: "ACTIVE" },
      },
      select: { accountId: true },
    });
    if (new Set(memberships.map(({ accountId: id }) => id)).size !== 2) {
      throw new ForbiddenException({ code: "FAMILY_MEMBERSHIP_REQUIRED" });
    }
    return requestedFamilyId;
  }

  async getGarment(garmentId: string, actorId: string) {
    const garment = await this.readableGarment(garmentId, actorId);
    if (!garment) throw new NotFoundException({ code: "GARMENT_NOT_FOUND" });
    return this.dto(garment);
  }

  async updateGarment(garmentId: string, actorId: string, input: PatchInput) {
    const existing = await this.prisma.garment.findFirst({
      where: { id: garmentId, ownerId: actorId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException({ code: "GARMENT_NOT_FOUND" });
    if (existing.version !== input.version) {
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    }
    const { version, acquiredOn, ...fields } = input;
    const data: Prisma.GarmentUncheckedUpdateManyInput = {
      version: { increment: 1 },
      visibility: "PRIVATE",
      familyId: null,
    };
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.category !== undefined) data.category = fields.category;
    if (fields.color !== undefined) data.color = fields.color;
    if (fields.stylingAdvice !== undefined)
      data.stylingAdvice = fields.stylingAdvice;
    if (fields.seasons !== undefined)
      data.seasons = [...new Set(fields.seasons)];
    if (fields.layers !== undefined) data.layers = [...new Set(fields.layers)];
    if (fields.scenes !== undefined) data.scenes = [...new Set(fields.scenes)];
    if (fields.status !== undefined) data.status = fields.status;
    if (fields.storageLocation !== undefined)
      data.storageLocation = fields.storageLocation;
    if (fields.notes !== undefined) data.notes = fields.notes;
    if (fields.mainImageId !== undefined) {
      const image = await this.prisma.wardrobeImage.findFirst({
        where: {
          id: fields.mainImageId,
          uploadedById: actorId,
          garment: null,
        },
        select: { id: true },
      });
      if (!image)
        throw new NotFoundException({ code: "WARDROBE_IMAGE_NOT_FOUND" });
      data.mainImageId = image.id;
    }
    if (acquiredOn !== undefined)
      data.acquiredOn = acquiredOn
        ? new Date(`${acquiredOn}T00:00:00.000Z`)
        : null;
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.garment.updateMany({
        where: { id: garmentId, ownerId: actorId, deletedAt: null, version },
        data,
      });
      if (updated.count)
        await tx.garmentShare.deleteMany({ where: { garmentId } });
      return updated;
    });
    if (!result.count)
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    await this.prisma.auditEvent.create({
      data: {
        actorId,
        action: "GARMENT_UPDATED",
        subjectType: "GARMENT",
        subjectId: garmentId,
      },
    });
    return this.getGarment(garmentId, actorId);
  }

  async deleteGarment(garmentId: string, actorId: string, version: number) {
    const result = await this.prisma.garment.updateMany({
      where: { id: garmentId, ownerId: actorId, deletedAt: null, version },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (!result.count)
      throw new NotFoundException({ code: "GARMENT_NOT_FOUND" });
    await this.prisma.auditEvent.create({
      data: {
        actorId,
        action: "GARMENT_DELETED",
        subjectType: "GARMENT",
        subjectId: garmentId,
      },
    });
    return { id: garmentId, deleted: true };
  }

  private async currentMembership(actorId: string, familyId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: {
        familyId,
        accountId: actorId,
        leftAt: null,
        family: { status: "ACTIVE" },
        account: { status: "ACTIVE" },
      },
      select: { id: true, familyId: true },
    });
    if (!membership) throw new NotFoundException({ code: "FAMILY_NOT_FOUND" });
    return membership;
  }

  private async readableGarment(garmentId: string, actorId: string) {
    return this.prisma.garment.findFirst({
      where: { id: garmentId, ownerId: actorId, deletedAt: null },
      include: imageInclude,
    });
  }

  private dto(
    garment: Prisma.GarmentGetPayload<{ include: typeof imageInclude }>,
  ) {
    return {
      id: garment.id,
      ownerId: garment.ownerId,
      createdById: garment.createdById,
      familyId: null,
      name: garment.name,
      category: garment.category,
      color: garment.color,
      stylingAdvice: garment.stylingAdvice,
      seasons: garment.seasons,
      layers: garment.layers,
      scenes: garment.scenes,
      status: garment.status,
      visibility: "PRIVATE",
      storageLocation: garment.storageLocation,
      notes: garment.notes,
      acquiredOn: garment.acquiredOn?.toISOString().slice(0, 10) ?? null,
      expenseId:
        garment.ownerId === garment.createdById ? garment.expenseId : null,
      version: garment.version,
      mainImage: {
        id: garment.mainImage.id,
        mimeType: garment.mainImage.mimeType,
        contentUrl: `/api/v1/wardrobe/images/${garment.mainImage.id}/content`,
        thumbnailUrl: `/api/v1/wardrobe/images/${garment.mainImage.id}/content?size=thumbnail`,
      },
      createdAt: garment.createdAt,
      updatedAt: garment.updatedAt,
    };
  }
}
