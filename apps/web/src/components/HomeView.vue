<script lang="ts">
const enteredAccounts = new Set<string>();
</script>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { ApiClientError, apiRequest } from "../api/client";
import { useSessionStore } from "../stores/session";
import AppIcon from "./AppIcon.vue";

const emit = defineEmits<{
  navigate: [
    target: {
      page: "ledger" | "tasks" | "reports" | "wardrobe";
      action?: string;
      id?: string;
      file?: File;
    },
  ];
}>();
type Task = { id: string; title: string; dueOn: string; status: string };
type Occurrence = { id: string; title: string; dueOn: string; status: string };
type Rule = { status: string; occurrences: Occurrence[] };
type Attention = {
  id: string;
  title: string;
  date: string;
  kind: "task" | "fee";
};
const session = useSessionStore();
const accountKey = session.account?.id ?? "";
const firstEntry = ref(!enteredAccounts.has(accountKey));
enteredAccounts.add(accountKey);
function finishEntry(event: AnimationEvent) {
  if ((event.target as HTMLElement).classList.contains("life-capture"))
    firstEntry.value = false;
}
const summary = ref<{ net: string; hasData: boolean } | null>(null);
const attention = ref<Attention[]>([]);
const loading = ref(true);
const error = ref("");
const receiptInput = ref<HTMLInputElement | null>(null);
let requestId = 0;
const today = ref(new Date());
const dayTimer = window.setInterval(() => {
  const now = new Date();
  if (localDate(now) !== localDate(today.value)) today.value = now;
}, 60_000);
onUnmounted(() => {
  window.clearInterval(dayTimer);
  requestId += 1;
});
function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const todayKey = computed(() => localDate(today.value));
const monthLabel = computed(
  () => `${today.value.getFullYear()} 年 ${today.value.getMonth() + 1} 月`,
);
const greeting = computed(
  () =>
    `${session.account?.nickname ?? ""}，今天是 ${today.value.getMonth() + 1} 月 ${today.value.getDate()} 日，星期${"日一二三四五六"[today.value.getDay()]}。`,
);
const canWrite = computed(
  () =>
    session.activeSpace === "personal" || session.family?.status === "ACTIVE",
);
const week = computed(() => {
  const monday = new Date(today.value);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const key = localDate(date);
    return {
      key,
      day: date.getDate(),
      label: key === todayKey.value ? "今天" : `周${"一二三四五六日"[index]}`,
      hasItems: attention.value.some((item) => item.date === key),
    };
  });
});
const visible = computed(() => attention.value.slice(0, 3));
const groups = computed(() => {
  const result: Array<{ date: string; items: Attention[] }> = [];
  for (const item of visible.value) {
    const group = result.find((entry) => entry.date === item.date);
    if (group) group.items.push(item);
    else result.push({ date: item.date, items: [item] });
  }
  return result;
});
function dateCaption(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getMonth() + 1} 月 · 星期${"日一二三四五六"[date.getDay()]}`;
}
function money(value: string) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
const scopeKey = computed(
  () =>
    `${session.activeSpace}:${session.family?.id ?? ""}:${session.family?.status ?? ""}:${todayKey.value}`,
);
async function load() {
  const currentId = ++requestId;
  // 先清空上一空间，避免加载期间把个人金额和事项误标成家庭数据。
  loading.value = true;
  summary.value = null;
  attention.value = [];
  error.value = "";
  const params = new URLSearchParams({
    space: session.activeSpace,
    origin: "all",
    status: "open",
  });
  if (session.activeSpace === "family" && session.family)
    params.set("familyId", session.family.id);
  const report = new URLSearchParams(params);
  report.delete("status");
  report.set("from", `${todayKey.value.slice(0, 7)}-01`);
  report.set("to", todayKey.value);
  report.set("period", "month");
  report.set("basis", "net");
  const results = await Promise.allSettled([
    apiRequest<{ net: string; hasData: boolean }>(`/reports/summary?${report}`),
    apiRequest<{ items: Task[]; nextCursor: string | null }>(
      `/tasks?${params}&limit=30`,
    ),
    apiRequest<{ items: Rule[]; nextCursor: string | null }>(
      `/recurring-rules?${params}&limit=30`,
    ),
  ]);
  if (currentId !== requestId) return;
  const [total, tasks, rules] = results;
  if (total.status === "fulfilled") summary.value = total.value;
  const horizon = new Date(today.value);
  horizon.setDate(horizon.getDate() + 7);
  const candidates: Attention[] = [
    ...(tasks.status === "fulfilled"
      ? tasks.value.items
          .filter((task) => task.status === "OPEN")
          .map((task): Attention => ({
            id: task.id,
            title: task.title,
            date: task.dueOn,
            kind: "task",
          }))
      : []),
    ...(rules.status === "fulfilled"
      ? rules.value.items.flatMap((rule) =>
          rule.occurrences
            .filter((item) => item.status === "PENDING")
            .map((item): Attention => ({
              id: item.id,
              title: item.title,
              date: item.dueOn,
              kind: "fee",
            })),
        )
      : []),
  ];
  attention.value = candidates
    .filter((item) => item.date <= localDate(horizon))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const failed = results.find((item) => item.status === "rejected");
  if (failed?.status === "rejected")
    error.value =
      failed.reason instanceof ApiClientError
        ? failed.reason.message
        : "部分信息暂时无法加载，请重试。";
  loading.value = false;
}
watch(
  scopeKey,
  (_value, previous) => {
    if (previous !== undefined) firstEntry.value = false;
    void load();
  },
  { immediate: true },
);
function chooseReceipt(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) emit("navigate", { page: "ledger", file });
}
</script>

<template>
  <section class="life-home" aria-label="首页概览">
    <div class="life-intro">
      <div>
        <h1>
          {{ session.activeSpace === "family" ? "家庭日常" : "个人日常" }}
        </h1>
        <p>{{ greeting }}</p>
      </div>
      <span class="life-month">{{ monthLabel }}</span>
    </div>
    <p v-if="error" class="inline-error" role="alert">
      {{ error }} <button class="text-button" @click="load">重新加载</button>
    </p>
    <div
      :key="scopeKey"
      class="life-canvas"
      :class="{ 'first-entry': firstEntry }"
      :aria-busy="loading"
      @animationend="finishEntry"
    >
      <section class="life-agenda">
        <header class="life-section-heading">
          <h2>
            近期需处理 <small v-if="!loading">{{ attention.length }}</small>
          </h2>
          <button
            class="text-button"
            @click="emit('navigate', { page: 'tasks' })"
          >
            全部事项 <AppIcon name="arrow" :size="16" />
          </button>
        </header>
        <div class="life-week" aria-label="本周日期">
          <div
            v-for="day in week"
            :key="day.key"
            class="life-day"
            :class="{ today: day.key === todayKey, 'has-items': day.hasItems }"
            :aria-current="day.key === todayKey ? 'date' : undefined"
          >
            <span>{{ day.label }}</span
            ><strong>{{ day.day }}</strong
            ><i v-if="day.hasItems" aria-hidden="true"></i>
          </div>
        </div>
        <p v-if="loading" class="life-empty" role="status">正在查看近期事项…</p>
        <template v-else-if="groups.length">
          <div
            v-for="group in groups"
            :key="group.date"
            class="life-date-group"
          >
            <div class="life-date-label">
              <strong>{{ Number(group.date.slice(-2)) }}</strong
              ><span
                >{{ dateCaption(group.date)
                }}<small
                  >{{ group.date < todayKey ? "已逾期 · " : ""
                  }}{{ group.items.length }} 项待处理</small
                ></span
              >
            </div>
            <div class="life-timeline">
              <article
                v-for="item in group.items"
                :key="`${item.kind}:${item.id}`"
                class="life-task"
              >
                <div>
                  <strong>{{ item.title }}</strong
                  ><small
                    >{{ item.date < todayKey ? "已逾期" : "到期" }}
                    {{ item.date }} ·
                    {{ item.kind === "fee" ? "费用待支付" : "待办任务" }}</small
                  >
                </div>
                <button
                  class="quiet-button"
                  @click="
                    emit('navigate', {
                      page: 'tasks',
                      action:
                        item.kind === 'fee'
                          ? canWrite
                            ? 'pay'
                            : 'fixed'
                          : 'view',
                      id: item.id,
                    })
                  "
                >
                  {{ item.kind === "fee" && canWrite ? "去支付" : "查看" }}
                  <AppIcon name="arrow" :size="15" />
                </button>
              </article>
            </div>
          </div>
        </template>
        <div v-else-if="!error" class="life-empty">
          <AppIcon name="check" :size="28" />
          <h3>近期事项已安排妥当</h3>
          <p>有新的待办或到期费用时，会在这里提醒。</p>
        </div>
        <p class="life-privacy">
          {{
            session.activeSpace === "family"
              ? "家庭事项会提醒所有当前成员。"
              : "个人待办只提醒自己。"
          }}
        </p>
      </section>
      <aside class="life-capture">
        <section class="life-summary">
          <header>
            <h2>本月净支出</h2>
            <span>{{ today.getMonth() + 1 }} 月</span>
          </header>
          <Transition name="amount" mode="out-in"
            ><div :key="summary?.net ?? 'pending'" class="life-amount">
              <span>¥</span>{{ summary ? money(summary.net) : "—" }}
            </div></Transition
          >
          <p>
            {{
              session.activeSpace === "family"
                ? "家庭共同开支。"
                : "本人支付，含家庭费用。"
            }}支出已扣除退款。
          </p>
          <button
            class="text-button"
            @click="emit('navigate', { page: 'reports' })"
          >
            查看报表 <AppIcon name="arrow" :size="16" />
          </button>
        </section>
        <div class="life-actions" aria-label="快捷记录">
          <button
            class="life-record"
            :disabled="!canWrite"
            @click="emit('navigate', { page: 'ledger', action: 'create' })"
          >
            <AppIcon name="plus" /><span
              ><strong>记一笔</strong><small>记录日常消费</small></span
            ><AppIcon name="arrow" :size="18" /></button
          ><button :disabled="!canWrite" @click="receiptInput?.click()">
            <AppIcon name="camera" /><span
              ><strong>拍票据</strong><small>核对后保存</small></span
            ><AppIcon name="arrow" :size="18" /></button
          ><button
            :disabled="!canWrite"
            @click="emit('navigate', { page: 'tasks', action: 'create' })"
          >
            <AppIcon name="tasks" /><span
              ><strong>新建待办</strong
              ><small>{{
                session.activeSpace === "family"
                  ? "全家一起记得"
                  : "提醒自己的事"
              }}</small></span
            ><AppIcon name="arrow" :size="18" />
          </button>
        </div>
        <button
          class="life-wardrobe-link"
          @click="emit('navigate', { page: 'wardrobe' })"
        >
          <AppIcon name="wardrobe" :size="17" />打开智能衣柜
          <AppIcon name="arrow" :size="16" />
        </button>
        <input
          ref="receiptInput"
          class="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          aria-label="选择要识别的票据"
          @change="chooseReceipt"
        />
      </aside>
    </div>
  </section>
</template>
