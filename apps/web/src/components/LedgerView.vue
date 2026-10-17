<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ApiClientError, apiRequest, newIdempotencyKey } from "../api/client";
import { useSessionStore } from "../stores/session";
import AppIcon from "./AppIcon.vue";
import SegmentedControl from "./SegmentedControl.vue";

type Category = { id: string; code: string; name: string };
type Refund = {
  id: string;
  amount: string;
  occurredOn: string;
  version: number;
};
type Expense = {
  id: string;
  title: string;
  category: Category;
  occurredOn: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  note: string | null;
  familyId: string | null;
  familyName: string | null;
  payer: { id: string; nickname: string };
  refund: string;
  net: string;
  refunds: Refund[];
  receipts: Array<{
    id: string;
    linkId: string;
    mimeType: string;
    contentUrl: string;
  }>;
  deletedAt: string | null;
  purgeAfter: string | null;
  version: number;
  capabilities: {
    canEdit: boolean;
    canRefund: boolean;
    canDelete: boolean;
    canRestore: boolean;
  };
};
type ReceiptDraft = {
  receiptId: string;
  occurredOn: string | null;
  totalAmount: string | null;
  items: Array<{
    title: string;
    categoryId: string | null;
    categoryCode: string | null;
    amount: string | null;
    quantity: string | null;
    unit: string | null;
    unitPrice: string | null;
    confidence: number;
  }>;
  thingsToVerify: string[];
};

const props = defineProps<{ initialAction?: string; initialReceipt?: File }>();
const session = useSessionStore();
const spaceOptions = computed(() =>
  session.family
    ? [
        { value: "personal", label: "个人" },
        { value: "family", label: "家庭" },
      ]
    : [{ value: "personal", label: "个人" }],
);
const originOptions = [
  { value: "all", label: "全部" },
  { value: "personal", label: "个人费用" },
  { value: "family", label: "家庭费用" },
];
const categories = ref<Category[]>([]);
const expenses = ref<Expense[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const nextCursor = ref<string | null>(null);
const error = ref("");
const notice = ref("");
const origin = ref<"all" | "personal" | "family">("all");
const categoryId = ref("");
const search = ref("");
const deleted = ref(false);
const selected = ref<Expense | null>(null);
const formMode = ref<"create" | "edit" | "refund" | "">("");
const saving = ref(false);
const uploading = ref(false);
const receiptInput = ref<HTMLInputElement | null>(null);
const aiReceiptInput = ref<HTMLInputElement | null>(null);
const recognizing = ref(false);
const receiptDraft = ref<ReceiptDraft | null>(null);
const pendingReceiptId = ref("");
const createIdempotencyKey = ref("");
const refundIdempotencyKey = ref("");
const includeFamily = ref(false);
const form = reactive({
  title: "",
  categoryId: "",
  occurredOn: today(),
  amount: "",
  quantity: "",
  unit: "",
  unitPrice: "",
  note: "",
  refundAmount: "",
});

function changeSpace(value: string) {
  session.setSpace(value as "personal" | "family");
}

function changeOrigin(value: string) {
  origin.value = value as "all" | "personal" | "family";
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const queryString = computed(() => {
  const query = new URLSearchParams({
    space: session.activeSpace,
    origin: origin.value,
    deleted: String(deleted.value),
    limit: "10",
  });
  if (session.activeSpace === "family" && session.family)
    query.set("familyId", session.family.id);
  if (categoryId.value) query.set("categoryId", categoryId.value);
  if (search.value.trim()) query.set("q", search.value.trim());
  return query.toString();
});

const sectionLabel = computed(() =>
  deleted.value ? "已删除记录" : "支出明细",
);

async function load(cursor?: string, append = false) {
  if (append) loadingMore.value = true;
  else {
    loading.value = true;
    nextCursor.value = null;
  }
  error.value = "";
  try {
    if (!categories.value.length)
      categories.value = await apiRequest<Category[]>("/categories");
    const listData = await apiRequest<{
      items: Expense[];
      nextCursor: string | null;
    }>(
      `/expenses?${queryString.value}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expenses.value = append
      ? [...expenses.value, ...listData.items]
      : listData.items;
    nextCursor.value = listData.nextCursor;
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError ? reason.message : "账本暂时无法加载。";
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function loadMore() {
  if (nextCursor.value && !loadingMore.value) void load(nextCursor.value, true);
}

watch(queryString, () => void load());
watch(categories, (nextCategories) => {
  if (formMode.value === "create" && !form.categoryId)
    form.categoryId = nextCategories[0]?.id ?? "";
});
onMounted(() => {
  void load();
  if (props.initialAction === "create") openCreate();
  if (props.initialReceipt) void recognizeReceipt(props.initialReceipt);
});

function openCreate() {
  selected.value = null;
  Object.assign(form, {
    title: "",
    categoryId: categories.value[0]?.id ?? "",
    occurredOn: today(),
    amount: "",
    quantity: "",
    unit: "",
    unitPrice: "",
    note: "",
    refundAmount: "",
  });
  includeFamily.value = session.activeSpace === "family";
  createIdempotencyKey.value = newIdempotencyKey();
  formMode.value = "create";
  error.value = "";
}

function openEdit(item: Expense) {
  selected.value = item;
  Object.assign(form, {
    title: item.title,
    categoryId: item.category.id,
    occurredOn: item.occurredOn,
    amount: item.amount,
    quantity: item.quantity ?? "",
    unit: item.unit ?? "",
    unitPrice: item.unitPrice ?? "",
    note: item.note ?? "",
    refundAmount: "",
  });
  includeFamily.value = Boolean(item.familyId);
  formMode.value = "edit";
  error.value = "";
}

function openRefund(item: Expense) {
  selected.value = item;
  Object.assign(form, {
    title: "",
    categoryId: "",
    occurredOn: today(),
    amount: "",
    quantity: "",
    unit: "",
    unitPrice: "",
    note: "",
    refundAmount: "",
  });
  formMode.value = "refund";
  refundIdempotencyKey.value = newIdempotencyKey();
  error.value = "";
}

function closeForm() {
  if (!saving.value) formMode.value = "";
}

async function submitForm() {
  saving.value = true;
  error.value = "";
  try {
    if (formMode.value === "create") {
      const familyId = includeFamily.value ? session.family?.id : undefined;
      const createdExpense = await apiRequest<Expense>("/expenses", {
        method: "POST",
        headers: { "idempotency-key": createIdempotencyKey.value },
        body: JSON.stringify({
          title: form.title,
          categoryId: form.categoryId,
          occurredOn: form.occurredOn,
          amount: form.amount,
          ...(form.quantity
            ? { quantity: form.quantity, unit: form.unit }
            : {}),
          ...(form.unitPrice ? { unitPrice: form.unitPrice } : {}),
          ...(form.note ? { note: form.note } : {}),
          ...(familyId ? { familyId, confirmFamilyVisible: true } : {}),
        }),
      });
      notice.value = "这笔支出已记下。";
      if (pendingReceiptId.value) {
        const confirmFamilyVisible =
          Boolean(createdExpense.familyId) &&
          window.confirm(
            "是否将票据原图分享给当前家庭成员？票据图片可能包含额外个人信息。",
          );
        try {
          await apiRequest(`/expenses/${createdExpense.id}/receipt-links`, {
            method: "POST",
            body: JSON.stringify({
              receiptId: pendingReceiptId.value,
              confirmFamilyVisible,
            }),
          });
          notice.value += confirmFamilyVisible
            ? "票据已关联并授权家庭成员查看。"
            : "票据已关联，原图仍仅你可见。";
        } catch {
          notice.value += " 票据已保留，但未能关联；可稍后从记录详情添加。";
        }
        pendingReceiptId.value = "";
      }
    } else if (formMode.value === "edit" && selected.value) {
      const item = selected.value;
      await apiRequest<Expense>(`/expenses/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: item.version,
          title: form.title,
          categoryId: form.categoryId,
          occurredOn: form.occurredOn,
          amount: form.amount,
          quantity: form.quantity || null,
          unit: form.unit || null,
          unitPrice: form.unitPrice || null,
          note: form.note || null,
        }),
      });
      notice.value = "支出已更新。";
    } else if (formMode.value === "refund" && selected.value) {
      await apiRequest(`/expenses/${selected.value.id}/refunds`, {
        method: "POST",
        headers: { "idempotency-key": refundIdempotencyKey.value },
        body: JSON.stringify({
          amount: form.refundAmount,
          occurredOn: form.occurredOn,
        }),
      });
      notice.value = "退款已关联到原支出。";
    }
    formMode.value = "";
    await load();
    if (selected.value) await openDetails(selected.value.id);
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError
        ? reason.message
        : "保存失败，请检查网络后重试。";
  } finally {
    saving.value = false;
  }
}

async function openDetails(id: string) {
  try {
    selected.value = await apiRequest<Expense>(`/expenses/${id}`);
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError ? reason.message : "无法读取这笔记录。";
  }
}

async function removeExpense(item: Expense) {
  if (!window.confirm(`将“${item.title}”和它关联的退款移入回收站？`)) return;
  try {
    await apiRequest(`/expenses/${item.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: item.version }),
    });
    selected.value = null;
    notice.value = "记录已移入回收站，可在 30 天内恢复。";
    await load();
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError ? reason.message : "删除失败。";
  }
}

async function restoreExpense(item: Expense) {
  try {
    await apiRequest(`/expenses/${item.id}/restore`, {
      method: "POST",
      body: JSON.stringify({ version: item.version }),
    });
    selected.value = null;
    notice.value = "记录已恢复。";
    await load();
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError ? reason.message : "恢复失败。";
  }
}

async function uploadReceipt(file: File | undefined) {
  if (!file || !selected.value) return;
  const expense = selected.value;
  const confirmFamilyVisible = expense.familyId
    ? window.confirm(
        "是否将票据原图分享给当前家庭成员？票据图片可能包含额外个人信息。",
      )
    : false;
  uploading.value = true;
  error.value = "";
  try {
    const body = new FormData();
    body.set("file", file);
    const receipt = await apiRequest<{ id: string }>("/receipts/uploads", {
      method: "POST",
      body,
    });
    await apiRequest(`/expenses/${expense.id}/receipt-links`, {
      method: "POST",
      body: JSON.stringify({ receiptId: receipt.id, confirmFamilyVisible }),
    });
    await openDetails(expense.id);
    notice.value = "票据已安全保存并关联到这笔支出。";
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError
        ? reason.message
        : "票据上传失败，请稍后重试。";
  } finally {
    uploading.value = false;
    if (receiptInput.value) receiptInput.value.value = "";
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function recognizeReceipt(file: File | undefined) {
  if (!file) return;
  recognizing.value = true;
  error.value = "";
  notice.value =
    "票据原图会保持私有；只有点击识别后才会发送给已配置的 AI 服务。";
  receiptDraft.value = null;
  try {
    const availability = await apiRequest<{ enabled: boolean }>("/ai/status");
    if (!availability.enabled) throw new Error("AI_NOT_CONFIGURED");
    const body = new FormData();
    body.set("file", file);
    const receipt = await apiRequest<{ id: string }>("/receipts/uploads", {
      method: "POST",
      body,
    });
    const idempotencyKey = newIdempotencyKey();
    const run = await apiRequest<{ id: string }>("/ai/receipt-extractions", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ receiptId: receipt.id }),
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(1500);
      const current = await apiRequest<{
        status: string;
        errorCode: string | null;
        result: ReceiptDraft;
      }>(`/ai/runs/${run.id}`);
      if (current.status === "SUCCEEDED" && current.result) {
        receiptDraft.value = current.result;
        if (!current.result.items.length) {
          notice.value = "没有识别出清晰的消费条目，请尝试更清楚的票据照片。";
        } else {
          notice.value = "识别结果仅为待核对草稿，确认保存后才会记入账本。";
        }
        return;
      }
      if (["FAILED", "CANCELLED"].includes(current.status)) {
        throw new Error(current.errorCode ?? "AI_RUN_FAILED");
      }
    }
    throw new Error("AI_TIMEOUT");
  } catch (reason) {
    const code =
      reason instanceof ApiClientError
        ? reason.code
        : reason instanceof Error
          ? reason.message
          : "";
    error.value =
      code === "AI_NOT_CONFIGURED"
        ? "AI 服务尚未配置，当前无法识别票据，可先手动记账。"
        : code === "AI_QUOTA_EXCEEDED"
          ? "今天的票据识别次数已用完。"
          : code === "PROVIDER_UNAVAILABLE"
            ? "AI 服务暂时不可用，请稍后再试。"
            : "识别暂未完成，请核对网络后重试。";
  } finally {
    recognizing.value = false;
    if (aiReceiptInput.value) aiReceiptInput.value.value = "";
  }
}

function useReceiptDraft(
  item: NonNullable<typeof receiptDraft.value>["items"][number],
) {
  openCreate();
  form.title = item.title;
  form.categoryId = item.categoryId ?? categories.value[0]?.id ?? "";
  form.occurredOn = receiptDraft.value?.occurredOn ?? today();
  form.amount = item.amount ?? "";
  form.quantity = item.quantity ?? "";
  form.unit = item.unit ?? "";
  form.unitPrice = item.unitPrice ?? "";
  pendingReceiptId.value = receiptDraft.value?.receiptId ?? "";
  receiptDraft.value = null;
}

function money(value: string) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function displayDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${month}月${day}日`;
}
</script>

<template>
  <section class="ledger-page" aria-label="账本">
    <div class="ledger-toolbar">
      <div class="ledger-space-tabs">
        <SegmentedControl
          :model-value="session.activeSpace"
          :options="spaceOptions"
          ariaLabel="账本空间"
          size="compact"
          @update:model-value="changeSpace"
        />
        <span class="ledger-period"
          >{{ new Date().getFullYear() }}年{{
            new Date().getMonth() + 1
          }}月</span
        >
      </div>
      <div class="ledger-actions">
        <button
          class="quiet-button"
          :disabled="recognizing"
          @click="aiReceiptInput?.click()"
        >
          <AppIcon name="camera" :size="18" />
          <span>{{ recognizing ? "正在识别…" : "拍票据识别" }}</span>
        </button>
        <button type="button" class="primary-button" @click="openCreate">
          ＋ 记一笔
        </button>
      </div>
    </div>
    <section v-if="receiptDraft" class="receipt-draft-panel">
      <header>
        <div>
          <span class="eyebrow">识别草稿 · 请核对后保存</span>
          <h3>识别到 {{ receiptDraft.items.length }} 项消费</h3>
          <p>
            票据合计
            {{
              receiptDraft.totalAmount
                ? `¥${money(receiptDraft.totalAmount)}`
                : "未识别"
            }}
            · 识别日期 {{ receiptDraft.occurredOn ?? "未识别" }}
          </p>
        </div>
        <button class="text-button" @click="receiptDraft = null">关闭</button>
      </header>
      <p v-if="receiptDraft.thingsToVerify.length" class="receipt-draft-note">
        请留意：{{ receiptDraft.thingsToVerify.join("；") }}
      </p>
      <div class="receipt-draft-items">
        <article v-for="(item, index) in receiptDraft.items" :key="index">
          <div>
            <strong>{{ item.title }}</strong>
            <small>
              {{ item.categoryCode ?? "待选分类" }} ·
              {{ item.amount ? `¥${money(item.amount)}` : "金额待补" }} · 置信度
              {{ Math.round(item.confidence * 100) }}%
            </small>
          </div>
          <button class="quiet-button" @click="useReceiptDraft(item)">
            核对并记账
          </button>
        </article>
      </div>
    </section>
    <div class="ledger-filter-row">
      <SegmentedControl
        v-if="session.activeSpace === 'personal'"
        :model-value="origin"
        :options="originOptions"
        ariaLabel="归属筛选"
        size="compact"
        class="ledger-origin"
        @update:model-value="changeOrigin"
      />
      <label class="ledger-search"
        ><span class="sr-only">搜索名称或备注</span
        ><input v-model="search" placeholder="搜索名称或备注"
      /></label>
      <label class="ledger-category"
        ><span class="sr-only">费用分类</span
        ><select v-model="categoryId">
          <option value="">全部分类</option>
          <option
            v-for="category in categories"
            :key="category.id"
            :value="category.id"
          >
            {{ category.name }}
          </option>
        </select></label
      >
      <button
        class="ledger-trash-toggle"
        :class="{ selected: deleted }"
        @click="deleted = !deleted"
      >
        {{ deleted ? "返回账本" : "已删除记录" }}
      </button>
    </div>
    <p v-if="notice" class="ledger-notice" role="status">
      {{ notice }} <button aria-label="关闭提示" @click="notice = ''">×</button>
    </p>
    <p v-if="error" class="ledger-error" role="alert">{{ error }}</p>
    <div class="ledger-paper">
      <div class="ledger-paper-heading">
        <strong
          >{{ sectionLabel
          }}<small v-if="!loading">
            ·
            {{
              nextCursor
                ? `已加载 ${expenses.length} 笔`
                : `${expenses.length} 笔`
            }}</small
          ></strong
        ><span>人民币 / CNY</span>
      </div>
      <div v-if="loading" class="ledger-empty">正在读取账本…</div>
      <div v-else-if="!expenses.length" class="ledger-empty">
        {{
          deleted ? "回收站暂时为空。" : "这里还没有记录，从一笔日常开支开始。"
        }}
      </div>
      <button
        v-for="item in expenses"
        :key="item.id"
        class="ledger-row"
        @click="openDetails(item.id)"
      >
        <span class="ledger-row-mark"
          ><AppIcon name="ledger" :size="18"
        /></span>
        <span class="ledger-row-title"
          ><strong>{{ item.title }}</strong
          ><small
            >{{ displayDate(item.occurredOn) }} ·
            {{ item.familyId ? "家庭费用" : "个人费用"
            }}<template v-if="item.deletedAt">
              ·
              {{ new Date(item.purgeAfter ?? "").toLocaleDateString("zh-CN") }}
              前可恢复</template
            ></small
          ></span
        >
        <span class="ledger-row-category">{{ item.category.name }}</span>
        <span class="ledger-row-payer">{{ item.payer.nickname }}</span>
        <span
          class="ledger-row-amount"
          :class="{ refunded: Number(item.refund) > 0 }"
          >¥{{ money(item.net)
          }}<small v-if="Number(item.refund) > 0"
            >支出 ¥{{ money(item.amount) }} · 退 ¥{{
              money(item.refund)
            }}</small
          ></span
        >
        <span class="ledger-row-detail">{{ deleted ? "恢复" : "详情" }} ›</span>
      </button>
      <button
        v-if="nextCursor && !loading"
        class="quiet-button ledger-load-more"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? "正在加载…" : "加载更多记录" }}
      </button>
    </div>
    <Transition name="modal"
      ><div
        v-if="selected && !formMode"
        class="ledger-overlay"
        v-dialog
        @click.self="selected = null"
        @keydown.esc="selected = null"
      >
        <section
          class="ledger-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`${selected.title}详情`"
        >
          <header>
            <div>
              <span class="eyebrow"
                >{{ selected.familyId ? "家庭支出" : "个人支出" }} ·
                {{ selected.category.name }}</span
              >
              <h2>{{ selected.title }}</h2>
            </div>
            <button
              class="ledger-close"
              aria-label="关闭"
              @click="selected = null"
            >
              ×
            </button>
          </header>
          <div class="expense-detail-total">
            <span>净支出</span><strong>¥{{ money(selected.net) }}</strong
            ><small
              >支出 ¥{{ money(selected.amount) }}　·　已退 ¥{{
                money(selected.refund)
              }}</small
            >
          </div>
          <dl class="expense-detail-grid">
            <div>
              <dt>记账日期</dt>
              <dd>{{ selected.occurredOn }}</dd>
            </div>
            <div>
              <dt>付款人</dt>
              <dd>{{ selected.payer.nickname }}</dd>
            </div>
            <div>
              <dt>归属</dt>
              <dd>
                {{ selected.familyId ? selected.familyName || "家庭" : "个人" }}
              </dd>
            </div>
            <div v-if="selected.quantity">
              <dt>数量</dt>
              <dd>{{ selected.quantity }} {{ selected.unit }}</dd>
            </div>
            <div v-if="selected.note">
              <dt>备注</dt>
              <dd>{{ selected.note }}</dd>
            </div>
          </dl>
          <div v-if="selected.refunds.length" class="refund-list">
            <h3>退款记录</h3>
            <div v-for="(refund, index) in selected.refunds" :key="refund.id">
              <span>退款 {{ index + 1 }} · {{ refund.occurredOn }}</span
              ><strong>−¥{{ money(refund.amount) }}</strong>
            </div>
          </div>
          <div v-if="selected.receipts.length" class="receipt-preview">
            <h3>票据凭证</h3>
            <a
              v-for="receipt in selected.receipts"
              :key="receipt.id"
              :href="receipt.contentUrl"
              target="_blank"
              rel="noreferrer"
              >查看安全保存的票据 ↗</a
            >
          </div>
          <p v-if="selected.deletedAt" class="ledger-muted">
            此记录已移入回收站。{{
              selected.purgeAfter
                ? `可恢复至 ${new Date(selected.purgeAfter).toLocaleDateString("zh-CN")}`
                : ""
            }}
          </p>
          <footer class="ledger-dialog-actions">
            <template v-if="selected.capabilities.canRestore"
              ><button class="primary-button" @click="restoreExpense(selected)">
                恢复记录
              </button></template
            >
            <template v-else>
              <button
                v-if="selected.capabilities.canEdit"
                class="quiet-button"
                @click="openEdit(selected)"
              >
                编辑
              </button>
              <button
                v-if="selected.capabilities.canRefund"
                class="quiet-button"
                @click="openRefund(selected)"
              >
                登记退款
              </button>
              <button
                v-if="selected.capabilities.canEdit"
                class="quiet-button"
                :disabled="uploading"
                @click="receiptInput?.click()"
              >
                {{ uploading ? "正在上传…" : "添加票据" }}
              </button>
              <button
                v-if="selected.capabilities.canDelete"
                class="danger-button"
                @click="removeExpense(selected)"
              >
                移入回收站
              </button>
            </template>
          </footer>
        </section>
      </div></Transition
    >
    <Transition name="modal"
      ><div
        v-if="formMode"
        class="ledger-overlay"
        v-dialog
        @click.self="closeForm"
        @keydown.esc="closeForm"
      >
        <form class="ledger-dialog ledger-form" @submit.prevent="submitForm">
          <header>
            <div>
              <span class="eyebrow">{{
                formMode === "refund"
                  ? "关联到原支出"
                  : formMode === "edit"
                    ? "更新记录"
                    : "新建支出"
              }}</span>
              <h2>
                {{
                  formMode === "refund"
                    ? selected?.title
                    : formMode === "edit"
                      ? "编辑这笔支出"
                      : "记一笔"
                }}
              </h2>
            </div>
            <button
              type="button"
              class="ledger-close"
              aria-label="关闭"
              @click="closeForm"
            >
              ×
            </button>
          </header>
          <template v-if="formMode === 'refund'"
            ><label
              >退款金额<input
                v-model="form.refundAmount"
                inputmode="decimal"
                type="text"
                required
                placeholder="0.00" /></label
            ><label
              >退款日期<input v-model="form.occurredOn" type="date" required
            /></label>
            <p class="ledger-muted">
              退款将关联到原支出，累计不能超过原支出金额。
            </p></template
          >
          <template v-else>
            <label
              >金额<input
                v-model="form.amount"
                inputmode="decimal"
                type="text"
                required
                placeholder="0.00"
            /></label>
            <div class="ledger-form-grid">
              <label
                >分类<select v-model="form.categoryId" required>
                  <option v-if="!categories.length" value="" disabled>
                    暂无可用分类
                  </option>
                  <option
                    v-for="category in categories"
                    :key="category.id"
                    :value="category.id"
                  >
                    {{ category.name }}
                  </option>
                </select></label
              ><label
                >日期<input v-model="form.occurredOn" type="date" required
              /></label>
            </div>
            <p v-if="!categories.length" class="form-error" role="alert">
              分类数据尚未就绪，暂时无法保存支出。请联系管理员检查分类初始化。
            </p>
            <label
              >名称<input
                v-model.trim="form.title"
                maxlength="120"
                required
                placeholder="例如：晚餐、燃气费"
            /></label>
            <details class="ledger-extra">
              <summary>数量、单价和备注</summary>
              <div class="ledger-form-grid">
                <label
                  >数量<input
                    v-model="form.quantity"
                    inputmode="decimal"
                    type="text"
                    placeholder="可选" /></label
                ><label
                  >单位<input
                    v-model.trim="form.unit"
                    maxlength="24"
                    placeholder="件、千瓦时" /></label
                ><label
                  >单价<input
                    v-model="form.unitPrice"
                    inputmode="decimal"
                    type="text"
                    placeholder="可选"
                /></label>
              </div>
              <label
                >备注<input
                  v-model.trim="form.note"
                  maxlength="500"
                  placeholder="可选"
              /></label>
            </details>
            <label v-if="session.family" class="ledger-visibility"
              ><input
                v-model="includeFamily"
                type="checkbox"
                :disabled="formMode === 'edit'"
              />
              <span
                >记入家庭收支<small>家庭成员可以查看这笔记录</small></span
              ></label
            >
            <p
              v-else-if="formMode === 'edit' && selected?.familyId"
              class="ledger-muted"
            >
              家庭归属在创建时确认，不能通过编辑切换。
            </p>
            <p v-if="includeFamily" class="ledger-visibility-note">
              此支出会显示在家庭空间及家庭报表中。
            </p>
          </template>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <footer class="ledger-dialog-actions">
            <button type="button" class="quiet-button" @click="closeForm">
              取消</button
            ><button
              class="primary-button"
              :disabled="
                saving || (formMode !== 'refund' && !categories.length)
              "
            >
              {{
                saving
                  ? "正在保存…"
                  : !categories.length && formMode !== "refund"
                    ? "分类未就绪"
                    : formMode === "refund"
                      ? "确认退款"
                      : "保存记录"
              }}
            </button>
          </footer>
        </form>
      </div></Transition
    >
    <input
      ref="receiptInput"
      class="sr-only"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      @change="uploadReceipt(($event.target as HTMLInputElement).files?.[0])"
    />
    <input
      ref="aiReceiptInput"
      class="sr-only"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      capture="environment"
      @change="recognizeReceipt(($event.target as HTMLInputElement).files?.[0])"
    />
  </section>
</template>
