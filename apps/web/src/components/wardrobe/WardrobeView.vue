<script setup lang="ts">
import { snapshotRecognitionFields } from "./recognition-snapshot";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ApiClientError,
  apiRequest,
  newIdempotencyKey,
} from "../../api/client";
import { useSessionStore, type FamilySummary } from "../../stores/session";
import AppIcon from "../AppIcon.vue";
import { compressWardrobeImage } from "./compress-image";

type Category =
  "TOP" | "OUTERWEAR" | "BOTTOM" | "ONE_PIECE" | "SHOES" | "ACCESSORY";
type Season = "SPRING" | "SUMMER" | "AUTUMN" | "WINTER";
type Layer = "INNER" | "MID" | "OUTER";
type Scene = "COMMUTE" | "CASUAL" | "SPORT";
type Garment = {
  id: string;
  ownerId: string;
  createdById: string;
  familyId: string | null;
  name: string;
  category: Category;
  color: string | null;
  stylingAdvice: string | null;
  seasons: Season[];
  layers: Layer[];
  scenes: Scene[];
  status: "WEARABLE" | "LAUNDERING" | "STORED" | "RETIRED";
  storageLocation: string | null;
  notes: string | null;
  acquiredOn: string | null;
  version: number;
  mainImage: {
    id: string;
    mimeType: string;
    contentUrl: string;
    thumbnailUrl: string;
  };
};
type ImageUpload = { id: string; contentUrl: string; thumbnailUrl: string };
type ExpenseCategory = { id: string; name: string; code: string };
type ExpenseDetails = {
  id: string;
  title: string;
  amount: string;
  occurredOn: string;
  familyId: string | null;
  category: ExpenseCategory;
  payer?: { id: string; nickname: string };
  capabilities?: { canEdit: boolean };
};
type City = {
  name: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
};
type RecommendedOutfit = {
  id: string;
  name: string;
  scene: Scene;
  score: number;
  warnings: string[];
  reason: string;
  items: Array<{
    garmentId: string;
    role: string;
    sortOrder: number;
    name: string;
    category: Category;
    imageUrl: string;
  }>;
};
type SavedOutfit = {
  id: string;
  name: string;
  scene: Scene | null;
  notes: string | null;
  version: number;
  valid: boolean;
  items: Array<{
    garmentId: string;
    role: string;
    sortOrder: number;
    garment: null | { id: string; name: string; imageUrl: string };
    available: boolean;
  }>;
};
type DailyRecommendationResult = {
  recommendations: RecommendedOutfit[];
  message: string | null;
  weatherError: string | null;
  condition: string | null;
};
type TripRecommendationResult = {
  city: City;
  timezone: string;
  days: Array<{
    date: string;
    weather: null | {
      available: boolean;
      temperatureMin: number | null;
      temperatureMax: number | null;
      precipitationMm: number | null;
    };
    condition: string | null;
    recommendation: RecommendedOutfit | null;
    message: string | null;
    weatherMissing: boolean;
  }>;
  weatherSource: string | null;
  weatherError: string | null;
};
type ExpenseDraft = {
  title: string;
  categoryId: string;
  occurredOn: string;
  amount: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  note?: string;
  familyId?: string;
  receiptId?: string;
};
const props = defineProps<{
  initialAction?: string;
  targetId?: string;
  expenseDraft?: ExpenseDraft;
}>();
const emit = defineEmits<{
  navigate: [
    target: {
      page: "tasks" | "ledger";
      action: string;
      id?: string;
    },
  ];
  draftConsumed: [];
}>();
const session = useSessionStore();
const rows = ref<Garment[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const success = ref("");
const query = ref("");
const categoryFilter = ref<Category | "">("");
const colorFilter = ref("");
const statusFilter = ref<Garment["status"] | "">("");
const seasonFilter = ref<Season | "">("");
const selected = ref<Garment | null>(null);
const editing = ref(false);
const imageInput = ref<HTMLInputElement | null>(null);
const imagePreview = ref("");
const uploadedImage = ref<ImageUpload | null>(null);
const expenseCategories = ref<ExpenseCategory[]>([]);
const expenseOptions = ref<ExpenseDetails[]>([]);
const expenseOptionsLoading = ref(false);
const expenseSearch = ref("");
const aiEnabled = ref(false);
const recognizing = ref(false);
const recognitionMessage = ref("");
const cityQuery = ref("");
const cityResults = ref<City[]>([]);
const citySearching = ref(false);
const citySaving = ref(false);
const citySaveMessage = ref("");
const citySettingsOpen = ref(false);
const weatherLoading = ref(false);
const weatherError = ref("");
const activeTab = ref<"closet" | "daily" | "trip" | "saved">("closet");
const outfitScene = ref<Scene>("CASUAL");
const outfitIdea = ref("");
const weatherConditionChoice = ref<"" | "COLD" | "MILD" | "WARM" | "RAINY">("");
const recommendationLoading = ref(false);
const recommendationError = ref("");
const recommendations = ref<RecommendedOutfit[]>([]);
const savedOutfits = ref<SavedOutfit[]>([]);
const selectedOutfitGarments = ref<Record<string, string[]>>({});
const savedOutfitsLoading = ref(false);
const outfitMessage = ref("");
const manualOutfitName = ref("");
const manualOutfitGarmentIds = ref<string[]>([]);
const tripCity = ref<City | null>(null);
const tripStartOn = ref(new Date().toISOString().slice(0, 10));
const tripDays = ref(3);
const tripLoading = ref(false);
const tripError = ref("");
const tripResult = ref<TripRecommendationResult | null>(null);
const todayWeather = ref<{
  date: string;
  available: boolean;
  temperatureMax: number | null;
  temperatureMin: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
} | null>(null);
const selectedExpense = ref<ExpenseDetails | null>(null);
const initialExpenseId = ref("");
const form = ref({
  name: "",
  category: "TOP" as Category,
  color: "",
  stylingAdvice: "",
  seasons: [] as Season[],
  layers: [] as Layer[],
  scenes: [] as Scene[],
  status: "WEARABLE" as Garment["status"],
  storageLocation: "",
  notes: "",
  acquiredOn: "",
  ownerId: "",
  expenseMode: "NONE" as "NONE" | "NEW" | "EXISTING",
  expenseTitle: "",
  expenseDate: new Date().toISOString().slice(0, 10),
  expenseAmount: "",
  expenseCategoryId: "",
  expenseFamilyVisible: false,
  expenseQuantity: "",
  expenseUnit: "",
  expenseUnitPrice: "",
  expenseNote: "",
  expenseReceiptId: "",
});
const categories: Array<{ value: Category; label: string }> = [
  { value: "TOP", label: "上装" },
  { value: "OUTERWEAR", label: "外套" },
  { value: "BOTTOM", label: "下装" },
  { value: "ONE_PIECE", label: "连衣裙" },
  { value: "SHOES", label: "鞋" },
  { value: "ACCESSORY", label: "配饰" },
];
const seasons: Array<{ value: Season; label: string }> = [
  { value: "SPRING", label: "春" },
  { value: "SUMMER", label: "夏" },
  { value: "AUTUMN", label: "秋" },
  { value: "WINTER", label: "冬" },
];
const layers: Array<{ value: Layer; label: string }> = [
  { value: "INNER", label: "内搭" },
  { value: "MID", label: "中层" },
  { value: "OUTER", label: "外层" },
];
const scenes: Array<{ value: Scene; label: string }> = [
  { value: "COMMUTE", label: "通勤" },
  { value: "CASUAL", label: "休闲" },
  { value: "SPORT", label: "运动" },
];
const statuses: Array<{ value: Garment["status"]; label: string }> = [
  { value: "WEARABLE", label: "可穿" },
  { value: "LAUNDERING", label: "清洗中" },
  { value: "STORED", label: "已收纳" },
  { value: "RETIRED", label: "已退役" },
];
const canEditSelected = computed(
  () => selected.value?.ownerId === session.account?.id,
);
const weatherPresentation = computed(() =>
  presentWeather(todayWeather.value?.weatherCode ?? null),
);
const visibleRows = computed(() => rows.value);
const editableRows = computed(() =>
  rows.value.filter(
    (item) =>
      item.ownerId === session.account?.id && item.status === "WEARABLE",
  ),
);
let requestSerial = 0;
let expenseOptionRequestSerial = 0;
let createKey = "";
let wardrobeMounted = true;
let expenseDebounce = 0;

function message(reason: unknown, fallback: string) {
  return reason instanceof ApiClientError ? reason.message : fallback;
}
function clearPreview() {
  if (imagePreview.value.startsWith("blob:"))
    URL.revokeObjectURL(imagePreview.value);
  imagePreview.value = "";
}
function resetForm() {
  form.value = {
    name: "",
    category: "TOP",
    color: "",
    stylingAdvice: "",
    seasons: [],
    layers: [],
    scenes: [],
    status: "WEARABLE",
    storageLocation: "",
    notes: "",
    acquiredOn: "",
    ownerId: session.account?.id ?? "",
    expenseMode: initialExpenseId.value ? "EXISTING" : "NONE",
    expenseTitle: "",
    expenseDate: new Date().toISOString().slice(0, 10),
    expenseAmount: "",
    expenseCategoryId:
      expenseCategories.value.find(({ code }) => code === "CLOTHING")?.id ??
      expenseCategories.value[0]?.id ??
      "",
    expenseFamilyVisible: false,
    expenseQuantity: "",
    expenseUnit: "",
    expenseUnitPrice: "",
    expenseNote: "",
    expenseReceiptId: "",
  };
  uploadedImage.value = null;
  clearPreview();
  if (imageInput.value) imageInput.value.value = "";
}
function beginCreate() {
  selected.value = null;
  initialExpenseId.value = "";
  selectedExpense.value = null;
  editing.value = true;
  error.value = "";
  success.value = "";
  resetForm();
  createKey = newIdempotencyKey();
}
function openFromExpenseDraft(draft: ExpenseDraft) {
  beginCreate();
  form.value.expenseMode = "NEW";
  form.value.expenseTitle = draft.title;
  form.value.expenseDate = draft.occurredOn;
  form.value.expenseAmount = draft.amount;
  form.value.expenseCategoryId = draft.categoryId;
  form.value.expenseQuantity = draft.quantity ?? "";
  form.value.expenseUnit = draft.unit ?? "";
  form.value.expenseUnitPrice = draft.unitPrice ?? "";
  form.value.expenseNote = draft.note ?? "";
  form.value.expenseReceiptId = draft.receiptId ?? "";
  form.value.expenseFamilyVisible = Boolean(
    draft.familyId && draft.familyId === session.family?.id,
  );
}
function returnToExpenseDraft() {
  cancelEdit();
  emit("navigate", { page: "ledger", action: "restore-expense-draft" });
}
async function openFromExpense(expenseId: string) {
  beginCreate();
  try {
    const expense = await apiRequest<ExpenseDetails>(`/expenses/${expenseId}`);
    selectedExpense.value = expense;
    if (!expenseOptions.value.some((item) => item.id === expense.id))
      expenseOptions.value = [expense, ...expenseOptions.value];
    initialExpenseId.value = expense.id;
    form.value.expenseMode = "EXISTING";
    form.value.ownerId = session.account?.id ?? "";
  } catch (reason) {
    error.value = message(reason, "无法读取这笔账单，请确认仍有编辑权限。");
  }
}
async function loadExpenseOptions() {
  const serial = ++expenseOptionRequestSerial;
  expenseOptionsLoading.value = true;
  try {
    const params = new URLSearchParams({
      space: "personal",
      origin: "all",
      limit: "100",
      deleted: "false",
    });
    const clothingCategory = expenseCategories.value.find(
      ({ code }) => code === "CLOTHING",
    );
    if (clothingCategory) params.set("categoryId", clothingCategory.id);
    if (expenseSearch.value.trim()) params.set("q", expenseSearch.value.trim());
    const result = await apiRequest<{ items: ExpenseDetails[] }>(
      `/expenses?${params}`,
    );
    const items = result.items.filter(
      (expense) =>
        expense.category.code === "CLOTHING" &&
        expense.capabilities?.canEdit !== false,
    );
    if (
      selectedExpense.value &&
      !items.some((expense) => expense.id === selectedExpense.value?.id)
    ) {
      items.unshift(selectedExpense.value);
    }
    if (serial === expenseOptionRequestSerial) expenseOptions.value = items;
  } catch {
    if (serial === expenseOptionRequestSerial) expenseOptions.value = [];
  } finally {
    if (serial === expenseOptionRequestSerial)
      expenseOptionsLoading.value = false;
  }
}
function selectExpense(expenseId: string) {
  selectedExpense.value =
    expenseOptions.value.find((expense) => expense.id === expenseId) ?? null;
}
function presentWeather(code: number | null) {
  if (code === 0) return { icon: "☀️", label: "晴朗" };
  if (code === 1) return { icon: "🌤️", label: "大致晴朗" };
  if (code === 2) return { icon: "⛅", label: "多云间晴" };
  if ([3, 45, 48].includes(code ?? -1))
    return {
      icon: code === 3 ? "☁️" : "🌫️",
      label: code === 3 ? "阴天" : "有雾",
    };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code ?? -1))
    return { icon: "🌧️", label: "有雨" };
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1))
    return { icon: "❄️", label: "有雪" };
  if ([95, 96, 99].includes(code ?? -1)) return { icon: "⛈️", label: "雷雨" };
  return { icon: "🌡️", label: "天气信息" };
}
async function discardTemporaryImage() {
  const imageId = uploadedImage.value?.id;
  uploadedImage.value = null;
  if (!imageId) return;
  try {
    await apiRequest(`/wardrobe/images/${imageId}`, { method: "DELETE" });
  } catch {
    // Storage cleanup also removes temporary images left by a closed tab.
  }
}
function cancelEdit() {
  editing.value = false;
  clearPreview();
  void discardTemporaryImage();
}
function beginEdit(item: Garment) {
  selected.value = item;
  editing.value = true;
  error.value = "";
  form.value = {
    name: item.name,
    category: item.category,
    color: item.color ?? "",
    stylingAdvice: item.stylingAdvice ?? "",
    seasons: [...item.seasons],
    layers: [...item.layers],
    scenes: [...item.scenes],
    status: item.status,
    storageLocation: item.storageLocation ?? "",
    notes: item.notes ?? "",
    acquiredOn: item.acquiredOn ?? "",
    ownerId: item.ownerId,
    expenseMode: "NONE",
    expenseTitle: "",
    expenseDate: new Date().toISOString().slice(0, 10),
    expenseAmount: "",
    expenseCategoryId: expenseCategories.value[0]?.id ?? "",
    expenseFamilyVisible: false,
    expenseQuantity: "",
    expenseUnit: "",
    expenseUnitPrice: "",
    expenseNote: "",
    expenseReceiptId: "",
  };
  uploadedImage.value = null;
  clearPreview();
  imagePreview.value = item.mainImage.contentUrl;
}
async function load() {
  const serial = ++requestSerial;
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams({
      space: session.activeSpace,
      limit: "50",
    });
    if (session.activeSpace === "family" && session.family)
      params.set("familyId", session.family.id);
    if (query.value.trim()) params.set("q", query.value.trim());
    if (categoryFilter.value) params.set("category", categoryFilter.value);
    if (colorFilter.value.trim()) params.set("color", colorFilter.value.trim());
    if (statusFilter.value) params.set("status", statusFilter.value);
    if (seasonFilter.value) params.set("season", seasonFilter.value);
    const result = await apiRequest<{
      items: Garment[];
      nextCursor: string | null;
    }>(`/wardrobe/garments?${params}`);
    if (serial === requestSerial) rows.value = result.items;
    if (selected.value)
      selected.value =
        result.items.find(({ id }) => id === selected.value?.id) ?? null;
  } catch (reason) {
    if (serial === requestSerial)
      error.value = message(reason, "衣柜暂时无法加载，请稍后重试。");
  } finally {
    if (serial === requestSerial) loading.value = false;
  }
}
async function chooseImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    error.value = "请使用 JPG、PNG 或 WebP 图片。";
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    error.value = "照片不能超过 10 MB。";
    return;
  }
  await discardTemporaryImage();
  error.value = "";
  recognitionMessage.value = "";
  clearPreview();
  uploadedImage.value = null;
  imagePreview.value = URL.createObjectURL(file);
  saving.value = true;
  try {
    const compressed = await compressWardrobeImage(file);
    const data = new FormData();
    data.append("file", compressed);
    uploadedImage.value = await apiRequest<ImageUpload>("/wardrobe/images", {
      method: "POST",
      body: data,
    });
    imagePreview.value = uploadedImage.value.contentUrl;
  } catch (reason) {
    error.value = message(reason, "照片上传失败，请重试。");
    uploadedImage.value = null;
  } finally {
    saving.value = false;
  }
}
async function recognizeImage() {
  const image = uploadedImage.value;
  if (!image || !aiEnabled.value || recognizing.value) return;
  const before = snapshotRecognitionFields(form.value);
  recognizing.value = true;
  recognitionMessage.value = "正在识别照片，完成后会填入可核对的草稿…";
  try {
    const run = await apiRequest<{ id: string; status: string }>(
      "/ai/wardrobe-recognitions",
      {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: JSON.stringify({ wardrobeImageId: image.id }),
      },
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!wardrobeMounted || uploadedImage.value?.id !== image.id) return;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const completed = await apiRequest<{
        status: string;
        errorCode: string | null;
        result: {
          name: string | null;
          category: Category | null;
          color: string | null;
          stylingAdvice: string | null;
          seasons: Season[];
          layers: Layer[];
          scenes: Scene[];
          thingsToVerify: string[];
        } | null;
      }>(`/ai/runs/${run.id}`);
      if (completed.status === "SUCCEEDED" && completed.result) {
        const suggestion = completed.result;
        if (form.value.name === before.name && suggestion.name)
          form.value.name = suggestion.name;
        if (form.value.category === before.category && suggestion.category)
          form.value.category = suggestion.category;
        if (form.value.color === before.color && suggestion.color)
          form.value.color = suggestion.color;
        if (
          form.value.stylingAdvice === before.stylingAdvice &&
          suggestion.stylingAdvice
        )
          form.value.stylingAdvice = suggestion.stylingAdvice;
        if (
          JSON.stringify(form.value.seasons) === JSON.stringify(before.seasons)
        )
          form.value.seasons = [...suggestion.seasons];
        if (JSON.stringify(form.value.layers) === JSON.stringify(before.layers))
          form.value.layers = [...suggestion.layers];
        if (JSON.stringify(form.value.scenes) === JSON.stringify(before.scenes))
          form.value.scenes = [...suggestion.scenes];
        recognitionMessage.value = suggestion.thingsToVerify.length
          ? `AI 草稿已填入，请核对：${suggestion.thingsToVerify.join("；")}`
          : "AI 草稿已填入，请核对后保存。";
        return;
      }
      if (["FAILED", "CANCELLED"].includes(completed.status)) {
        recognitionMessage.value = "识别没有完成；你仍可手工录入衣物。";
        return;
      }
    }
    recognitionMessage.value = "识别仍在处理中，可稍后重试；手工录入不受影响。";
  } catch (reason) {
    recognitionMessage.value = message(reason, "暂时无法识别，请手工录入。");
  } finally {
    recognizing.value = false;
  }
}
function toggle<T extends string>(values: T[], value: T) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}
async function save() {
  if (!form.value.name.trim()) {
    error.value = "请填写衣物名称。";
    return;
  }
  if (form.value.ownerId !== session.account?.id && !session.family?.id) {
    error.value = "代他人录入需要有效的家庭关系。";
    return;
  }
  if (form.value.expenseMode === "NEW") {
    const amount = Number(form.value.expenseAmount);
    if (
      !form.value.expenseCategoryId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      error.value = "请填写有效金额并选择账单分类。";
      return;
    }
    if (
      Boolean(form.value.expenseQuantity) !== Boolean(form.value.expenseUnit)
    ) {
      error.value = "填写账单数量时需要同时填写单位。";
      return;
    }
    if (form.value.expenseUnitPrice && !form.value.expenseQuantity) {
      error.value = "填写账单单价时需要同时填写数量和单位。";
      return;
    }
  }
  if (form.value.expenseMode === "EXISTING" && !selectedExpense.value) {
    error.value = "请选择一笔已有账单，或改为暂不关联。";
    return;
  }
  if (!selected.value && !uploadedImage.value) {
    error.value = "请先添加一张衣物照片。";
    return;
  }
  saving.value = true;
  error.value = "";
  const payload = {
    name: form.value.name,
    category: form.value.category,
    color: form.value.color || null,
    stylingAdvice: form.value.stylingAdvice || null,
    seasons: [...form.value.seasons],
    layers: [...form.value.layers],
    scenes: [...form.value.scenes],
    status: form.value.status,
    storageLocation: form.value.storageLocation || null,
    notes: form.value.notes || null,
    acquiredOn: form.value.acquiredOn || null,
  };
  try {
    if (selected.value) {
      selected.value = await apiRequest<Garment>(
        `/wardrobe/garments/${selected.value.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...payload,
            ...(uploadedImage.value
              ? { mainImageId: uploadedImage.value.id }
              : {}),
            version: selected.value.version,
          }),
        },
      );
    } else {
      if (!createKey) createKey = newIdempotencyKey();
      const expenseMode = form.value.expenseMode;
      const created = await apiRequest<Garment>("/wardrobe/garments", {
        method: "POST",
        headers: { "idempotency-key": createKey },
        body: JSON.stringify({
          ...payload,
          ownerId: form.value.ownerId || session.account!.id,
          ...(form.value.ownerId !== session.account!.id && session.family
            ? { recipientFamilyId: session.family.id }
            : {}),
          mainImageId: uploadedImage.value!.id,
          expenseMode,
          ...(expenseMode === "EXISTING" && selectedExpense.value
            ? { expenseId: selectedExpense.value.id }
            : {}),
          ...(expenseMode === "NEW"
            ? {
                expense: {
                  title:
                    form.value.expenseTitle.trim() || form.value.name.trim(),
                  categoryId: form.value.expenseCategoryId,
                  occurredOn: form.value.expenseDate,
                  amount: form.value.expenseAmount,
                  ...(form.value.expenseQuantity && form.value.expenseUnit
                    ? {
                        quantity: form.value.expenseQuantity,
                        unit: form.value.expenseUnit,
                      }
                    : {}),
                  ...(form.value.expenseUnitPrice
                    ? { unitPrice: form.value.expenseUnitPrice }
                    : {}),
                  ...(form.value.expenseNote
                    ? { note: form.value.expenseNote }
                    : {}),
                  ...(form.value.expenseFamilyVisible && session.family
                    ? {
                        familyId: session.family.id,
                        confirmFamilyVisible: true,
                      }
                    : {}),
                  ...(form.value.expenseReceiptId
                    ? {
                        receiptId: form.value.expenseReceiptId,
                        confirmReceiptFamilyVisible: false,
                      }
                    : {}),
                },
              }
            : {}),
        }),
      });
      selected.value = created;
      createKey = "";
      if (expenseMode === "EXISTING")
        initialExpenseId.value = selectedExpense.value?.id ?? "";
      else {
        initialExpenseId.value = "";
        selectedExpense.value = null;
      }
      if (form.value.ownerId !== session.account?.id) {
        const recipient = session.family?.members.find(
          (member) => member.id === form.value.ownerId,
        );
        success.value = `已代${recipient?.nickname ?? "家庭成员"}录入衣物；衣物归入对方衣柜，账单仍记在你的账本中。`;
      } else {
        success.value = "衣物已保存。";
      }
      if (props.expenseDraft) emit("draftConsumed");
    }
    editing.value = false;
    uploadedImage.value = null;
    clearPreview();
    await load();
  } catch (reason) {
    error.value = message(reason, "保存失败，输入内容仍保留，可以重试。");
  } finally {
    saving.value = false;
  }
}
async function removeSelected() {
  if (!selected.value || !canEditSelected.value) return;
  if (!window.confirm(`确定从衣柜移除“${selected.value.name}”吗？`)) return;
  saving.value = true;
  error.value = "";
  try {
    await apiRequest(`/wardrobe/garments/${selected.value.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: selected.value.version }),
    });
    selected.value = null;
    await load();
  } catch (reason) {
    error.value = message(reason, "暂时无法删除，请重试。");
  } finally {
    saving.value = false;
  }
}
function openDetail(item: Garment) {
  selected.value = item;
  editing.value = false;
  error.value = "";
}
function addAnotherToExpense() {
  if (!initialExpenseId.value) return;
  const expenseId = initialExpenseId.value;
  selected.value = null;
  selectedExpense.value = null;
  void openFromExpense(expenseId);
}
function createTaskForGarment(item: Garment) {
  emit("navigate", {
    page: "tasks",
    action: "create-for-garment",
    id: item.id,
  });
}
async function searchCity() {
  if (cityQuery.value.trim().length < 2) {
    cityResults.value = [];
    return;
  }
  citySearching.value = true;
  try {
    cityResults.value = await apiRequest<City[]>(
      `/wardrobe/locations?q=${encodeURIComponent(cityQuery.value.trim())}`,
    );
  } catch (reason) {
    weatherError.value = message(reason, "暂时无法搜索城市，请稍后重试。");
  } finally {
    citySearching.value = false;
  }
}
async function saveDefaultCity(city: City) {
  const family = session.family;
  if (!family || citySaving.value) return;
  citySaving.value = true;
  weatherError.value = "";
  citySaveMessage.value = "";
  try {
    let updatedFamily: FamilySummary;
    try {
      updatedFamily = await apiRequest<FamilySummary>(
        `/families/${family.id}/default-city`,
        {
          method: "PATCH",
          body: JSON.stringify({ version: family.version, city }),
        },
      );
    } catch (reason) {
      if (
        !(reason instanceof ApiClientError) ||
        reason.code !== "VERSION_CONFLICT"
      )
        throw reason;
      const latestFamily = await apiRequest<FamilySummary | null>(
        "/families/current",
      );
      if (!latestFamily || latestFamily.id !== family.id) throw reason;
      updatedFamily = await apiRequest<FamilySummary>(
        `/families/${latestFamily.id}/default-city`,
        {
          method: "PATCH",
          body: JSON.stringify({ version: latestFamily.version, city }),
        },
      );
    }
    session.family = updatedFamily;
    cityResults.value = [];
    cityQuery.value = "";
    citySettingsOpen.value = false;
    citySaveMessage.value = `家庭默认城市已设置为${updatedFamily.defaultCity?.name ?? city.name}`;
  } catch (reason) {
    weatherError.value = message(reason, "保存默认城市失败，请重试。");
  } finally {
    citySaving.value = false;
  }
}
function cityLocalToday(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
async function loadTodayWeather() {
  const city = session.family?.defaultCity;
  if (!city) {
    todayWeather.value = null;
    return;
  }
  weatherLoading.value = true;
  weatherError.value = "";
  try {
    const result = await apiRequest<{
      days: Array<{
        date: string;
        available: boolean;
        temperatureMax: number | null;
        temperatureMin: number | null;
        precipitationMm: number | null;
        weatherCode: number | null;
      }>;
    }>("/wardrobe/weather/forecast", {
      method: "POST",
      body: JSON.stringify({
        city,
        startDate: cityLocalToday(city.timezone),
        days: 1,
      }),
    });
    todayWeather.value = result.days[0] ?? null;
  } catch (reason) {
    weatherError.value = message(reason, "天气暂时不可用。");
  } finally {
    weatherLoading.value = false;
  }
}
async function recommendDaily() {
  const requestSignature = JSON.stringify([
    outfitScene.value,
    outfitIdea.value.trim(),
    weatherConditionChoice.value,
  ]);
  recommendationLoading.value = true;
  recommendationError.value = "";
  recommendations.value = [];
  let fallback: DailyRecommendationResult | null = null;
  try {
    const key = newIdempotencyKey();
    const response = await apiRequest<{
      run: {
        id: string | null;
        status: string;
        result?: unknown;
        errorCode?: string | null;
      };
      fallback: DailyRecommendationResult;
      notice: string | null;
    }>("/ai/wardrobe-recommendations", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({
        mode: "DAILY",
        scene: outfitScene.value,
        ...(outfitIdea.value.trim() ? { idea: outfitIdea.value.trim() } : {}),
        ...(weatherConditionChoice.value
          ? { weatherCondition: weatherConditionChoice.value }
          : {}),
        idempotencyKey: key,
      }),
    });
    fallback = response.fallback;
    if (
      requestSignature !==
      JSON.stringify([
        outfitScene.value,
        outfitIdea.value.trim(),
        weatherConditionChoice.value,
      ])
    )
      return;
    let result = response.run.result as
      DailyRecommendationResult | null | undefined;
    if (response.run.id && response.run.status !== "SUCCEEDED") {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (
          requestSignature !==
          JSON.stringify([
            outfitScene.value,
            outfitIdea.value.trim(),
            weatherConditionChoice.value,
          ])
        )
          return;
        const completed = await apiRequest<{
          status: string;
          errorCode: string | null;
          result: DailyRecommendationResult | null;
        }>(`/ai/runs/${response.run.id}`);
        if (completed.status === "SUCCEEDED" && completed.result) {
          result = completed.result;
          break;
        }
        if (["FAILED", "CANCELLED"].includes(completed.status)) {
          result = fallback;
          recommendationError.value =
            "AI 推荐暂不可用，已展示规则搭配；你仍可继续收藏。";
          break;
        }
      }
    }
    if (!result) {
      result = fallback;
      recommendationError.value = "AI 响应超时，已展示规则搭配。";
    }
    recommendations.value = result.recommendations;
    if (response.notice) recommendationError.value = response.notice;
    if (!result.recommendations.length)
      recommendationError.value = result.message ?? "暂无可用搭配。";
    if (result.weatherError) recommendationError.value = result.weatherError;
  } catch (reason) {
    if (fallback) {
      recommendations.value = fallback.recommendations;
      recommendationError.value =
        "AI 推荐未完成，已展示规则搭配；你仍可继续收藏。";
    } else {
      recommendationError.value = message(reason, "生成搭配失败，请稍后重试。");
    }
  } finally {
    recommendationLoading.value = false;
  }
}
async function recommendTrip() {
  if (!tripCity.value) {
    tripError.value = "请先搜索并选择目的地。";
    return;
  }
  tripLoading.value = true;
  tripError.value = "";
  tripResult.value = null;
  let fallback: TripRecommendationResult | null = null;
  const requestSignature = JSON.stringify([
    outfitScene.value,
    outfitIdea.value.trim(),
    tripCity.value,
    tripStartOn.value,
    tripDays.value,
  ]);
  try {
    const key = newIdempotencyKey();
    const response = await apiRequest<{
      run: {
        id: string | null;
        status: string;
        result?: unknown;
        errorCode?: string | null;
      };
      fallback: TripRecommendationResult;
      notice: string | null;
    }>("/ai/wardrobe-recommendations", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({
        mode: "TRIP",
        scene: outfitScene.value,
        city: tripCity.value,
        startOn: tripStartOn.value,
        days: tripDays.value,
        ...(outfitIdea.value.trim() ? { idea: outfitIdea.value.trim() } : {}),
        idempotencyKey: key,
      }),
    });
    fallback = response.fallback;
    if (
      requestSignature !==
      JSON.stringify([
        outfitScene.value,
        outfitIdea.value.trim(),
        tripCity.value,
        tripStartOn.value,
        tripDays.value,
      ])
    )
      return;
    let result = response.run.result as
      TripRecommendationResult | null | undefined;
    if (response.run.id && response.run.status !== "SUCCEEDED") {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (
          requestSignature !==
          JSON.stringify([
            outfitScene.value,
            outfitIdea.value.trim(),
            tripCity.value,
            tripStartOn.value,
            tripDays.value,
          ])
        )
          return;
        const completed = await apiRequest<{
          status: string;
          errorCode: string | null;
          result: TripRecommendationResult | null;
        }>(`/ai/runs/${response.run.id}`);
        if (completed.status === "SUCCEEDED" && completed.result) {
          result = completed.result;
          break;
        }
        if (["FAILED", "CANCELLED"].includes(completed.status)) {
          result = fallback;
          tripError.value = "AI 推荐暂不可用，已展示规则版逐日搭配。";
          break;
        }
      }
    }
    if (!result) {
      result = fallback;
      tripError.value = "AI 响应超时，已展示规则版逐日搭配。";
    }
    tripResult.value = result;
    if (response.notice) tripError.value = response.notice;
  } catch (reason) {
    if (fallback) {
      tripResult.value = fallback;
      tripError.value = "AI 推荐未完成，已展示规则版逐日搭配。";
    } else {
      tripError.value = message(reason, "生成旅行穿搭失败，请稍后重试。");
    }
  } finally {
    tripLoading.value = false;
  }
}
async function loadSavedOutfits() {
  savedOutfitsLoading.value = true;
  outfitMessage.value = "";
  try {
    savedOutfits.value = await apiRequest<SavedOutfit[]>("/wardrobe/outfits");
    selectedOutfitGarments.value = Object.fromEntries(
      savedOutfits.value.map((outfit) => [
        outfit.id,
        outfit.items.map(({ garmentId }) => garmentId),
      ]),
    );
  } catch (reason) {
    outfitMessage.value = message(reason, "收藏列表暂时无法加载。");
  } finally {
    savedOutfitsLoading.value = false;
  }
}
async function saveRecommendation(item: RecommendedOutfit) {
  outfitMessage.value = "";
  try {
    await apiRequest<SavedOutfit>("/wardrobe/outfits", {
      method: "POST",
      body: JSON.stringify({
        name: item.name,
        scene: item.scene,
        items: item.items.map(({ garmentId, role, sortOrder }) => ({
          garmentId,
          role,
          sortOrder,
        })),
      }),
    });
    outfitMessage.value = "已收藏这套搭配。";
  } catch (reason) {
    outfitMessage.value = message(
      reason,
      "收藏失败，请确认衣物仍属于你的衣柜。",
    );
  }
}
async function renameOutfit(outfit: SavedOutfit) {
  const name = window.prompt("为这套搭配命名", outfit.name)?.trim();
  if (!name || name === outfit.name) return;
  try {
    await apiRequest(`/wardrobe/outfits/${outfit.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, version: outfit.version }),
    });
    await loadSavedOutfits();
  } catch (reason) {
    outfitMessage.value = message(reason, "修改失败，请刷新后重试。");
  }
}
function toggleOutfitGarment(outfit: SavedOutfit, garmentId: string) {
  const selectedIds =
    selectedOutfitGarments.value[outfit.id] ??
    outfit.items.map(({ garmentId: id }) => id);
  selectedOutfitGarments.value[outfit.id] = selectedIds.includes(garmentId)
    ? selectedIds.filter((id) => id !== garmentId)
    : [...selectedIds, garmentId];
}
async function saveOutfitGarments(outfit: SavedOutfit) {
  const selectedIds =
    selectedOutfitGarments.value[outfit.id] ??
    outfit.items.map(({ garmentId }) => garmentId);
  const items = selectedIds.flatMap((garmentId, sortOrder) => {
    const garment = rows.value.find(({ id }) => id === garmentId);
    if (!garment || garment.ownerId !== session.account?.id) return [];
    const role =
      garment.category === "OUTERWEAR"
        ? "OUTER"
        : garment.category === "BOTTOM"
          ? "BOTTOM"
          : garment.category === "ONE_PIECE"
            ? "ONE_PIECE"
            : garment.category === "SHOES"
              ? "SHOES"
              : garment.category === "ACCESSORY"
                ? "ACCESSORY"
                : garment.layers.includes("MID")
                  ? "MID"
                  : "TOP";
    return [{ garmentId, role, sortOrder }];
  });
  if (!items.length) {
    outfitMessage.value = "至少选择一件本人衣物。";
    return;
  }
  try {
    await apiRequest(`/wardrobe/outfits/${outfit.id}`, {
      method: "PATCH",
      body: JSON.stringify({ items, version: outfit.version }),
    });
    await loadSavedOutfits();
    outfitMessage.value = "搭配单品已更新。";
  } catch (reason) {
    outfitMessage.value = message(
      reason,
      "更新失败，请检查所选衣物是否仍可用。",
    );
  }
}
async function createManualOutfit() {
  const items = manualOutfitGarmentIds.value.flatMap((garmentId, sortOrder) => {
    const garment = editableRows.value.find(({ id }) => id === garmentId);
    if (!garment) return [];
    const role =
      garment.category === "OUTERWEAR"
        ? "OUTER"
        : garment.category === "BOTTOM"
          ? "BOTTOM"
          : garment.category === "ONE_PIECE"
            ? "ONE_PIECE"
            : garment.category === "SHOES"
              ? "SHOES"
              : garment.category === "ACCESSORY"
                ? "ACCESSORY"
                : garment.layers.includes("MID")
                  ? "MID"
                  : "TOP";
    return [{ garmentId, role, sortOrder }];
  });
  if (!manualOutfitName.value.trim() || !items.length) {
    outfitMessage.value = "请填写名称并至少选择一件本人衣物。";
    return;
  }
  try {
    await apiRequest("/wardrobe/outfits", {
      method: "POST",
      body: JSON.stringify({
        name: manualOutfitName.value.trim(),
        scene: outfitScene.value,
        items,
      }),
    });
    manualOutfitName.value = "";
    manualOutfitGarmentIds.value = [];
    await loadSavedOutfits();
    outfitMessage.value = "手动搭配已收藏。";
  } catch (reason) {
    outfitMessage.value = message(reason, "保存手动搭配失败。");
  }
}
async function removeOutfit(outfit: SavedOutfit) {
  if (!window.confirm(`取消收藏“${outfit.name}”吗？`)) return;
  try {
    await apiRequest(`/wardrobe/outfits/${outfit.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: outfit.version }),
    });
    await loadSavedOutfits();
  } catch (reason) {
    outfitMessage.value = message(reason, "取消收藏失败，请刷新后重试。");
  }
}
function label(
  value: string,
  options: Array<{ value: string; label: string }>,
) {
  return options.find((item) => item.value === value)?.label ?? value;
}
watch(
  () => [session.activeSpace, session.family?.id] as const,
  () => {
    selected.value = null;
    editing.value = false;
    void load();
  },
  { immediate: true },
);
onMounted(async () => {
  wardrobeMounted = true;
  try {
    expenseCategories.value =
      await apiRequest<ExpenseCategory[]>("/categories");
    if (!form.value.expenseCategoryId)
      form.value.expenseCategoryId =
        expenseCategories.value.find(({ code }) => code === "CLOTHING")?.id ??
        expenseCategories.value[0]?.id ??
        "";
  } catch {
    // Manual wardrobe entry remains available if ledger categories are unavailable.
  }
  void loadExpenseOptions();
  void apiRequest<{ enabled: boolean }>("/ai/status")
    .then((status) => (aiEnabled.value = status.enabled))
    .catch(() => (aiEnabled.value = false));
  if (props.initialAction === "add-existing-expense" && props.targetId) {
    await openFromExpense(props.targetId);
  } else if (
    props.initialAction === "create-from-expense-draft" &&
    props.expenseDraft
  ) {
    openFromExpenseDraft(props.expenseDraft);
  }
});
watch(
  () => [
    session.family?.defaultCity?.latitude,
    session.family?.defaultCity?.longitude,
    session.family?.defaultCity?.timezone,
  ],
  () => void loadTodayWeather(),
  { immediate: true },
);
watch([outfitIdea, outfitScene, weatherConditionChoice], () => {
  recommendations.value = [];
  recommendationError.value = "";
});
watch([outfitIdea, outfitScene, tripCity, tripStartOn, tripDays], () => {
  tripResult.value = null;
  tripError.value = "";
});
let debounce = 0;
let citySearchTimer = 0;
watch([query, categoryFilter, colorFilter, statusFilter, seasonFilter], () => {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void load(), 220);
});
watch(cityQuery, () => {
  window.clearTimeout(citySearchTimer);
  citySearchTimer = window.setTimeout(() => void searchCity(), 280);
});
watch(expenseSearch, () => {
  window.clearTimeout(expenseDebounce);
  expenseDebounce = window.setTimeout(() => void loadExpenseOptions(), 220);
});
onBeforeUnmount(() => {
  wardrobeMounted = false;
  window.clearTimeout(debounce);
  window.clearTimeout(citySearchTimer);
  window.clearTimeout(expenseDebounce);
  void discardTemporaryImage();
});
</script>

<template>
  <section class="wardrobe-page">
    <section
      v-if="session.family?.status === 'ACTIVE'"
      class="wardrobe-weather-panel"
      aria-label="天气"
    >
      <div class="wardrobe-weather-primary">
        <div class="wardrobe-weather-city">
          <strong>{{
            session.family.defaultCity?.name || "尚未设置城市"
          }}</strong>
        </div>
        <p v-if="weatherLoading" class="wardrobe-weather-state" role="status">
          正在读取天气…
        </p>
        <div v-else-if="todayWeather?.available" class="wardrobe-weather-state">
          <span
            class="wardrobe-weather-icon"
            role="img"
            :aria-label="weatherPresentation.label"
            >{{ weatherPresentation.icon }}</span
          >
          <span class="wardrobe-weather-condition">
            {{ weatherPresentation.label }}
          </span>
          <span class="wardrobe-weather-metric">
            🌡️ {{ todayWeather.temperatureMin ?? "—" }}°–{{
              todayWeather.temperatureMax ?? "—"
            }}°
          </span>
          <span class="wardrobe-weather-metric">
            🌧️ 降水 {{ todayWeather.precipitationMm ?? "—" }} mm
          </span>
        </div>
        <p v-else class="wardrobe-weather-state wardrobe-weather-muted">
          {{
            session.family.defaultCity
              ? "今日天气暂不可用"
              : "设置城市后显示天气与穿搭参考"
          }}
        </p>
        <div class="wardrobe-weather-actions">
          <button
            v-if="session.family.defaultCity"
            type="button"
            class="wardrobe-weather-refresh"
            :disabled="weatherLoading"
            @click="loadTodayWeather"
          >
            <span aria-hidden="true">↻</span>刷新
          </button>
          <details
            class="wardrobe-weather-settings"
            :open="citySettingsOpen || !session.family.defaultCity"
            @toggle="
              citySettingsOpen = ($event.target as HTMLDetailsElement).open
            "
          >
            <summary>
              {{ session.family.defaultCity ? "城市设置" : "设置城市" }}
            </summary>
            <div class="wardrobe-city-picker">
              <label
                >搜索并设置家庭默认城市<input
                  v-model="cityQuery"
                  maxlength="100"
                  placeholder="输入城市名，例如杭州"
              /></label>
              <span v-if="citySearching" class="wardrobe-weather-muted"
                >正在搜索…</span
              >
              <span
                v-if="citySaving"
                class="wardrobe-weather-muted"
                role="status"
                >正在保存家庭默认城市…</span
              >
              <button
                v-for="city in cityResults"
                :key="`${city.latitude}-${city.longitude}-${city.timezone}`"
                type="button"
                class="wardrobe-city-result"
                :disabled="citySaving"
                @click="saveDefaultCity(city)"
              >
                {{ city.name }} <small>{{ city.timezone }}</small>
              </button>
            </div>
          </details>
        </div>
      </div>
      <p v-if="weatherError" class="wardrobe-weather-error" role="alert">
        {{ weatherError }}
      </p>
      <p v-if="citySaveMessage" class="wardrobe-weather-success" role="status">
        {{ citySaveMessage }}
      </p>
      <small class="wardrobe-weather-attribution">
        天气数据：Open-Meteo · CC BY 4.0
      </small>
    </section>
    <header class="wardrobe-heading">
      <div>
        <p class="wardrobe-eyebrow">CLOSET · 衣物档案</p>
        <h2>把常穿的衣服，放在看得见的地方。</h2>
        <p>先手工记录，照片会自动缩小并生成列表缩略图。</p>
      </div>
      <button class="wardrobe-primary" @click="beginCreate">
        <AppIcon name="plus" :size="18" />添加衣物
      </button>
    </header>
    <nav class="wardrobe-tabs" aria-label="衣柜功能">
      <button
        :aria-current="activeTab === 'closet' ? 'page' : undefined"
        @click="activeTab = 'closet'"
      >
        我的衣物
      </button>
      <button
        :aria-current="activeTab === 'daily' ? 'page' : undefined"
        @click="activeTab = 'daily'"
      >
        今日穿搭
      </button>
      <button
        :aria-current="activeTab === 'trip' ? 'page' : undefined"
        @click="activeTab = 'trip'"
      >
        旅行穿搭
      </button>
      <button
        :aria-current="activeTab === 'saved' ? 'page' : undefined"
        @click="
          activeTab = 'saved';
          void loadSavedOutfits();
        "
      >
        收藏搭配
      </button>
    </nav>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-if="success" class="wardrobe-expense-note" role="status">
      {{ success }}
    </p>
    <section v-if="activeTab === 'daily'" class="wardrobe-outfit-page">
      <div class="wardrobe-outfit-controls">
        <label
          >场景<select v-model="outfitScene">
            <option
              v-for="option in scenes"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select></label
        >
        <label
          >天气条件<select v-model="weatherConditionChoice">
            <option value="">使用默认城市天气</option>
            <option value="COLD">偏冷</option>
            <option value="MILD">适中</option>
            <option value="WARM">偏热</option>
            <option value="RAINY">有雨</option>
          </select></label
        >
        <label class="wardrobe-idea-field"
          >穿搭想法（选填）<textarea
            v-model="outfitIdea"
            maxlength="160"
            placeholder="例如：想叠穿、偏好浅色、避免黑色"
          ></textarea>
        </label>
        <button
          class="wardrobe-primary"
          :disabled="recommendationLoading"
          @click="recommendDaily"
        >
          {{ recommendationLoading ? "正在搭配…" : "生成今日搭配" }}
        </button>
        <small class="wardrobe-outfit-ai-note"
          >点击生成时，会把想法、场景、天气和候选衣物属性发送给系统配置的 AI
          服务，从现有衣物组合中筛选并说明理由；AI 不能添加库存外衣物。每日最多
          5 次，未配置、超额或失败时自动显示规则搭配。</small
        >
      </div>
      <p class="wardrobe-outfit-note">
        按衣物的季节、场景和叠穿层次生成规则搭配；天气缺失时可手选条件。推荐不会自动购买或修改衣物。
      </p>
      <p
        v-if="recommendationError"
        class="wardrobe-weather-error"
        role="status"
      >
        {{ recommendationError }}
      </p>
      <div v-if="recommendations.length" class="wardrobe-recommendation-grid">
        <article
          v-for="outfit in recommendations"
          :key="outfit.id"
          class="wardrobe-recommendation"
        >
          <header>
            <div>
              <p class="wardrobe-eyebrow">RULE-BASED LOOK</p>
              <h3>{{ outfit.name }}</h3>
            </div>
            <button class="wardrobe-quiet" @click="saveRecommendation(outfit)">
              收藏
            </button>
          </header>
          <div class="wardrobe-recommendation-items">
            <div
              v-for="item in outfit.items"
              :key="item.garmentId"
              class="wardrobe-recommendation-item"
            >
              <img :src="item.imageUrl" :alt="item.name" loading="lazy" />
              <span
                ><strong>{{ item.name }}</strong
                ><small>{{
                  label(item.role, [
                    { value: "TOP", label: "上装" },
                    { value: "MID", label: "中层" },
                    { value: "OUTER", label: "外层" },
                    { value: "BOTTOM", label: "下装" },
                    { value: "ONE_PIECE", label: "连体" },
                    { value: "SHOES", label: "鞋履" },
                    { value: "ACCESSORY", label: "配饰" },
                  ])
                }}</small></span
              >
            </div>
          </div>
          <p
            v-for="warning in outfit.warnings"
            :key="warning"
            class="wardrobe-outfit-note"
          >
            {{ warning }}
          </p>
          <p class="wardrobe-outfit-reason">{{ outfit.reason }}</p>
        </article>
      </div>
    </section>
    <section v-else-if="activeTab === 'saved'" class="wardrobe-saved-page">
      <p v-if="outfitMessage" class="wardrobe-expense-note" role="status">
        {{ outfitMessage }}
      </p>
      <details class="wardrobe-outfit-editor wardrobe-manual-composer">
        <summary>手动挑选单品，创建一套搭配</summary>
        <label class="wardrobe-manual-name"
          >搭配名称<input
            v-model="manualOutfitName"
            maxlength="100"
            placeholder="例如：周末散步"
        /></label>
        <div v-if="editableRows.length" class="wardrobe-compose-options">
          <label v-for="garment in editableRows" :key="garment.id">
            <input
              type="checkbox"
              :checked="manualOutfitGarmentIds.includes(garment.id)"
              @change="
                manualOutfitGarmentIds = toggle(
                  manualOutfitGarmentIds,
                  garment.id,
                )
              "
            />{{ garment.name }} · {{ label(garment.category, categories) }}
          </label>
        </div>
        <p v-else class="wardrobe-outfit-note">
          当前没有本人可穿的衣物可以加入搭配。
        </p>
        <button
          class="wardrobe-primary"
          :disabled="!editableRows.length"
          @click="createManualOutfit"
        >
          保存搭配
        </button>
      </details>
      <div v-if="savedOutfitsLoading" class="wardrobe-empty">
        正在读取收藏搭配…
      </div>
      <div v-else-if="savedOutfits.length" class="wardrobe-recommendation-grid">
        <article
          v-for="outfit in savedOutfits"
          :key="outfit.id"
          class="wardrobe-recommendation"
          :class="{ 'wardrobe-invalid': !outfit.valid }"
        >
          <header>
            <div>
              <p class="wardrobe-eyebrow">
                {{ outfit.valid ? "SAVED LOOK" : "ITEMS CHANGED" }}
              </p>
              <h3>{{ outfit.name }}</h3>
            </div>
            <div class="wardrobe-detail-actions">
              <button class="wardrobe-quiet" @click="renameOutfit(outfit)">
                改名</button
              ><button class="wardrobe-danger" @click="removeOutfit(outfit)">
                取消收藏
              </button>
            </div>
          </header>
          <div class="wardrobe-recommendation-items">
            <div
              v-for="item in outfit.items"
              :key="item.garmentId"
              class="wardrobe-recommendation-item"
            >
              <img
                v-if="item.garment"
                :src="item.garment.imageUrl"
                :alt="item.garment.name"
                loading="lazy"
              />
              <span
                ><strong>{{ item.garment?.name ?? "衣物已不可用" }}</strong
                ><small>{{
                  item.available ? item.role : "已不可穿"
                }}</small></span
              >
            </div>
          </div>
          <details class="wardrobe-outfit-editor">
            <summary>调整这套搭配中的单品</summary>
            <div class="wardrobe-compose-options">
              <label v-for="garment in editableRows" :key="garment.id">
                <input
                  type="checkbox"
                  :checked="
                    (
                      selectedOutfitGarments[outfit.id] ??
                      outfit.items.map(({ garmentId }) => garmentId)
                    ).includes(garment.id)
                  "
                  @change="toggleOutfitGarment(outfit, garment.id)"
                />
                {{ garment.name }}
              </label>
            </div>
            <button class="wardrobe-quiet" @click="saveOutfitGarments(outfit)">
              保存单品调整
            </button>
          </details>
        </article>
      </div>
      <div v-else class="wardrobe-empty">
        <h3>还没有收藏搭配</h3>
        <p>先生成今日搭配，再把喜欢的组合收藏起来。</p>
        <button class="wardrobe-primary" @click="activeTab = 'daily'">
          去生成搭配
        </button>
      </div>
    </section>
    <section v-else-if="activeTab === 'trip'" class="wardrobe-outfit-page">
      <div class="wardrobe-trip-controls">
        <label
          >目的地搜索<input
            v-model="cityQuery"
            maxlength="100"
            placeholder="例如：京都"
        /></label>
        <span v-if="citySearching" class="wardrobe-weather-muted"
          >正在搜索…</span
        >
        <button
          v-for="city in cityResults"
          :key="`${city.latitude}-${city.longitude}-${city.timezone}`"
          class="wardrobe-city-result"
          type="button"
          @click="
            tripCity = city;
            cityResults = [];
            cityQuery = '';
          "
        >
          {{ city.name }}<small>{{ city.timezone }}</small>
        </button>
        <p v-if="tripCity" class="wardrobe-trip-destination">
          已选目的地：{{ tripCity.name }}
        </p>
        <label>出发日期<input v-model="tripStartOn" type="date" /></label>
        <label
          >旅行天数<input
            v-model.number="tripDays"
            type="number"
            min="1"
            max="30"
        /></label>
        <label
          >场景<select v-model="outfitScene">
            <option
              v-for="option in scenes"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select></label
        >
        <label class="wardrobe-idea-field"
          >穿搭想法（选填）<textarea
            v-model="outfitIdea"
            maxlength="160"
            placeholder="例如：需要叠穿、偏好连衣裙、避免黑色"
          ></textarea>
          <small
            >点击生成时，会将穿搭想法、场景、逐日天气和候选衣物属性合并为一次 AI
            请求；AI 只能选择当天已有候选。每日最多 5
            次，未配置、超额或失败时显示规则版逐日搭配。</small
          >
        </label>
        <button
          class="wardrobe-primary"
          :disabled="tripLoading || !tripCity"
          @click="recommendTrip"
        >
          {{ tripLoading ? "正在生成…" : "生成逐日穿搭" }}
        </button>
      </div>
      <p class="wardrobe-outfit-note">
        最多支持 30
        天；天气预报目前只覆盖近期范围，超出范围会明确显示无预报。衣物可以在多天重复穿着。
      </p>
      <p v-if="tripError" class="wardrobe-weather-error" role="alert">
        {{ tripError }}
      </p>
      <p
        v-if="tripResult?.weatherError"
        class="wardrobe-weather-error"
        role="status"
      >
        {{ tripResult.weatherError }}
      </p>
      <p v-if="tripResult" class="wardrobe-weather-attribution">
        {{
          tripResult.weatherSource
            ? `天气数据：${tripResult.weatherSource} · CC BY 4.0`
            : "未取得天气数据；推荐不代表真实天气预报。"
        }}
      </p>
      <div v-if="tripResult" class="wardrobe-trip-days">
        <article
          v-for="day in tripResult.days"
          :key="day.date"
          class="wardrobe-trip-day"
        >
          <header>
            <div>
              <p class="wardrobe-eyebrow">{{ day.date }}</p>
              <h3>{{ day.recommendation?.name ?? "当天暂无完整搭配" }}</h3>
            </div>
            <button
              v-if="day.recommendation"
              class="wardrobe-quiet"
              @click="saveRecommendation(day.recommendation)"
            >
              收藏当天搭配
            </button>
          </header>
          <p class="wardrobe-outfit-note">
            {{
              day.weather?.available
                ? `天气 ${day.weather.temperatureMin ?? "—"}° 至 ${day.weather.temperatureMax ?? "—"}° · 降水 ${day.weather.precipitationMm ?? "—"} mm`
                : "当天暂无可用天气预报"
            }}{{
              day.condition
                ? ` · 按${day.condition === "COLD" ? "偏冷" : day.condition === "RAINY" ? "有雨" : day.condition === "WARM" ? "偏热" : "适中"}条件搭配`
                : " · 天气条件未知"
            }}
          </p>
          <p v-if="day.message" class="wardrobe-weather-error">
            {{ day.message }}
          </p>
          <div v-if="day.recommendation" class="wardrobe-recommendation-items">
            <div
              v-for="item in day.recommendation.items"
              :key="item.garmentId"
              class="wardrobe-recommendation-item"
            >
              <img :src="item.imageUrl" :alt="item.name" loading="lazy" /><span
                ><strong>{{ item.name }}</strong
                ><small>{{ item.role }}</small></span
              >
            </div>
          </div>
          <p v-if="day.recommendation" class="wardrobe-outfit-reason">
            {{ day.recommendation.reason }}
          </p>
        </article>
      </div>
    </section>
    <template v-else-if="editing">
      <form class="wardrobe-form" @submit.prevent="save">
        <div class="wardrobe-form-head">
          <div>
            <p class="wardrobe-eyebrow">
              {{ selected ? "EDIT GARMENT" : "NEW GARMENT" }}
            </p>
            <h2>{{ selected ? "编辑衣物" : "录入一件衣物" }}</h2>
          </div>
          <button
            type="button"
            class="wardrobe-quiet"
            @click="props.expenseDraft ? returnToExpenseDraft() : cancelEdit()"
          >
            {{ props.expenseDraft ? "返回账单草稿" : "返回" }}
          </button>
        </div>
        <div class="wardrobe-form-grid">
          <div class="wardrobe-photo-field">
            <input
              ref="imageInput"
              class="wardrobe-hidden-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              @change="chooseImage"
            />
            <button
              v-if="imagePreview"
              type="button"
              class="wardrobe-photo-preview"
              @click="imageInput?.click()"
            >
              <img :src="imagePreview" alt="衣物照片预览" /><span v-if="saving"
                >正在处理照片…</span
              ><span v-else>更换照片</span>
            </button>
            <button
              v-else
              type="button"
              class="wardrobe-photo-drop"
              @click="imageInput?.click()"
            >
              <AppIcon name="camera" :size="30" /><strong>添加一张照片</strong
              ><small>建议正面、光线明亮</small>
            </button>
            <p>浏览器先压缩，服务器再校验并生成缩略图。</p>
            <button
              v-if="uploadedImage && aiEnabled"
              type="button"
              class="wardrobe-quiet"
              :disabled="recognizing || saving"
              :aria-busy="recognizing"
              @click="recognizeImage"
            >
              <span
                v-if="recognizing"
                class="wardrobe-recognition-spinner"
                aria-hidden="true"
              />
              {{ recognizing ? "正在识别…" : "AI 识别并填入草稿" }}
            </button>
            <p
              v-if="recognitionMessage"
              class="wardrobe-expense-note"
              role="status"
              aria-live="polite"
            >
              {{ recognitionMessage }}
            </p>
          </div>
          <div class="wardrobe-fields">
            <label
              >衣物名称<input
                v-model="form.name"
                maxlength="100"
                placeholder="例如：米色针织衫"
                required
            /></label>
            <label
              >类别<select v-model="form.category">
                <option
                  v-for="option in categories"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select></label
            >
            <label
              >主色<input
                v-model="form.color"
                maxlength="40"
                placeholder="可留空"
            /></label>
            <label
              >添置日期<input v-model="form.acquiredOn" type="date"
            /></label>
            <fieldset>
              <legend>适用季节 · 可多选</legend>
              <div class="wardrobe-options">
                <label
                  v-for="option in seasons"
                  :key="option.value"
                  class="wardrobe-check"
                  ><input
                    type="checkbox"
                    :checked="form.seasons.includes(option.value)"
                    @change="form.seasons = toggle(form.seasons, option.value)"
                  />{{ option.label }}</label
                >
              </div>
            </fieldset>
            <fieldset>
              <legend>适用层次 · 可多选</legend>
              <div class="wardrobe-options">
                <label
                  v-for="option in layers"
                  :key="option.value"
                  class="wardrobe-check"
                  ><input
                    type="checkbox"
                    :checked="form.layers.includes(option.value)"
                    @change="form.layers = toggle(form.layers, option.value)"
                  />{{ option.label }}</label
                >
              </div>
            </fieldset>
            <fieldset>
              <legend>适用场景</legend>
              <div class="wardrobe-options">
                <label
                  v-for="option in scenes"
                  :key="option.value"
                  class="wardrobe-check"
                  ><input
                    type="checkbox"
                    :checked="form.scenes.includes(option.value)"
                    @change="form.scenes = toggle(form.scenes, option.value)"
                  />{{ option.label }}</label
                >
              </div>
            </fieldset>
            <label class="wardrobe-wide"
              >AI 穿搭建议<textarea
                v-model="form.stylingAdvice"
                maxlength="80"
                rows="2"
                placeholder="AI 识别后生成简短建议，也可以自行修改"
              ></textarea>
              <small>用于后续穿搭推荐理解这件衣物的适合场景和搭配方向。</small>
            </label>
            <label
              >当前状态<select v-model="form.status">
                <option
                  v-for="option in statuses"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select></label
            >
            <label
              >收纳位置<input
                v-model="form.storageLocation"
                maxlength="100"
                placeholder="例如：主卧衣柜左侧"
            /></label>
            <label v-if="session.family?.status === 'ACTIVE'"
              >衣物归属<select v-model="form.ownerId">
                <option :value="session.account?.id">
                  {{ session.account?.nickname }}（自己）
                </option>
                <option
                  v-for="member in session.family.members.filter(
                    (item) => item.id !== session.account?.id,
                  )"
                  :key="member.id"
                  :value="member.id"
                >
                  {{ member.nickname }}（代购）
                </option>
              </select></label
            >
            <fieldset v-if="!selected" class="wardrobe-wide">
              <legend>关联账单</legend>
              <div class="wardrobe-options">
                <label class="wardrobe-check"
                  ><input
                    v-model="form.expenseMode"
                    type="radio"
                    value="NONE"
                  />暂不关联</label
                ><label class="wardrobe-check"
                  ><input
                    v-model="form.expenseMode"
                    type="radio"
                    value="NEW"
                  />新建账单</label
                ><label class="wardrobe-check"
                  ><input
                    v-model="form.expenseMode"
                    type="radio"
                    value="EXISTING"
                  />关联已有账单</label
                >
              </div>
              <p
                v-if="form.expenseMode === 'EXISTING' && selectedExpense"
                class="wardrobe-expense-note"
              >
                {{ selectedExpense.title }} · ¥{{ selectedExpense.amount }} ·
                {{ selectedExpense.occurredOn }}，此账单不会重复创建。
              </p>
              <label
                v-if="form.expenseMode === 'EXISTING'"
                class="wardrobe-expense-select"
                >搜索已有账单<input
                  v-model="expenseSearch"
                  type="search"
                  maxlength="120"
                  placeholder="按账单名称或备注搜索"
              /></label>
              <label
                v-if="form.expenseMode === 'EXISTING'"
                class="wardrobe-expense-select"
                >选择已有账单<select
                  :value="selectedExpense?.id ?? ''"
                  :disabled="expenseOptionsLoading"
                  @change="
                    selectExpense(($event.target as HTMLSelectElement).value)
                  "
                >
                  <option value="" disabled>
                    {{
                      expenseOptionsLoading
                        ? "正在加载账单…"
                        : expenseOptions.length
                          ? "请选择账单"
                          : "暂无可关联的账单"
                    }}
                  </option>
                  <option
                    v-for="expense in expenseOptions"
                    :key="expense.id"
                    :value="expense.id"
                  >
                    {{ expense.occurredOn }} · {{ expense.title }} · ¥{{
                      expense.amount
                    }}
                    · {{ expense.category.name }}
                  </option>
                </select></label
              >
              <div
                v-if="form.expenseMode === 'NEW'"
                class="wardrobe-fields wardrobe-expense-fields"
              >
                <label
                  >账单名称<input
                    v-model="form.expenseTitle"
                    maxlength="120"
                    placeholder="默认使用衣物名称"
                /></label>
                <label
                  >账单金额<input
                    v-model="form.expenseAmount"
                    inputmode="decimal"
                    placeholder="例如 299.00"
                /></label>
                <label
                  >账单日期<input
                    v-model="form.expenseDate"
                    type="date"
                    required
                /></label>
                <label
                  >账单分类<select v-model="form.expenseCategoryId" required>
                    <option
                      v-for="category in expenseCategories"
                      :key="category.id"
                      :value="category.id"
                    >
                      {{ category.name }}
                    </option>
                  </select></label
                >
                <details class="wardrobe-expense-extra">
                  <summary>补充账单数量、单价与备注</summary>
                  <div class="wardrobe-expense-extra-grid">
                    <label
                      >数量<input
                        v-model="form.expenseQuantity"
                        inputmode="decimal"
                        placeholder="可选"
                    /></label>
                    <label
                      >单位<input
                        v-model="form.expenseUnit"
                        maxlength="24"
                        placeholder="件"
                    /></label>
                    <label
                      >单价<input
                        v-model="form.expenseUnitPrice"
                        inputmode="decimal"
                        placeholder="可选"
                    /></label>
                    <label class="wardrobe-expense-extra-wide"
                      >备注<input
                        v-model="form.expenseNote"
                        maxlength="500"
                        placeholder="可选"
                    /></label>
                  </div>
                </details>
                <p v-if="form.expenseReceiptId" class="wardrobe-expense-note">
                  OCR 票据原图会与这笔账单一起关联，默认保持私人可见。
                </p>
                <label
                  v-if="session.family?.status === 'ACTIVE'"
                  class="wardrobe-check wardrobe-expense-family"
                >
                  <input
                    v-model="form.expenseFamilyVisible"
                    type="checkbox"
                  />作为家庭账单，向家庭成员可见
                </label>
              </div>
            </fieldset>
            <label class="wardrobe-wide"
              >备注<textarea
                v-model="form.notes"
                maxlength="500"
                rows="3"
                placeholder="尺码、品牌或洗护说明"
              />
            </label>
          </div>
        </div>
        <footer class="wardrobe-form-actions">
          <button type="button" class="wardrobe-quiet" @click="cancelEdit">
            取消</button
          ><button class="wardrobe-primary" :disabled="saving">
            {{ saving ? "正在保存…" : "保存衣物" }}
          </button>
        </footer>
      </form>
    </template>
    <template v-else-if="selected">
      <article class="wardrobe-detail">
        <button class="wardrobe-back" @click="selected = null">
          ‹ 返回衣柜
        </button>
        <div class="wardrobe-detail-grid">
          <img :src="selected.mainImage.contentUrl" :alt="selected.name" />
          <div class="wardrobe-detail-copy">
            <p class="wardrobe-eyebrow">
              {{ label(selected.category, categories) }} ·
              {{ label(selected.status, statuses) }}
            </p>
            <h2>{{ selected.name }}</h2>
            <p>
              {{ selected.color || "颜色待补充"
              }}<span v-if="selected.acquiredOn">
                · 添置于 {{ selected.acquiredOn }}</span
              >
            </p>
            <dl>
              <dt>适用季节</dt>
              <dd>
                {{
                  selected.seasons.length
                    ? selected.seasons
                        .map((value) => label(value, seasons))
                        .join("、")
                    : "待补充"
                }}
              </dd>
              <dt>适用层次</dt>
              <dd>
                {{
                  selected.layers.length
                    ? selected.layers
                        .map((value) => label(value, layers))
                        .join("、")
                    : "待补充"
                }}
              </dd>
              <dt>适用场景</dt>
              <dd>
                {{
                  selected.scenes.length
                    ? selected.scenes
                        .map((value) => label(value, scenes))
                        .join("、")
                    : "待补充"
                }}
              </dd>
              <dt>穿搭建议</dt>
              <dd>{{ selected.stylingAdvice || "暂无建议" }}</dd>
              <dt>收纳位置</dt>
              <dd>{{ selected.storageLocation || "未填写" }}</dd>
            </dl>
            <p v-if="selected.notes" class="wardrobe-notes">
              {{ selected.notes }}
            </p>
            <div class="wardrobe-detail-actions">
              <button
                v-if="canEditSelected"
                class="wardrobe-primary"
                @click="beginEdit(selected)"
              >
                编辑衣物</button
              ><button
                v-if="canEditSelected && initialExpenseId"
                class="wardrobe-quiet"
                @click="addAnotherToExpense"
              >
                再添加一件到这笔账单</button
              ><button
                v-if="canEditSelected"
                class="wardrobe-danger"
                :disabled="saving"
                @click="removeSelected"
              >
                移除衣物</button
              ><button
                v-if="canEditSelected"
                class="wardrobe-quiet"
                @click="createTaskForGarment(selected)"
              >
                为这件衣物创建待办</button
              ><span v-else class="wardrobe-readonly">家庭共享 · 只读</span>
            </div>
          </div>
        </div>
      </article>
    </template>
    <template v-else>
      <div class="wardrobe-toolbar">
        <label class="wardrobe-search"
          ><AppIcon name="search" :size="17" /><input
            v-model="query"
            placeholder="搜索衣物名称"
            aria-label="搜索衣物名称" /></label
        ><select v-model="categoryFilter" aria-label="按类别筛选">
          <option value="">全部类别</option>
          <option
            v-for="item in categories"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option></select
        ><input
          v-model="colorFilter"
          class="wardrobe-color-filter"
          placeholder="颜色"
          aria-label="按颜色筛选"
        /><select v-model="statusFilter" aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option
            v-for="item in statuses"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option></select
        ><select v-model="seasonFilter" aria-label="按季节筛选">
          <option value="">全部季节</option>
          <option v-for="item in seasons" :key="item.value" :value="item.value">
            {{ item.label }}
          </option></select
        ><span>{{
          loading ? "正在整理…" : `${visibleRows.length} 件衣物`
        }}</span>
      </div>
      <div v-if="loading && !rows.length" class="wardrobe-empty">
        正在打开衣柜…
      </div>
      <div v-else-if="visibleRows.length" class="wardrobe-grid">
        <button
          v-for="item in visibleRows"
          :key="item.id"
          class="wardrobe-card"
          @click="openDetail(item)"
        >
          <span class="wardrobe-card-image"
            ><img
              :src="item.mainImage.thumbnailUrl"
              :alt="item.name"
              loading="lazy" /></span
          ><span class="wardrobe-card-title">{{ item.name }}</span
          ><span class="wardrobe-card-meta"
            >{{ label(item.category, categories) }} ·
            {{ label(item.status, statuses) }}</span
          ><span class="wardrobe-card-seasons">{{
            item.seasons.length
              ? item.seasons.map((value) => label(value, seasons)).join(" / ")
              : "季节待补"
          }}</span>
        </button>
      </div>
      <div v-else class="wardrobe-empty">
        <div class="wardrobe-empty-mark">衣</div>
        <h3>衣柜还空着</h3>
        <p>先添加常穿的几件衣物，季节和层次可以以后再补。</p>
        <button class="wardrobe-primary" @click="beginCreate">
          添加第一件衣物
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.wardrobe-page {
  color: var(--ink);
  padding: 4px 0 48px;
}
.wardrobe-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--line);
  margin: 0 0 20px;
}
.wardrobe-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: 12px 16px;
  color: var(--muted);
  cursor: pointer;
}
.wardrobe-tabs button[aria-current="page"] {
  color: var(--ink);
  border-bottom-color: var(--accent);
}
.wardrobe-outfit-controls {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) minmax(180px, 1fr) minmax(
      280px,
      2.4fr
    ) auto;
  align-items: start;
  gap: 12px;
}
.wardrobe-outfit-controls label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-idea-field {
  min-width: 240px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-outfit-controls .wardrobe-idea-field {
  min-width: 0;
}
.wardrobe-idea-field textarea {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  line-height: 1.5;
  resize: vertical;
}
.wardrobe-outfit-ai-note {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
.wardrobe-outfit-controls > button {
  align-self: end;
}
.wardrobe-outfit-controls select {
  min-width: 190px;
  min-height: 43px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
}
.wardrobe-trip-controls {
  display: grid;
  grid-template-columns:
    minmax(220px, 1.4fr) repeat(3, minmax(140px, 0.8fr))
    auto;
  align-items: end;
  gap: 12px;
}
.wardrobe-trip-controls label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-trip-controls input,
.wardrobe-trip-controls select {
  min-height: 43px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
}
.wardrobe-trip-controls > button.wardrobe-city-result {
  grid-column: 1 / -1;
}
.wardrobe-trip-destination {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ink);
  font-size: 13px;
}
.wardrobe-trip-controls .wardrobe-idea-field {
  grid-column: 1 / 5;
  grid-row: 2;
}
.wardrobe-trip-controls > button.wardrobe-primary {
  grid-column: 5;
  grid-row: 2;
}
.wardrobe-trip-days {
  display: grid;
  gap: 14px;
}
.wardrobe-trip-day {
  border: 1px solid var(--line);
  background: #fff;
  padding: 16px;
}
.wardrobe-trip-day > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.wardrobe-trip-day h3 {
  margin: 4px 0;
  font: 500 21px var(--serif);
}
.wardrobe-outfit-note {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.wardrobe-outfit-reason {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.65;
}
.wardrobe-recommendation-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.wardrobe-recommendation {
  min-width: 0;
  border: 1px solid var(--line);
  background: #fff;
  padding: 16px;
}
.wardrobe-recommendation > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.wardrobe-recommendation h3 {
  margin: 5px 0 12px;
  font: 500 22px var(--serif);
}
.wardrobe-recommendation-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.wardrobe-recommendation-item {
  min-width: 0;
  display: grid;
  gap: 6px;
}
.wardrobe-recommendation-item img {
  width: 100%;
  aspect-ratio: 4 / 5;
  object-fit: cover;
  background: #f2ebe7;
}
.wardrobe-recommendation-item strong,
.wardrobe-recommendation-item small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wardrobe-recommendation-item strong {
  font-size: 13px;
  font-weight: 500;
}
.wardrobe-recommendation-item small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}
.wardrobe-invalid {
  border-color: #dec8c3;
  background: #fcf8f6;
}
.wardrobe-outfit-editor {
  margin-top: 14px;
  border-top: 1px solid var(--line);
  padding-top: 11px;
}
.wardrobe-outfit-editor summary {
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}
.wardrobe-compose-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 12px 0;
}
.wardrobe-compose-options label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-manual-composer {
  margin-bottom: 18px;
  border: 1px solid var(--line);
  background: #fff;
  padding: 14px;
}
.wardrobe-manual-name {
  display: grid;
  max-width: 400px;
  gap: 6px;
  margin-top: 12px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-manual-name input {
  min-height: 40px;
  border: 1px solid var(--line);
  padding: 8px 10px;
}
.wardrobe-expense-extra {
  grid-column: 1 / -1;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.wardrobe-expense-extra summary {
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.wardrobe-expense-extra-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding-top: 10px;
}
.wardrobe-expense-extra-grid label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-expense-extra-grid input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--line);
  min-height: 38px;
  padding: 7px 9px;
}
.wardrobe-expense-extra-wide {
  grid-column: 1 / -1;
}
.wardrobe-weather-panel {
  margin: 0 0 24px;
  padding: 13px 16px;
  border: 1px solid var(--line);
  background: #faf6f2;
}
.wardrobe-weather-primary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 22px;
}
.wardrobe-weather-city {
  display: grid;
  gap: 3px;
  min-width: 150px;
}
.wardrobe-weather-city strong {
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 500;
}
.wardrobe-weather-state {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 13px;
  margin: 0;
  color: var(--ink);
  font-size: 13px;
}
.wardrobe-weather-icon {
  font-size: 24px;
  line-height: 1;
}
.wardrobe-weather-condition {
  font-weight: 600;
}
.wardrobe-weather-metric {
  color: var(--muted);
  white-space: nowrap;
}
.wardrobe-weather-muted {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.wardrobe-weather-actions {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-left: auto;
}
.wardrobe-weather-refresh {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wardrobe-weather-refresh span {
  margin-right: 4px;
  font-size: 16px;
}
.wardrobe-weather-refresh:disabled {
  cursor: wait;
  opacity: 0.55;
}
.wardrobe-weather-settings summary {
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.wardrobe-weather-settings[open] {
  flex-basis: 100%;
}
.wardrobe-city-picker {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  max-width: 520px;
  padding-top: 10px;
}
.wardrobe-city-picker label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.wardrobe-city-picker input {
  min-height: 38px;
  border: 1px solid var(--line);
  background: #fff;
  padding: 8px 10px;
}
.wardrobe-city-result {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.wardrobe-city-result small,
.wardrobe-weather-attribution {
  color: var(--muted);
  font-size: 10px;
}
.wardrobe-weather-error {
  margin: 2px 0;
  color: #8b3434;
  font-size: 12px;
}
.wardrobe-weather-success {
  margin: 2px 0;
  color: #426a4b;
  font-size: 12px;
}
.wardrobe-weather-attribution {
  display: block;
  margin-top: 7px;
}
.wardrobe-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin: 4px 0 28px;
}
.wardrobe-heading h2,
.wardrobe-form h2,
.wardrobe-detail h2 {
  font-family: var(--serif);
  font-weight: 500;
  font-size: clamp(25px, 3vw, 38px);
  letter-spacing: -0.04em;
  margin: 6px 0 8px;
}
.wardrobe-heading p:not(.wardrobe-eyebrow) {
  color: var(--muted);
  margin: 0;
}
.wardrobe-eyebrow {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: #9a6b78;
  font-weight: 700;
  margin: 0;
}
.wardrobe-primary,
.wardrobe-quiet,
.wardrobe-danger,
.wardrobe-back {
  min-height: 43px;
  padding: 0 17px;
  border: 1px solid transparent;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
}
.wardrobe-primary {
  background: var(--accent);
  color: #fff;
}
.wardrobe-quiet,
.wardrobe-back {
  background: transparent;
  color: var(--ink);
  border-color: var(--line);
}
.wardrobe-quiet:disabled {
  opacity: 0.7;
  cursor: wait;
}
.wardrobe-recognition-spinner {
  width: 15px;
  height: 15px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: wardrobe-recognition-spin 0.7s linear infinite;
}
@keyframes wardrobe-recognition-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .wardrobe-recognition-spinner {
    animation-duration: 1.6s;
  }
}
.wardrobe-danger {
  background: #fff6f5;
  color: #9d3c39;
  border-color: #ead5d2;
}
.wardrobe-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 19px;
}
.wardrobe-toolbar > span {
  margin-left: auto;
  color: var(--muted);
  font-size: 13px;
}
.wardrobe-search {
  height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid var(--line);
  padding: 0 12px;
  flex: 1;
  max-width: 440px;
}
.wardrobe-search input {
  border: 0 !important;
  outline: 0 !important;
  box-shadow: none !important;
  width: 100%;
  min-width: 0;
}
.wardrobe-toolbar select,
.wardrobe-color-filter,
.wardrobe-fields input,
.wardrobe-fields select,
.wardrobe-fields textarea {
  border: 1px solid var(--line);
  background: #fff;
  padding: 10px 12px;
  min-height: 42px;
  color: var(--ink);
}
.wardrobe-toolbar select {
  min-width: 112px;
}
.wardrobe-color-filter {
  width: 100px;
}
.wardrobe-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 17px;
}
.wardrobe-card {
  text-align: left;
  border: 1px solid var(--line);
  padding: 0 0 14px;
  background: #fff;
  color: var(--ink);
  cursor: pointer;
  min-width: 0;
}
.wardrobe-card-image {
  display: block;
  position: relative;
  aspect-ratio: 4/5;
  background: #f2ebe7;
  overflow: hidden;
}
.wardrobe-card-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.wardrobe-card-image i {
  position: absolute;
  top: 10px;
  right: 10px;
  font-style: normal;
  background: #fff;
  color: var(--ink);
  padding: 4px 8px;
  font-size: 11px;
}
.wardrobe-card-title,
.wardrobe-card-meta,
.wardrobe-card-seasons {
  display: block;
  padding: 0 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wardrobe-card-title {
  font-family: var(--serif);
  font-size: 18px;
  margin-top: 12px;
}
.wardrobe-card-meta,
.wardrobe-card-seasons {
  font-size: 12px;
  color: var(--muted);
  margin-top: 5px;
}
.wardrobe-card-seasons {
  color: #9a6b78;
}
.wardrobe-empty {
  min-height: 300px;
  display: grid;
  align-content: center;
  justify-items: center;
  text-align: center;
  border: 1px dashed #d6c7c2;
  background: rgba(255, 255, 255, 0.4);
  padding: 28px;
}
.wardrobe-empty-mark {
  width: 52px;
  height: 52px;
  background: #f4e9eb;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--accent);
  font-family: var(--serif);
  font-size: 24px;
}
.wardrobe-empty h3 {
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 500;
  margin: 15px 0 0;
}
.wardrobe-empty p {
  color: var(--muted);
  font-size: 14px;
  margin: 8px 0 18px;
}
.wardrobe-form,
.wardrobe-detail {
  background: #fff;
  border: 1px solid var(--line);
  padding: 25px;
}
.wardrobe-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}
.wardrobe-form-grid {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: 26px;
}
.wardrobe-photo-field p {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.wardrobe-photo-drop,
.wardrobe-photo-preview {
  width: 100%;
  aspect-ratio: 4/5;
  border: 1px dashed #cdbab5;
  background: #faf6f2;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  color: var(--ink);
  cursor: pointer;
  position: relative;
  overflow: hidden;
}
.wardrobe-photo-drop strong {
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 500;
}
.wardrobe-photo-drop small,
.wardrobe-photo-field p {
  color: var(--muted);
}
.wardrobe-photo-preview {
  border-style: solid;
  padding: 0;
}
.wardrobe-photo-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.wardrobe-photo-preview span {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: #fff;
  padding: 6px 9px;
  font-size: 12px;
}
.wardrobe-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  clip: rect(0 0 0 0);
  overflow: hidden;
}
.wardrobe-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
  align-content: start;
}
.wardrobe-expense-fields {
  grid-column: 1 / -1;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
}
.wardrobe-expense-note {
  margin: 0.75rem 0 0;
  color: var(--muted);
  font-size: 0.88rem;
}
.wardrobe-expense-family {
  grid-column: 1 / -1;
}
.wardrobe-fields > label {
  display: grid;
  gap: 7px;
  font-size: 13px;
  color: var(--muted);
}
.wardrobe-fields fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.wardrobe-fields legend {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 8px;
}
.wardrobe-options {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.wardrobe-check {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 13px;
  background: #fff;
}
.wardrobe-check input {
  width: 16px;
  min-width: 16px;
  min-height: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  flex: 0 0 auto;
  margin: 0;
}
.wardrobe-expense-select {
  display: grid;
  gap: 7px;
  color: var(--muted);
  font-size: 13px;
}
.wardrobe-expense-select input,
.wardrobe-expense-select select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--line);
  background: #fff;
  padding: 10px 12px;
  min-height: 42px;
  color: var(--ink);
}
.wardrobe-wide {
  grid-column: 1/-1;
}
.wardrobe-form-actions {
  display: flex;
  justify-content: end;
  gap: 9px;
  margin-top: 22px;
  padding-top: 17px;
  border-top: 1px solid #eee7e3;
}
.wardrobe-back {
  padding: 0 10px;
  margin-bottom: 20px;
  border: 0;
}
.wardrobe-detail-grid {
  display: grid;
  grid-template-columns: minmax(260px, 420px) minmax(0, 1fr);
  gap: 35px;
}
.wardrobe-detail-grid > img {
  width: 100%;
  max-height: 620px;
  object-fit: cover;
  background: #f2ebe7;
}
.wardrobe-detail-copy {
  padding: 14px 0;
}
.wardrobe-detail-copy > p:not(.wardrobe-eyebrow) {
  color: var(--muted);
}
.wardrobe-detail-copy dl {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 12px;
  margin-top: 27px;
  font-size: 14px;
}
.wardrobe-detail-copy dt {
  color: var(--muted);
}
.wardrobe-detail-copy dd {
  margin: 0;
}
.wardrobe-notes {
  white-space: pre-wrap;
  line-height: 1.7;
  color: var(--muted);
}
.wardrobe-detail-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 26px;
}
.wardrobe-readonly {
  color: var(--muted);
  font-size: 13px;
}
.inline-error {
  margin-bottom: 16px;
}
@media (max-width: 900px) {
  .wardrobe-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .wardrobe-outfit-controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .wardrobe-outfit-controls .wardrobe-idea-field,
  .wardrobe-outfit-ai-note {
    grid-column: 1 / -1;
  }
  .wardrobe-form-grid {
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 18px;
  }
  .wardrobe-fields {
    gap: 12px;
  }
  .wardrobe-detail-grid {
    grid-template-columns: minmax(220px, 360px) minmax(0, 1fr);
    gap: 24px;
  }
}
@media (max-width: 640px) {
  .wardrobe-tabs {
    margin-right: -8px;
    margin-left: -8px;
  }
  .wardrobe-tabs button {
    flex: 1;
    padding: 11px 5px;
  }
  .wardrobe-outfit-controls,
  .wardrobe-outfit-controls label,
  .wardrobe-outfit-controls select,
  .wardrobe-outfit-controls > button {
    width: 100%;
  }
  .wardrobe-outfit-controls {
    grid-template-columns: 1fr;
  }
  .wardrobe-trip-controls .wardrobe-idea-field,
  .wardrobe-trip-controls > button.wardrobe-primary {
    grid-column: auto;
    grid-row: auto;
  }
  .wardrobe-trip-controls {
    grid-template-columns: 1fr;
  }
  .wardrobe-trip-controls label,
  .wardrobe-trip-controls > button {
    width: 100%;
  }
  .wardrobe-trip-controls > button.wardrobe-city-result,
  .wardrobe-trip-destination {
    grid-column: auto;
  }
  .wardrobe-recommendation-grid {
    grid-template-columns: 1fr;
  }
  .wardrobe-weather-panel {
    padding: 12px;
  }
  .wardrobe-weather-primary {
    align-items: flex-start;
    gap: 10px 14px;
  }
  .wardrobe-weather-city {
    min-width: 0;
    flex: 1 1 100%;
  }
  .wardrobe-weather-actions {
    margin-left: 0;
  }
  .wardrobe-weather-settings[open] {
    flex-basis: 100%;
  }
  .wardrobe-weather-state {
    flex: 1 1 100%;
  }
  .wardrobe-page {
    padding-top: 0;
  }
  .wardrobe-heading {
    align-items: start;
    flex-direction: column;
    margin-bottom: 20px;
  }
  .wardrobe-heading h2 {
    font-size: 27px;
  }
  .wardrobe-heading > button {
    width: 100%;
  }
  .wardrobe-toolbar {
    flex-wrap: wrap;
  }
  .wardrobe-search {
    max-width: none;
    flex-basis: 100%;
  }
  .wardrobe-toolbar select {
    flex: 1;
  }
  .wardrobe-color-filter {
    flex: 1;
    min-width: 100px;
  }
  .wardrobe-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 11px;
  }
  .wardrobe-form,
  .wardrobe-detail {
    padding: 15px;
  }
  .wardrobe-form-head h2 {
    font-size: 26px;
  }
  .wardrobe-form-grid {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .wardrobe-photo-field {
    display: grid;
    grid-template-columns: 112px 1fr;
    align-items: center;
    gap: 13px;
  }
  .wardrobe-photo-drop,
  .wardrobe-photo-preview {
    aspect-ratio: 1;
    width: 112px;
  }
  .wardrobe-photo-drop {
    gap: 5px;
  }
  .wardrobe-photo-drop strong {
    font-size: 14px;
  }
  .wardrobe-photo-drop small {
    font-size: 10px;
  }
  .wardrobe-photo-field p {
    margin: 0;
  }
  .wardrobe-fields {
    grid-template-columns: 1fr;
    gap: 13px;
  }
  .wardrobe-expense-extra-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .wardrobe-wide {
    grid-column: auto;
  }
  .wardrobe-check {
    min-height: 42px;
    padding: 0 11px;
  }
  .wardrobe-form-actions {
    position: sticky;
    bottom: 64px;
    background: #fff;
    margin-left: -15px;
    margin-right: -15px;
    padding: 12px 15px;
    margin-bottom: -15px;
    z-index: 2;
  }
  .wardrobe-form-actions button {
    flex: 1;
  }
  .wardrobe-detail-grid {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .wardrobe-detail-grid > img {
    max-height: none;
    aspect-ratio: 4/5;
  }
  .wardrobe-detail-copy {
    padding: 0;
  }
  .wardrobe-detail-copy h2 {
    font-size: 30px;
  }
  .wardrobe-detail-copy dl {
    grid-template-columns: 85px 1fr;
  }
  .wardrobe-detail-actions {
    flex-wrap: wrap;
  }
  .wardrobe-detail-actions button {
    flex: 1;
  }
}
</style>
