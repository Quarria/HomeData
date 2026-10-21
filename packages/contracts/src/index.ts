import { z } from "zod";

export const expenseCategories = [
  { code: "FOOD", name: "餐饮" },
  { code: "DAILY", name: "日用" },
  { code: "HOUSING", name: "住房" },
  { code: "WATER", name: "水费" },
  { code: "ELECTRICITY", name: "电费" },
  { code: "GAS", name: "燃气费" },
  { code: "TRANSPORT", name: "交通" },
  { code: "MEDICAL", name: "医疗" },
  { code: "EDUCATION", name: "教育" },
  { code: "ENTERTAINMENT", name: "娱乐" },
  { code: "CLOTHING", name: "服饰" },
  { code: "COMMUNICATION", name: "通讯" },
  { code: "OTHER", name: "其他" },
] as const;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("homedata-api"),
  timestamp: z.string().datetime(),
  checks: z.object({ database: z.enum(["ok", "unavailable"]) }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(40),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const accountProfilePatchRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(80),
  gender: z.enum(["MALE", "FEMALE", "UNSPECIFIED"]).optional(),
  version: z.number().int().positive(),
});

export const adminAccountCreateRequestSchema = z.object({
  username: z.string().trim().min(1).max(40),
  nickname: z.string().trim().min(1).max(80),
  initialPassword: z.string().min(12).max(128),
});

export const adminPasswordResetRequestSchema = z.object({
  initialPassword: z.string().min(12).max(128),
});

export const versionRequestSchema = z.object({
  version: z.number().int().positive(),
});

export const familyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const familyMemberAddRequestSchema = z.object({
  username: z.string().trim().min(1).max(40),
});

export const familyHandoverRequestSchema = z.object({
  targetAccountId: z.string().uuid(),
  version: z.number().int().positive(),
});

export const familyVersionRequestSchema = z.object({
  version: z.number().int().positive(),
});

export const familyDefaultCityRequestSchema = z.object({
  version: z.number().int().positive(),
  city: z
    .object({
      name: z.string().trim().min(1).max(120),
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      timezone: z.string().trim().min(1).max(64),
    })
    .nullable(),
});

export const wardrobeCitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().trim().min(1).max(64),
});

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日期无效");
export const wardrobeWeatherRequestSchema = z.object({
  city: wardrobeCitySchema,
  startDate: isoDateSchema,
  days: z.number().int().min(1).max(30),
});
const amountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) > 0, "金额必须大于零");
const quantitySchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/)
  .refine((value) => Number(value) > 0, "数量必须大于零");

export const expenseCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    categoryId: z.string().uuid(),
    occurredOn: isoDateSchema,
    amount: amountSchema,
    quantity: quantitySchema.optional(),
    unit: z.string().trim().min(1).max(24).optional(),
    unitPrice: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/)
      .optional(),
    familyId: z.string().uuid().optional(),
    confirmFamilyVisible: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (value) => Boolean(value.familyId) === Boolean(value.confirmFamilyVisible),
    {
      path: ["confirmFamilyVisible"],
      message: "家庭支出必须确认家庭成员可见",
    },
  )
  .refine((value) => Boolean(value.quantity) === Boolean(value.unit), {
    path: ["unit"],
    message: "填写数量时需要同时填写单位",
  })
  .refine((value) => !value.unitPrice || Boolean(value.quantity), {
    path: ["unitPrice"],
    message: "填写单价时需要同时填写数量",
  });

export const expensePatchRequestSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(120).optional(),
    categoryId: z.string().uuid().optional(),
    occurredOn: isoDateSchema.optional(),
    amount: amountSchema.optional(),
    quantity: quantitySchema.nullable().optional(),
    unit: z.string().trim().min(1).max(24).nullable().optional(),
    unitPrice: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/)
      .nullable()
      .optional(),
    familyId: z.string().uuid().nullable().optional(),
    confirmFamilyVisible: z.boolean().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (value) =>
      (value.quantity === undefined && value.unit === undefined) ||
      Boolean(value.quantity) === Boolean(value.unit),
    {
      path: ["unit"],
      message: "填写数量时需要同时填写单位",
    },
  )
  .refine((value) => !value.unitPrice || Boolean(value.quantity), {
    path: ["unitPrice"],
    message: "填写单价时需要同时填写数量",
  });

export const expenseListQuerySchema = z.object({
  space: z.enum(["personal", "family"]).default("personal"),
  familyId: z.string().uuid().optional(),
  origin: z.enum(["all", "personal", "family"]).default("all"),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  categoryId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  deleted: z.enum(["true", "false"]).default("false"),
});

export const refundCreateRequestSchema = z.object({
  amount: amountSchema,
  occurredOn: isoDateSchema,
});

export const refundPatchRequestSchema = z.object({
  amount: amountSchema.optional(),
  occurredOn: isoDateSchema.optional(),
  version: z.number().int().positive(),
});

export const expenseVersionRequestSchema = z.object({
  version: z.number().int().positive(),
});

export const taskCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  dueOn: isoDateSchema,
  familyId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

export const taskPatchRequestSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  dueOn: isoDateSchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

export const taskListQuerySchema = z.object({
  space: z.enum(["personal", "family"]).default("personal"),
  familyId: z.string().uuid().optional(),
  status: z.enum(["all", "open", "done"]).default("open"),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const reportQuerySchema = z
  .object({
    space: z.enum(["personal", "family"]).default("personal"),
    familyId: z.string().uuid().optional(),
    origin: z.enum(["all", "personal", "family"]).default("all"),
    from: isoDateSchema,
    to: isoDateSchema,
    period: z.enum(["day", "month", "year"]).default("month"),
    granularity: z.enum(["day", "month"]).default("day"),
    basis: z.enum(["net", "expense"]).default("net"),
  })
  .refine((value) => value.from <= value.to, {
    path: ["to"],
    message: "结束日期不能早于开始日期",
  })
  .refine(
    (value) => {
      const from = value.from.slice(0, 7);
      const to = value.to.slice(0, 7);
      if (value.period === "day") return value.from === value.to;
      if (value.period === "month") return from === to;
      return value.from.slice(0, 4) === value.to.slice(0, 4);
    },
    {
      path: ["to"],
      message: "日期范围必须与所选统计周期一致",
    },
  );

export const reportTrendQuerySchema = reportQuerySchema.safeExtend({
  categoryId: z.string().uuid().optional(),
});

export const reportDetailsQuerySchema = reportQuerySchema
  .omit({ granularity: true, basis: true })
  .extend({
    categoryId: z.string().uuid().optional(),
    payerId: z.string().uuid().optional(),
    kind: z.enum(["all", "expense", "refund"]).default("all"),
    cursor: z.coerce.number().int().min(0).max(5000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  });

export const shareCreateRequestSchema = z
  .object({
    space: z.enum(["personal", "family"]).default("personal"),
    familyId: z.string().uuid().optional(),
    origin: z.enum(["all", "personal", "family"]).default("all"),
    from: isoDateSchema,
    to: isoDateSchema,
    period: z.enum(["day", "month", "year"]).default("month"),
    expiresInDays: z
      .union([z.literal(1), z.literal(7), z.literal(30)])
      .default(7),
    passcode: z.string().trim().min(6).max(64).optional(),
  })
  .refine((value) => value.from <= value.to, {
    path: ["to"],
    message: "结束日期不能早于开始日期",
  })
  .refine(
    (value) => {
      if (value.period === "day") return value.from === value.to;
      if (value.period === "month")
        return value.from.slice(0, 7) === value.to.slice(0, 7);
      return value.from.slice(0, 4) === value.to.slice(0, 4);
    },
    {
      path: ["to"],
      message: "日期范围必须与所选统计周期一致",
    },
  )
  .refine(
    (value) =>
      value.space === "personal"
        ? value.familyId === undefined
        : value.familyId !== undefined,
    {
      path: ["familyId"],
      message: "家庭分享必须选择家庭，个人分享不能携带家庭范围",
    },
  );

export const shareRevokeRequestSchema = z.object({
  version: z.number().int().positive(),
});

export const shareUnlockRequestSchema = z.object({
  passcode: z.string().min(1).max(64),
});

export const recurringCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(100),
  categoryId: z.string().uuid(),
  frequency: z.enum(["MONTHLY", "YEARLY"]),
  anchorOn: isoDateSchema,
  expectedAmount: amountSchema.nullable().optional(),
  familyId: z.string().uuid().nullable().optional(),
});

export const recurringPatchRequestSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(100).optional(),
  categoryId: z.string().uuid().optional(),
  frequency: z.enum(["MONTHLY", "YEARLY"]).optional(),
  anchorOn: isoDateSchema.optional(),
  expectedAmount: amountSchema.nullable().optional(),
});

export const reminderPreferenceRequestSchema = z.object({
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  taskAdvanceDays: z.number().int().min(0).max(30),
  feeAdvanceDays: z.number().int().min(0).max(30),
  overdueEnabled: z.boolean(),
});

export const notificationReadRequestSchema = z.object({
  read: z.literal(true).default(true),
});

export const occurrencePayRequestSchema = z.object({
  amount: amountSchema,
  occurredOn: isoDateSchema,
  version: z.number().int().positive(),
});

export type AccountSummary = {
  id: string;
  username: string;
  nickname: string;
  gender: "MALE" | "FEMALE" | "UNSPECIFIED";
  systemRole: "USER" | "SYSTEM_ADMIN";
  status: "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  version: number;
};

export type FamilySummary = {
  id: string;
  name: string;
  adminAccountId: string;
  status: "ACTIVE" | "ARCHIVED";
  version: number;
  defaultCity: {
    name: string;
    countryCode: string;
    latitude: number;
    longitude: number;
    timezone: string;
  } | null;
  role: "ADMIN" | "MEMBER";
  members: Array<Pick<AccountSummary, "id" | "username" | "nickname">>;
};

export const garmentSeasons = ["SPRING", "SUMMER", "AUTUMN", "WINTER"] as const;
export const garmentLayers = ["INNER", "MID", "OUTER"] as const;
export const garmentCategories = [
  "TOP",
  "OUTERWEAR",
  "BOTTOM",
  "ONE_PIECE",
  "SHOES",
  "ACCESSORY",
] as const;
export const garmentStatuses = [
  "WEARABLE",
  "LAUNDERING",
  "STORED",
  "RETIRED",
] as const;
export const garmentScenes = ["COMMUTE", "CASUAL", "SPORT"] as const;

export const wardrobeDailyRecommendationRequestSchema = z.object({
  scene: z.enum(garmentScenes),
  city: wardrobeCitySchema.optional(),
  weatherCondition: z.enum(["COLD", "MILD", "WARM", "RAINY"]).optional(),
  idea: z.string().trim().max(160).optional(),
});

const garmentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(garmentCategories),
  ownerId: z.string().uuid(),
  recipientFamilyId: z.string().uuid().optional(),
  mainImageId: z.string().uuid(),
  color: z.string().trim().max(40).nullable().optional(),
  stylingAdvice: z.string().trim().max(80).nullable().optional(),
  seasons: z.array(z.enum(garmentSeasons)).max(4),
  layers: z.array(z.enum(garmentLayers)).max(3),
  scenes: z.array(z.enum(garmentScenes)).max(3),
  status: z.enum(garmentStatuses).default("WEARABLE"),
  storageLocation: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  acquiredOn: isoDateSchema.nullable().optional(),
});

export const garmentCreateRequestSchema = z
  .discriminatedUnion("expenseMode", [
    garmentFieldsSchema.extend({ expenseMode: z.literal("NONE") }).strict(),
    garmentFieldsSchema
      .extend({
        expenseMode: z.literal("EXISTING"),
        expenseId: z.string().uuid(),
      })
      .strict(),
    garmentFieldsSchema
      .extend({
        expenseMode: z.literal("NEW"),
        expense: expenseCreateRequestSchema.safeExtend({
          receiptId: z.string().uuid().optional(),
          confirmReceiptFamilyVisible: z.boolean().optional(),
        }),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const seasons = value.seasons;
    if (new Set(seasons).size !== seasons.length) {
      context.addIssue({
        code: "custom",
        path: ["seasons"],
        message: "季节不能重复",
      });
    }
    if (new Set(value.layers).size !== value.layers.length) {
      context.addIssue({
        code: "custom",
        path: ["layers"],
        message: "适用层次不能重复",
      });
    }
    if (new Set(value.scenes).size !== value.scenes.length) {
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: "适用场景不能重复",
      });
    }
  });

export const garmentPatchRequestSchema = garmentFieldsSchema
  .omit({ ownerId: true, recipientFamilyId: true })
  .partial()
  .extend({ version: z.number().int().positive() })
  .superRefine((value, context) => {
    for (const key of ["seasons", "layers", "scenes"] as const) {
      const entries = value[key];
      if (entries && new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "选项不能重复",
        });
      }
    }
  });

export const garmentListQuerySchema = z.object({
  space: z.enum(["personal", "family"]).default("personal"),
  familyId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().uuid().optional(),
  category: z.enum(garmentCategories).optional(),
  color: z.string().trim().max(40).optional(),
  status: z.enum(garmentStatuses).optional(),
  season: z.enum(garmentSeasons).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const outfitItemSchema = z.object({
  garmentId: z.string().uuid(),
  role: z.enum([
    "TOP",
    "MID",
    "OUTER",
    "BOTTOM",
    "ONE_PIECE",
    "SHOES",
    "ACCESSORY",
  ]),
  sortOrder: z.number().int().min(0).max(20),
});

export const outfitCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scene: z.enum(garmentScenes).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    items: z.array(outfitItemSchema).min(1).max(8),
  })
  .superRefine((value, context) => {
    const ids = value.items.map(({ garmentId }) => garmentId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "单品不能重复",
      });
    }
  });

export const outfitPatchRequestSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    scene: z.enum(garmentScenes).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    items: z.array(outfitItemSchema).min(1).max(8).optional(),
  })
  .superRefine((value, context) => {
    if (value.items) {
      const ids = value.items.map(({ garmentId }) => garmentId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "单品不能重复",
        });
      }
    }
  });

export const wardrobeRecommendationRequestSchema = z
  .object({
    mode: z.enum(["DAILY", "TRIP"]),
    scene: z.enum(garmentScenes),
    city: wardrobeCitySchema.optional(),
    startOn: isoDateSchema.optional(),
    days: z.number().int().min(1).max(30).optional(),
    weatherCondition: z.enum(["COLD", "MILD", "WARM", "RAINY"]).optional(),
    idea: z.string().trim().max(160).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((value, context) => {
    if (
      value.mode === "TRIP" &&
      (!value.city || !value.startOn || !value.days)
    ) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "旅行推荐需要目的地、出发日期和天数",
      });
    }
  });
