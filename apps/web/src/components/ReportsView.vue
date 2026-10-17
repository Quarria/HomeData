<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ApiClientError,
  apiRequest,
  newIdempotencyKey,
  postJson,
} from "../api/client";
import { useSessionStore } from "../stores/session";

type Period = "day" | "month" | "year";
type Basis = "net" | "expense";
type Summary = {
  from: string;
  to: string;
  hasData: boolean;
  scopeLabel: string;
  expense: string;
  refund: string;
  net: string;
  comparison: {
    from: string;
    to: string;
    net: string;
    difference: string;
    percent: number | null;
    hasData: boolean;
  };
};
type Point = {
  period: string;
  expense: string;
  refund: string;
  net: string;
  value: string;
};
type Category = {
  categoryId: string;
  code: string;
  name: string;
  expense: string;
  refund: string;
  net: string;
  value: string;
};
type Member = {
  payer: { id: string; nickname: string };
  expense: string;
  refund: string;
  net: string;
  value: string;
};
type Detail = {
  id: string;
  kind: "expense" | "refund";
  occurredOn: string;
  title: string;
  category: { id: string; name: string };
  payer: { id: string; nickname: string };
  amount: string;
};
type ShareItem = {
  id: string;
  version: number;
  generatedAt: string;
  expiresAt: string;
  from: string;
  to: string;
  period: Period;
  scopeLabel: string;
  hasPasscode: boolean;
  status: "ACTIVE" | "REVOKED" | "INVALIDATED" | "EXPIRED";
};

const session = useSessionStore();
const period = ref<Period>("month");
const basis = ref<Basis>("net");
const origin = ref<"all" | "personal" | "family">("all");
const referenceDate = ref(today());
const periodInput = computed({
  get: () =>
    period.value === "day"
      ? referenceDate.value
      : period.value === "month"
        ? referenceDate.value.slice(0, 7)
        : referenceDate.value.slice(0, 4),
  set: (value: string | number) => {
    const text = String(value);
    referenceDate.value =
      period.value === "day"
        ? text
        : period.value === "month"
          ? `${text}-01`
          : `${text}-01-01`;
  },
});
const periodOptions = [
  ["day", "日"],
  ["month", "月"],
  ["year", "年"],
] as const;
const originOptions = [
  ["all", "全部"],
  ["personal", "个人费用"],
  ["family", "家庭费用"],
] as const;
const summary = ref<Summary | null>(null);
const points = ref<Point[]>([]);
const categories = ref<Category[]>([]);
const members = ref<Member[]>([]);
const details = ref<Detail[]>([]);
const selectedCategoryId = ref("");
const selectedPayerId = ref("");
const nextCursor = ref<number | null>(null);
const loading = ref(false);
const detailsLoading = ref(false);
const error = ref("");
const shareOpen = ref(false);
const shareBusy = ref(false);
const shareError = ref("");
const shareItems = ref<ShareItem[]>([]);
const shareExpiry = ref<1 | 7 | 30>(7);
const sharePasscode = ref("");
const createdShareUrl = ref("");
const copiedShare = ref(false);
const analysisBusy = ref(false);
const analysisError = ref("");
const analysisResult = ref<{
  changes: Array<{ title: string; description: string; evidenceIds: string[] }>;
  evidence: Array<{ id: string; label: string; value: string }>;
  thingsToVerify: string[];
} | null>(null);
let reportRequestId = 0;
let detailRequestId = 0;

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const range = computed(() => {
  const selected = new Date(`${referenceDate.value}T00:00:00`);
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const isCurrentMonth = isCurrentYear && month === new Date().getMonth();
  if (period.value === "day") {
    return { from: referenceDate.value, to: referenceDate.value };
  }
  if (period.value === "month") {
    const endDay = new Date(year, month + 1, 0).getDate();
    return {
      from: isoDate(year, month + 1, 1),
      to: isoDate(
        year,
        month + 1,
        isCurrentMonth ? Math.min(new Date().getDate(), endDay) : endDay,
      ),
    };
  }
  return {
    from: isoDate(year, 1, 1),
    to: isoDate(
      year,
      isCurrentYear ? now.getMonth() + 1 : 12,
      isCurrentYear ? now.getDate() : 31,
    ),
  };
});

const query = computed(() => {
  const params = new URLSearchParams({
    space: session.activeSpace,
    origin: session.activeSpace === "personal" ? origin.value : "all",
    from: range.value.from,
    to: range.value.to,
    period: period.value,
    granularity: period.value === "year" ? "month" : "day",
    basis: basis.value,
  });
  if (session.activeSpace === "family" && session.family)
    params.set("familyId", session.family.id);
  return params;
});

const visiblePoints = computed(() => {
  if (points.value.length <= 14) return points.value;
  const step = Math.ceil(points.value.length / 14);
  return points.value.filter(
    (_, index) => index % step === 0 || index === points.value.length - 1,
  );
});

const chart = computed(() => {
  const values = points.value.map((point) => Number(point.value));
  if (!values.length) return { line: "", zeroY: 180, points: [] as number[] };
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = rawMin === 0 && rawMax === 0 ? -1 : Math.min(0, rawMin);
  const max = rawMin === 0 && rawMax === 0 ? 1 : Math.max(0, rawMax);
  const spread = Math.max(1, max - min);
  const y = (value: number) => 18 + ((max - value) / spread) * 150;
  const coords = visiblePoints.value.map((point, index) => {
    const x =
      visiblePoints.value.length <= 1
        ? 360
        : 42 + (index * 636) / (visiblePoints.value.length - 1);
    return [x, y(Number(point.value))] as const;
  });
  return {
    line: coords.map(([x, pointY]) => `${x},${pointY}`).join(" "),
    zeroY: y(0),
    points: coords.flatMap(([x, pointY]) => [x, pointY]),
  };
});
const selectedCategory = computed(() =>
  categories.value.find((item) => item.categoryId === selectedCategoryId.value),
);
const trendHasData = computed(() =>
  selectedCategory.value
    ? points.value.some(
        (point) => Number(point.expense) !== 0 || Number(point.refund) !== 0,
      )
    : Boolean(summary.value?.hasData),
);
const chartDots = computed(() => {
  const values = chart.value.points;
  return values.flatMap((value, index) =>
    index % 2 === 0 ? [{ x: value, y: values[index + 1] ?? 0 }] : [],
  );
});

const categoryMax = computed(() =>
  Math.max(0, ...categories.value.map((item) => Math.abs(Number(item.value)))),
);

function formatPeriod(value: string) {
  return period.value === "year"
    ? `${Number(value.slice(5, 7))}月`
    : `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

function formatMoney(value: string) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function movePeriod(step: number) {
  const date = new Date(`${referenceDate.value}T00:00:00`);
  if (period.value === "day") date.setDate(date.getDate() + step);
  else if (period.value === "month") date.setMonth(date.getMonth() + step, 1);
  else date.setFullYear(date.getFullYear() + step, 0, 1);
  referenceDate.value = isoDate(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
  );
}

async function load() {
  const requestId = ++reportRequestId;
  loading.value = true;
  error.value = "";
  try {
    const params = query.value.toString();
    const trendParams = new URLSearchParams(params);
    if (selectedCategoryId.value)
      trendParams.set("categoryId", selectedCategoryId.value);
    const [nextSummary, nextTrend, nextCategories] = await Promise.all([
      apiRequest<Summary>(`/reports/summary?${params}`),
      apiRequest<{ points: Point[] }>(`/reports/trend?${trendParams}`),
      apiRequest<Category[]>(`/reports/categories?${params}`),
    ]);
    const nextMembers =
      session.activeSpace === "family"
        ? await apiRequest<Member[]>(`/reports/members?${params}`)
        : [];
    if (requestId !== reportRequestId) return;
    summary.value = nextSummary;
    points.value = nextTrend.points;
    categories.value = nextCategories;
    members.value = nextMembers;
    await loadDetails(0, false, new URLSearchParams(params));
  } catch (reason) {
    if (requestId !== reportRequestId) return;
    error.value =
      reason instanceof ApiClientError
        ? reason.message
        : "报表暂时无法加载，请稍后重试。";
  } finally {
    if (requestId === reportRequestId) loading.value = false;
  }
}

async function loadDetails(
  cursor: number,
  append: boolean,
  params = new URLSearchParams(query.value),
) {
  const requestId = ++detailRequestId;
  error.value = "";
  detailsLoading.value = true;
  params.set("cursor", String(cursor));
  params.set("limit", "30");
  if (selectedCategoryId.value)
    params.set("categoryId", selectedCategoryId.value);
  if (selectedPayerId.value) params.set("payerId", selectedPayerId.value);
  try {
    const page = await apiRequest<{
      items: Detail[];
      nextCursor: number | null;
    }>(`/reports/details?${params}`);
    if (requestId !== detailRequestId) return;
    details.value = append ? [...details.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
  } catch (reason) {
    if (requestId === detailRequestId) {
      error.value =
        reason instanceof ApiClientError
          ? reason.message
          : "明细暂时无法加载，请稍后重试。";
    }
  } finally {
    if (requestId === detailRequestId) detailsLoading.value = false;
  }
}

async function openShares() {
  shareOpen.value = !shareOpen.value;
  if (!shareOpen.value) return;
  shareError.value = "";
  try {
    shareItems.value = await apiRequest<ShareItem[]>("/shares");
  } catch (reason) {
    shareError.value =
      reason instanceof ApiClientError
        ? reason.message
        : "分享列表暂时无法读取。";
  }
}

async function createShare() {
  shareBusy.value = true;
  shareError.value = "";
  createdShareUrl.value = "";
  copiedShare.value = false;
  try {
    const created = await postJson<{ path: string }>("/shares", {
      space: session.activeSpace,
      ...(session.activeSpace === "family" && session.family
        ? { familyId: session.family.id }
        : {}),
      origin: session.activeSpace === "personal" ? origin.value : "all",
      from: range.value.from,
      to: range.value.to,
      period: period.value,
      expiresInDays: shareExpiry.value,
      ...(sharePasscode.value ? { passcode: sharePasscode.value } : {}),
    });
    createdShareUrl.value = `${window.location.origin}${created.path}`;
    sharePasscode.value = "";
    shareItems.value = await apiRequest<ShareItem[]>("/shares");
  } catch (reason) {
    shareError.value =
      reason instanceof ApiClientError
        ? reason.message
        : "分享链接创建失败，请稍后重试。";
  } finally {
    shareBusy.value = false;
  }
}

async function copyShareLink() {
  if (!createdShareUrl.value) return;
  try {
    await navigator.clipboard.writeText(createdShareUrl.value);
    copiedShare.value = true;
  } catch {
    shareError.value = "浏览器未允许复制，请手动复制下方链接。";
  }
}

async function revokeShare(item: ShareItem) {
  shareError.value = "";
  try {
    await postJson(`/shares/${item.id}/revoke`, { version: item.version });
    shareItems.value = await apiRequest<ShareItem[]>("/shares");
  } catch (reason) {
    shareError.value =
      reason instanceof ApiClientError
        ? reason.message
        : "撤销失败，请刷新后重试。";
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function generateAnalysis() {
  analysisBusy.value = true;
  analysisError.value = "";
  analysisResult.value = null;
  try {
    const run = await apiRequest<{
      id: string | null;
      status: string;
      result?: typeof analysisResult.value;
    }>("/ai/analyses", {
      method: "POST",
      headers: { "idempotency-key": newIdempotencyKey() },
      body: JSON.stringify({
        ...Object.fromEntries(query.value),
        basis: "net",
      }),
    });
    if (!run.id && run.result) {
      analysisResult.value = run.result;
      return;
    }
    if (!run.id) throw new Error("AI_RUN_INVALID");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(1500);
      const current = await apiRequest<{
        status: string;
        errorCode: string | null;
        result: typeof analysisResult.value;
      }>(`/ai/runs/${run.id}`);
      if (current.status === "SUCCEEDED" && current.result) {
        analysisResult.value = current.result;
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
    analysisError.value =
      code === "AI_NOT_CONFIGURED"
        ? "AI 服务尚未配置。"
        : code === "AI_QUOTA_EXCEEDED"
          ? "今天的收支分析次数已用完。"
          : code === "PROVIDER_UNAVAILABLE"
            ? "AI 服务暂时不可用，请稍后重试。"
            : "分析未能完成，请稍后重试。";
  } finally {
    analysisBusy.value = false;
  }
}

function selectCategory(id: string) {
  selectedCategoryId.value = selectedCategoryId.value === id ? "" : id;
  selectedPayerId.value = "";
}

function selectPayer(id: string) {
  selectedPayerId.value = selectedPayerId.value === id ? "" : id;
  selectedCategoryId.value = "";
}

watch([query, selectedCategoryId, selectedPayerId], () => void load());
onMounted(() => void load());
</script>

<template>
  <section class="reports-page">
    <div class="reports-heading">
      <div>
        <h2>支出报表</h2>
        <p>按日、月、年查看支出，发现每一种消费的变化。</p>
      </div>
      <div class="reports-heading-actions">
        <p v-if="summary" class="reports-scope-note">
          {{ summary.scopeLabel }}
        </p>
        <button class="quiet-button" @click="openShares">
          {{ shareOpen ? "收起分享" : "分享汇总" }}
        </button>
        <button
          class="primary-button"
          :disabled="analysisBusy"
          @click="generateAnalysis"
        >
          {{ analysisBusy ? "正在分析…" : "生成收支分析" }}
        </button>
      </div>
    </div>

    <section v-if="shareOpen" class="report-panel share-panel">
      <header class="report-panel-heading">
        <div>
          <h3>分享当前汇总</h3>
          <small>访客只能查看静态汇总，不包含逐笔明细与成员姓名。</small>
        </div>
      </header>
      <div class="share-create-form">
        <label>
          有效期
          <select v-model.number="shareExpiry">
            <option :value="1">1 天</option>
            <option :value="7">7 天</option>
            <option :value="30">30 天</option>
          </select>
        </label>
        <label>
          访问口令（可选）
          <input
            v-model="sharePasscode"
            type="password"
            minlength="6"
            maxlength="64"
            autocomplete="new-password"
            placeholder="至少 6 位"
          />
        </label>
        <button
          class="primary-button"
          :disabled="shareBusy"
          @click="createShare"
        >
          {{ shareBusy ? "正在创建…" : "生成分享链接" }}
        </button>
      </div>
      <div v-if="createdShareUrl" class="share-created">
        <span>链接只在创建时显示，请及时保存。</span>
        <input :value="createdShareUrl" readonly aria-label="分享链接" />
        <button class="quiet-button" @click="copyShareLink">
          {{ copiedShare ? "已复制" : "复制链接" }}
        </button>
      </div>
      <p v-if="shareError" class="notice error-notice" role="alert">
        {{ shareError }}
      </p>
      <div v-if="shareItems.length" class="share-list">
        <div v-for="item in shareItems" :key="item.id" class="share-list-row">
          <div>
            <strong
              >{{ item.scopeLabel }} · {{ item.from }} 至 {{ item.to }}</strong
            >
            <small>
              {{ item.hasPasscode ? "口令保护" : "无口令" }} ·
              {{ new Date(item.expiresAt).toLocaleDateString("zh-CN") }} 到期
            </small>
          </div>
          <div class="share-row-actions">
            <span :class="['share-status', item.status.toLowerCase()]">
              {{
                item.status === "ACTIVE"
                  ? "可访问"
                  : item.status === "REVOKED"
                    ? "已撤销"
                    : item.status === "EXPIRED"
                      ? "已过期"
                      : "已失效"
              }}
            </span>
            <button
              v-if="item.status === 'ACTIVE'"
              class="text-button danger-text"
              @click="revokeShare(item)"
            >
              撤销
            </button>
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="analysisResult || analysisError"
      class="report-panel analysis-panel"
    >
      <header class="report-panel-heading">
        <div>
          <h3>AI 收支分析</h3>
          <small>仅基于当前汇总范围生成，不会修改账目。</small>
        </div>
        <button
          class="text-button"
          @click="
            analysisResult = null;
            analysisError = '';
          "
        >
          关闭
        </button>
      </header>
      <p v-if="analysisError" class="notice error-notice" role="alert">
        {{ analysisError }}
      </p>
      <template v-else-if="analysisResult">
        <article
          v-for="(change, index) in analysisResult.changes"
          :key="index"
          class="analysis-change"
        >
          <strong>{{ change.title }}</strong>
          <p>{{ change.description }}</p>
          <small v-if="change.evidenceIds.length">
            依据：{{
              change.evidenceIds
                .map(
                  (id) =>
                    analysisResult?.evidence.find((item) => item.id === id)
                      ?.label,
                )
                .filter(Boolean)
                .join("、")
            }}
          </small>
        </article>
        <div
          v-if="analysisResult.evidence.length"
          class="analysis-evidence-list"
        >
          <span v-for="item in analysisResult.evidence" :key="item.id">
            {{ item.label }} <strong>¥{{ formatMoney(item.value) }}</strong>
          </span>
        </div>
        <p
          v-for="(item, index) in analysisResult.thingsToVerify"
          :key="`verify-${index}`"
          class="analysis-verify"
        >
          待核对：{{ item }}
        </p>
      </template>
    </section>

    <div class="reports-toolbar">
      <div class="reports-period-row">
        <div class="report-tabs" role="tablist" aria-label="统计周期">
          <button
            v-for="option in periodOptions"
            :key="option[0]"
            :class="{ selected: period === option[0] }"
            role="tab"
            :aria-selected="period === option[0]"
            @click="period = option[0]"
          >
            {{ option[1] }}
          </button>
        </div>
        <button class="quiet-button report-period-nav" @click="movePeriod(-1)">
          ‹
        </button>
        <input
          v-model="periodInput"
          :type="
            period === 'day' ? 'date' : period === 'month' ? 'month' : 'number'
          "
          :min="period === 'year' ? '2000' : undefined"
          :max="
            period === 'year' ? String(new Date().getFullYear()) : undefined
          "
          :aria-label="`选择${period === 'day' ? '日期' : period === 'month' ? '月份' : '年份'}`"
          class="report-date-input"
        />
        <button class="quiet-button report-period-nav" @click="movePeriod(1)">
          ›
        </button>
      </div>
      <div class="reports-toolbar-end">
        <div
          v-if="session.activeSpace === 'personal'"
          class="report-tabs"
          role="group"
          aria-label="费用归属"
        >
          <button
            v-for="option in originOptions"
            :key="option[0]"
            :class="{ selected: origin === option[0] }"
            @click="origin = option[0]"
          >
            {{ option[1] }}
          </button>
        </div>
        <span v-else class="report-family-label">家庭归属费用</span>
        <div class="report-tabs" role="group" aria-label="统计口径">
          <button :class="{ selected: basis === 'net' }" @click="basis = 'net'">
            净支出
          </button>
          <button
            :class="{ selected: basis === 'expense' }"
            @click="basis = 'expense'"
          >
            原始支出
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="notice error-notice" role="alert">{{ error }}</p>
    <p v-if="loading && !summary" class="report-loading">正在汇总账目…</p>

    <template v-else-if="summary">
      <div class="report-metrics">
        <article class="report-metric featured">
          <span>净支出</span>
          <strong>¥ {{ formatMoney(summary.net) }}</strong>
          <small>原始支出 − 退款</small>
        </article>
        <article class="report-metric">
          <span>原始支出</span>
          <strong>¥ {{ formatMoney(summary.expense) }}</strong>
          <small>按实际发生日期统计</small>
        </article>
        <article class="report-metric">
          <span>退款</span>
          <strong>¥ {{ formatMoney(summary.refund) }}</strong>
          <small>关联原支出，按退款日期统计</small>
        </article>
      </div>

      <div class="report-main-grid">
        <section class="report-panel trend-panel">
          <header class="report-panel-heading">
            <div>
              <h3>支出趋势</h3>
              <small>{{ range.from }} 至 {{ range.to }}</small>
            </div>
            <span>
              {{ selectedCategory ? `${selectedCategory.name} · ` : ""
              }}{{ basis === "net" ? "净支出" : "原始支出" }}
            </span>
          </header>
          <div v-if="!trendHasData" class="report-empty">
            {{
              selectedCategory
                ? `这个周期没有${selectedCategory.name}记录。`
                : "这个周期还没有支出记录。"
            }}
          </div>
          <div v-else class="report-chart-wrap">
            <svg
              class="report-chart"
              viewBox="0 0 720 220"
              role="img"
              aria-label="所选期间的支出趋势"
            >
              <line x1="42" x2="698" :y1="chart.zeroY" :y2="chart.zeroY" />
              <polyline :points="chart.line" />
              <circle
                v-for="(point, index) in chartDots"
                :key="index"
                :cx="point.x"
                :cy="point.y"
                r="3.5"
              />
            </svg>
            <div class="report-chart-labels">
              <span v-for="point in visiblePoints" :key="point.period">
                {{ formatPeriod(point.period) }}
              </span>
            </div>
          </div>
        </section>

        <section class="report-panel category-panel">
          <header class="report-panel-heading">
            <h3>分类排行</h3>
            <small>人民币 · 元</small>
          </header>
          <div v-if="categories.length" class="report-rank-list">
            <button
              v-for="item in categories"
              :key="item.categoryId"
              class="report-rank-row"
              :class="{ selected: selectedCategoryId === item.categoryId }"
              @click="selectCategory(item.categoryId)"
            >
              <span>{{ item.name }}</span>
              <span class="report-rank-track">
                <i
                  :class="{ negative: Number(item.value) < 0 }"
                  :style="{
                    width: `${Math.max(2, (Math.abs(Number(item.value)) / (categoryMax || 1)) * 100)}%`,
                  }"
                ></i>
              </span>
              <strong>{{ formatMoney(item.value) }}</strong>
            </button>
          </div>
          <div v-else class="report-empty">暂无分类数据。</div>
          <p class="report-panel-note">
            {{
              selectedCategory
                ? `趋势和明细已按${selectedCategory.name}筛选。`
                : "点击分类后，趋势和明细会同步筛选。"
            }}
          </p>
        </section>
      </div>

      <section
        v-if="session.activeSpace === 'family'"
        class="report-panel member-panel"
      >
        <header class="report-panel-heading">
          <div>
            <h3>成员付款</h3>
            <small>按付款人汇总，不代表成员消费或欠款</small>
          </div>
        </header>
        <div v-if="members.length" class="report-member-list">
          <button
            v-for="item in members"
            :key="item.payer.id"
            :class="{ selected: selectedPayerId === item.payer.id }"
            @click="selectPayer(item.payer.id)"
          >
            <span class="avatar">{{ item.payer.nickname.slice(0, 1) }}</span>
            <span>{{ item.payer.nickname }}</span>
            <strong>¥ {{ formatMoney(item.value) }}</strong>
          </button>
        </div>
        <p v-else class="report-empty">暂无成员付款数据。</p>
      </section>

      <section class="report-panel report-details-panel">
        <header class="report-panel-heading">
          <div>
            <h3>对应明细</h3>
            <small>
              {{
                selectedCategoryId ? "已按所选分类筛选" : "与当前统计口径一致"
              }}
              <button
                v-if="selectedCategoryId || selectedPayerId"
                class="text-button"
                @click="
                  selectedCategoryId = '';
                  selectedPayerId = '';
                "
              >
                清除筛选
              </button>
            </small>
          </div>
          <span>{{ details.length }} 条</span>
        </header>
        <div v-if="details.length" class="report-detail-list">
          <article v-for="item in details" :key="`${item.kind}-${item.id}`">
            <time>{{ item.occurredOn }}</time>
            <div>
              <strong>{{ item.title }}</strong>
              <small
                >{{ item.category.name }} · {{ item.payer.nickname }}</small
              >
            </div>
            <strong :class="{ refund: item.kind === 'refund' }">
              {{ item.kind === "refund" ? "−" : "" }}¥{{
                formatMoney(item.amount.replace("-", ""))
              }}
            </strong>
          </article>
          <button
            v-if="nextCursor !== null"
            class="quiet-button report-load-more"
            :disabled="detailsLoading"
            @click="loadDetails(nextCursor, true)"
          >
            加载更多明细
          </button>
        </div>
        <p v-else class="report-empty">这个筛选条件下没有明细。</p>
      </section>

      <p v-if="summary.comparison.hasData" class="report-comparison-note">
        对比 {{ summary.comparison.from }} 至
        {{ summary.comparison.to }}：净支出
        {{
          Number(summary.comparison.difference) > 0
            ? "增加"
            : Number(summary.comparison.difference) < 0
              ? "减少"
              : "持平"
        }}<template v-if="Number(summary.comparison.difference) !== 0">
          ¥{{
            formatMoney(summary.comparison.difference.replace("-", ""))
          }}</template
        ><template v-if="summary.comparison.percent !== null">
          （{{ Math.abs(summary.comparison.percent).toFixed(1) }}%）</template
        >
      </p>
    </template>
  </section>
</template>
