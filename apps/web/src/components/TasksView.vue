<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import {
  ApiClientError,
  apiRequest,
  deleteJson,
  newIdempotencyKey,
  patchJson,
  postJson,
} from "../api/client";
import SegmentedControl from "./SegmentedControl.vue";
import { useSessionStore } from "../stores/session";

type Person = { id: string; nickname: string };
type Task = {
  id: string;
  title: string;
  description: string | null;
  dueOn: string;
  familyId: string | null;
  status: "OPEN" | "DONE";
  manager: Person;
  assignee: Person | null;
  completedBy: Person | null;
  completedAt: string | null;
  version: number;
  canManage: boolean;
  canComplete: boolean;
};
type Occurrence = {
  id: string;
  periodKey: string;
  dueOn: string;
  title: string;
  status: "PENDING" | "PAID" | "SKIPPED";
  version: number;
  amount: string | null;
  payerId: string | null;
  manager: Person;
  canPay: boolean;
  canSkip: boolean;
};
type Rule = {
  id: string;
  title: string;
  familyId: string | null;
  category: { id: string; name: string; code: string };
  frequency: "MONTHLY" | "YEARLY";
  anchorOn: string;
  expectedAmount: string | null;
  status: "ACTIVE" | "PAUSED";
  version: number;
  canManage: boolean;
  occurrencesNextCursor: string | null;
  occurrences: Occurrence[];
};
type Category = { id: string; code: string; name: string };

const props = defineProps<{ initialAction?: string; targetId?: string }>();
const session = useSessionStore();
const section = ref<"tasks" | "fixed">(
  ["pay", "fixed"].includes(props.initialAction ?? "") ? "fixed" : "tasks",
);
const sectionOptions = [
  { value: "tasks", label: "普通待办" },
  { value: "fixed", label: "固定费用" },
];
const tasks = ref<Task[]>([]);
const rules = ref<Rule[]>([]);
const categories = ref<Category[]>([]);
const statusFilter = ref<"open" | "done" | "all">("open");
const loading = ref(false);
const loadingMore = ref(false);
const taskNextCursor = ref<string | null>(null);
const ruleNextCursor = ref<string | null>(null);
const occurrenceLoading = ref<Record<string, boolean>>({});
const saving = ref(false);
const error = ref("");
const notice = ref("");
const taskDialog = ref(false);
const ruleDialog = ref(false);
const taskEditing = ref<Task | null>(null);
const ruleEditing = ref<Rule | null>(null);
const paymentTarget = ref<Occurrence | null>(null);
const paymentKey = ref("");
const taskForm = reactive({
  title: "",
  description: "",
  dueOn: today(),
  assigneeId: "",
});
const ruleForm = reactive({
  title: "",
  categoryId: "",
  frequency: "MONTHLY" as "MONTHLY" | "YEARLY",
  anchorOn: today(),
  expectedAmount: "",
});
const paymentForm = reactive({ amount: "", occurredOn: today() });

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function changeSection(value: string) {
  section.value = value as "tasks" | "fixed";
}
function dueRuleLabel(rule: Rule) {
  const date = new Date(`${rule.anchorOn}T00:00:00`);
  return rule.frequency === "MONTHLY"
    ? `每月 ${date.getDate()} 日到期`
    : `每年 ${date.getMonth() + 1} 月 ${date.getDate()} 日到期`;
}
const familyId = computed(() =>
  session.activeSpace === "family" ? session.family?.id : undefined,
);
const canWrite = computed(
  () =>
    session.activeSpace === "personal" || session.family?.status === "ACTIVE",
);

function explain(reason: unknown, fallback: string) {
  return reason instanceof ApiClientError ? reason.message : fallback;
}

async function load(cursor?: string, append = false) {
  if (append) loadingMore.value = true;
  else {
    loading.value = true;
    taskNextCursor.value = null;
    ruleNextCursor.value = null;
  }
  error.value = "";
  try {
    const query = new URLSearchParams({
      space: session.activeSpace,
      limit: "30",
    });
    if (familyId.value) query.set("familyId", familyId.value);
    if (section.value === "tasks") {
      query.set("status", statusFilter.value);
      if (cursor) query.set("cursor", cursor);
      const page = await apiRequest<{
        items: Task[];
        nextCursor: string | null;
      }>(`/tasks?${query}`);
      tasks.value = append ? [...tasks.value, ...page.items] : page.items;
      taskNextCursor.value = page.nextCursor;
    } else {
      if (cursor) query.set("cursor", cursor);
      const page = await apiRequest<{
        items: Rule[];
        nextCursor: string | null;
      }>(`/recurring-rules?${query}`);
      rules.value = append ? [...rules.value, ...page.items] : page.items;
      ruleNextCursor.value = page.nextCursor;
      if (!categories.value.length)
        categories.value = await apiRequest<Category[]>("/categories");
    }
  } catch (reason) {
    error.value = explain(reason, "待办信息暂时无法加载。");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function loadMore() {
  const cursor =
    section.value === "tasks" ? taskNextCursor.value : ruleNextCursor.value;
  if (cursor && !loadingMore.value) void load(cursor, true);
}

async function loadMoreOccurrences(rule: Rule) {
  const cursor = rule.occurrencesNextCursor;
  if (!cursor || occurrenceLoading.value[rule.id]) return;
  occurrenceLoading.value[rule.id] = true;
  try {
    const page = await apiRequest<{
      items: Occurrence[];
      nextCursor: string | null;
    }>(
      `/recurring-rules/${rule.id}/occurrences?cursor=${encodeURIComponent(cursor)}&limit=30`,
    );
    rule.occurrences.push(...page.items);
    rule.occurrencesNextCursor = page.nextCursor;
  } catch (reason) {
    error.value = explain(reason, "历史期次暂时无法加载。");
  } finally {
    occurrenceLoading.value[rule.id] = false;
  }
}

watch(
  [section, statusFilter, familyId, () => session.activeSpace],
  () => void load(),
);
watch(categories, (nextCategories) => {
  if (ruleDialog.value && !ruleForm.categoryId)
    ruleForm.categoryId = nextCategories[0]?.id ?? "";
});
onMounted(async () => {
  await load();
  if (props.initialAction === "create") openTask();
  if (props.initialAction === "pay" && canWrite.value) {
    let target = rules.value
      .flatMap((rule) => rule.occurrences)
      .find((item) => item.id === props.targetId);
    while (!target && ruleNextCursor.value) {
      const cursor = ruleNextCursor.value;
      await load(cursor, true);
      if (ruleNextCursor.value === cursor) break;
      target = rules.value
        .flatMap((rule) => rule.occurrences)
        .find((item) => item.id === props.targetId);
    }
    if (target?.status === "PENDING") openPayment(target);
  }
  if (props.initialAction === "view" && props.targetId) {
    await nextTick();
    const target = document.getElementById(`task-${props.targetId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
});

function openTask(task?: Task) {
  taskEditing.value = task ?? null;
  Object.assign(
    taskForm,
    task
      ? {
          title: task.title,
          description: task.description ?? "",
          dueOn: task.dueOn,
          assigneeId: task.assignee?.id ?? "",
        }
      : { title: "", description: "", dueOn: today(), assigneeId: "" },
  );
  taskDialog.value = true;
}

async function saveTask() {
  saving.value = true;
  error.value = "";
  try {
    if (taskEditing.value) {
      await patchJson(`/tasks/${taskEditing.value.id}`, {
        version: taskEditing.value.version,
        title: taskForm.title,
        description: taskForm.description || null,
        dueOn: taskForm.dueOn,
        assigneeId: taskForm.assigneeId || null,
      });
    } else {
      await postJson("/tasks", {
        title: taskForm.title,
        description: taskForm.description || null,
        dueOn: taskForm.dueOn,
        ...(familyId.value ? { familyId: familyId.value } : {}),
        ...(taskForm.assigneeId ? { assigneeId: taskForm.assigneeId } : {}),
      });
    }
    taskDialog.value = false;
    notice.value = taskEditing.value ? "待办已更新。" : "待办已创建。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "保存失败，请刷新后重试。");
  } finally {
    saving.value = false;
  }
}

async function completeTask(task: Task) {
  try {
    await postJson(`/tasks/${task.id}/complete`, { version: task.version });
    notice.value =
      session.activeSpace === "family"
        ? "已完成，家庭成员会看到最新状态。"
        : "已完成，停止提醒。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "操作失败，请刷新后重试。");
  }
}
async function reopenTask(task: Task) {
  try {
    await postJson(`/tasks/${task.id}/reopen`, { version: task.version });
    await load();
  } catch (reason) {
    error.value = explain(reason, "无法重开，请刷新后重试。");
  }
}
async function removeTask(task: Task) {
  if (!window.confirm(`删除待办“${task.title}”？`)) return;
  try {
    await deleteJson(`/tasks/${task.id}`, { version: task.version });
    notice.value = "待办已删除。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "删除失败，请刷新后重试。");
  }
}

function openRule(rule?: Rule) {
  ruleEditing.value = rule ?? null;
  Object.assign(
    ruleForm,
    rule
      ? {
          title: rule.title,
          categoryId: rule.category.id,
          frequency: rule.frequency,
          anchorOn: rule.anchorOn,
          expectedAmount: rule.expectedAmount ?? "",
        }
      : {
          title: "",
          categoryId: categories.value[0]?.id ?? "",
          frequency: "MONTHLY",
          anchorOn: today(),
          expectedAmount: "",
        },
  );
  ruleDialog.value = true;
}
async function saveRule() {
  saving.value = true;
  error.value = "";
  try {
    const body = {
      title: ruleForm.title,
      categoryId: ruleForm.categoryId,
      frequency: ruleForm.frequency,
      anchorOn: ruleForm.anchorOn,
      expectedAmount: ruleForm.expectedAmount || null,
    };
    if (ruleEditing.value)
      await patchJson(`/recurring-rules/${ruleEditing.value.id}`, {
        ...body,
        version: ruleEditing.value.version,
      });
    else
      await postJson("/recurring-rules", {
        ...body,
        ...(familyId.value ? { familyId: familyId.value } : {}),
      });
    ruleDialog.value = false;
    notice.value = "固定费用规则已保存。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "保存失败，请刷新后重试。");
  } finally {
    saving.value = false;
  }
}
async function toggleRule(rule: Rule) {
  try {
    await postJson(
      `/recurring-rules/${rule.id}/${rule.status === "ACTIVE" ? "pause" : "resume"}`,
      { version: rule.version },
    );
    notice.value =
      rule.status === "ACTIVE"
        ? "规则已暂停，已生成期次仍保留。"
        : "规则已恢复。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "操作失败，请刷新后重试。");
  }
}
async function skipOccurrence(occurrence: Occurrence) {
  try {
    await postJson(`/occurrences/${occurrence.id}/skip`, {
      version: occurrence.version,
    });
    notice.value = "本期已跳过，不会记入账本。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "跳过失败，请刷新后重试。");
  }
}
function openPayment(occurrence: Occurrence) {
  paymentTarget.value = occurrence;
  paymentForm.amount = occurrence.amount ?? "";
  paymentForm.occurredOn = occurrence.dueOn;
  paymentKey.value = newIdempotencyKey();
}
async function payOccurrence() {
  if (!paymentTarget.value) return;
  saving.value = true;
  error.value = "";
  try {
    await apiRequest(`/occurrences/${paymentTarget.value.id}/pay`, {
      method: "POST",
      headers: { "idempotency-key": paymentKey.value },
      body: JSON.stringify({
        ...paymentForm,
        version: paymentTarget.value.version,
      }),
    });
    paymentTarget.value = null;
    notice.value = "付款已记录，并已计入账本。";
    await load();
  } catch (reason) {
    error.value = explain(reason, "付款未完成，请刷新后检查本期状态。");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="tasks-page">
    <div class="tasks-toolbar">
      <SegmentedControl
        :model-value="section"
        :options="sectionOptions"
        ariaLabel="待办类别"
        role="tablist"
        size="compact"
        @update:model-value="changeSection"
      />
      <div class="tasks-toolbar-actions">
        <select
          v-if="section === 'tasks'"
          v-model="statusFilter"
          aria-label="待办状态"
        >
          <option value="open">未完成</option>
          <option value="done">已完成</option>
          <option value="all">全部</option>
        </select>
        <button
          v-if="canWrite"
          class="primary-button"
          @click="section === 'tasks' ? openTask() : openRule()"
        >
          ＋ {{ section === "tasks" ? "新建待办" : "添加固定费用" }}
        </button>
      </div>
    </div>
    <p v-if="notice" class="inline-notice" role="status">
      {{ notice }} <button @click="notice = ''" aria-label="关闭提示">×</button>
    </p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="loading && !tasks.length && !rules.length" class="empty-state">
      正在加载…
    </div>

    <template v-else-if="section === 'tasks'">
      <TransitionGroup name="task" tag="div" class="task-list">
        <article
          v-for="task in tasks"
          :key="task.id"
          class="task-row"
          :id="`task-${task.id}`"
          tabindex="-1"
          :class="{ completed: task.status === 'DONE' }"
        >
          <button
            v-if="task.status === 'OPEN'"
            class="task-check"
            :aria-label="`完成：${task.title}`"
            @click="completeTask(task)"
          >
            ✓
          </button>
          <span v-else class="task-check done">✓</span>
          <div class="task-copy">
            <strong>{{ task.title }}</strong>
            <p v-if="task.description">{{ task.description }}</p>
            <small
              >截止 {{ task.dueOn
              }}<template v-if="task.assignee">
                · 负责人 {{ task.assignee.nickname }}</template
              ><template v-if="task.completedBy">
                · {{ task.completedBy.nickname }}已完成</template
              ></small
            >
          </div>
          <div class="task-row-actions">
            <button
              v-if="task.canManage && task.status === 'OPEN'"
              class="quiet-button"
              @click="openTask(task)"
            >
              编辑</button
            ><button
              v-if="task.canManage && task.status === 'OPEN'"
              class="quiet-button"
              @click="removeTask(task)"
            >
              删除</button
            ><button
              v-if="task.canManage && task.status === 'DONE'"
              class="quiet-button"
              @click="reopenTask(task)"
            >
              重开
            </button>
          </div>
        </article>
      </TransitionGroup>
      <button
        v-if="taskNextCursor"
        class="quiet-button task-load-more"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? "正在加载…" : "加载更多待办" }}
      </button>
      <div v-if="!tasks.length" class="empty-state">
        <span class="empty-symbol">◷</span
        ><strong>{{
          statusFilter === "done" ? "还没有完成的待办" : "今天没有待办"
        }}</strong>
        <p>把要记住的小事放在这里，个人待办只提醒自己。</p>
        <button v-if="canWrite" class="quiet-button" @click="openTask()">
          创建第一条待办
        </button>
      </div>
    </template>

    <template v-else>
      <div v-if="rules.length" class="fixed-list">
        <article v-for="rule in rules" :key="rule.id" class="fixed-card">
          <header>
            <div>
              <span class="fixed-category"
                >{{ rule.category.name }} ·
                {{ rule.frequency === "MONTHLY" ? "每月" : "每年" }}</span
              >
              <h3>{{ rule.title }}</h3>
              <p>
                {{ rule.expectedAmount ? `预计 ¥${rule.expectedAmount} · ` : ""
                }}{{ dueRuleLabel(rule) }}
              </p>
            </div>
            <span class="rule-status" :class="rule.status.toLowerCase()">{{
              rule.status === "ACTIVE" ? "进行中" : "已暂停"
            }}</span>
          </header>
          <div v-if="rule.occurrences.length" class="occurrence-list">
            <div
              v-for="occurrence in rule.occurrences"
              :key="occurrence.id"
              class="occurrence-row"
            >
              <div>
                <strong>{{ occurrence.periodKey }}</strong
                ><small>{{ occurrence.title }} · {{ occurrence.dueOn }}</small>
              </div>
              <span
                class="occurrence-status"
                :class="occurrence.status.toLowerCase()"
                >{{
                  occurrence.status === "PENDING"
                    ? "待付款"
                    : occurrence.status === "PAID"
                      ? `已付款${occurrence.amount ? ` · ¥${occurrence.amount}` : ""}`
                      : "已跳过"
                }}</span
              >
              <div
                v-if="occurrence.status === 'PENDING'"
                class="fixed-card-actions occurrence-actions"
              >
                <button class="quiet-button" @click="openPayment(occurrence)">
                  确认付款</button
                ><button
                  v-if="occurrence.canSkip"
                  class="quiet-button"
                  @click="skipOccurrence(occurrence)"
                >
                  跳过
                </button>
              </div>
            </div>
          </div>
          <div v-else class="no-occurrence">
            期次会在个人提醒设置的提前日期生成；实际到期日按上方周期规则计算。
          </div>
          <button
            v-if="rule.occurrencesNextCursor"
            class="text-button occurrence-load-more"
            :disabled="occurrenceLoading[rule.id]"
            @click="loadMoreOccurrences(rule)"
          >
            {{ occurrenceLoading[rule.id] ? "正在加载…" : "加载更早期次" }}
          </button>
          <footer v-if="rule.canManage" class="fixed-card-actions">
            <button class="quiet-button" @click="openRule(rule)">
              编辑规则</button
            ><button class="quiet-button" @click="toggleRule(rule)">
              {{ rule.status === "ACTIVE" ? "暂停" : "恢复" }}
            </button>
          </footer>
        </article>
      </div>
      <button
        v-if="ruleNextCursor"
        class="quiet-button task-load-more"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? "正在加载…" : "加载更多固定费用" }}
      </button>
      <div v-if="!rules.length" class="empty-state">
        <span class="empty-symbol">⌁</span><strong>还没有固定费用</strong>
        <p>
          添加水电燃气、房租等周期项目，到期前提醒；确认付款后才会记入账本。
        </p>
        <button v-if="canWrite" class="quiet-button" @click="openRule()">
          添加第一项固定费用
        </button>
      </div>
    </template>

    <Transition name="modal"
      ><div
        v-if="taskDialog"
        class="ledger-overlay"
        v-dialog
        @click.self="taskDialog = false"
      >
        <form class="ledger-dialog" @submit.prevent="saveTask">
          <header class="ledger-dialog-header">
            <div>
              <span class="eyebrow">{{
                taskEditing ? "更新事项" : "日常提醒"
              }}</span>
              <h2>{{ taskEditing ? "编辑待办" : "新建待办" }}</h2>
            </div>
            <button
              type="button"
              class="dialog-close"
              aria-label="关闭弹窗"
              @click="taskDialog = false"
            >
              ×
            </button>
          </header>
          <label
            >事项名称<input
              v-model="taskForm.title"
              required
              maxlength="120"
              placeholder="例如：缴纳水费" /></label
          ><label
            >截止日期<input
              v-model="taskForm.dueOn"
              type="date"
              required /></label
          ><label
            >补充说明<textarea
              v-model="taskForm.description"
              maxlength="500"
              rows="3"
            /></label
          ><label v-if="session.activeSpace === 'family' && session.family"
            >负责人<select v-model="taskForm.assigneeId">
              <option value="">暂不指定</option>
              <option
                v-for="person in session.family.members"
                :key="person.id"
                :value="person.id"
              >
                {{ person.nickname }}
              </option>
            </select></label
          >
          <div class="ledger-dialog-actions">
            <button
              type="button"
              class="quiet-button"
              @click="taskDialog = false"
            >
              取消</button
            ><button class="primary-button" :disabled="saving">
              {{ saving ? "保存中…" : "保存待办" }}
            </button>
          </div>
        </form>
      </div></Transition
    >

    <Transition name="modal"
      ><div
        v-if="ruleDialog"
        class="ledger-overlay"
        v-dialog
        @click.self="ruleDialog = false"
      >
        <form class="ledger-dialog" @submit.prevent="saveRule">
          <header class="ledger-dialog-header">
            <div>
              <span class="eyebrow">{{
                ruleEditing ? "更新周期" : "周期提醒"
              }}</span>
              <h2>{{ ruleEditing ? "编辑固定费用" : "添加固定费用" }}</h2>
            </div>
            <button
              type="button"
              class="dialog-close"
              aria-label="关闭弹窗"
              @click="ruleDialog = false"
            >
              ×
            </button>
          </header>
          <label
            >费用名称<input
              v-model="ruleForm.title"
              required
              maxlength="120"
              placeholder="例如：每月电费" /></label
          ><label
            >分类<select v-model="ruleForm.categoryId" required>
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
          >
          <p v-if="!categories.length" class="inline-error" role="alert">
            分类数据尚未就绪，暂时无法保存固定费用。请联系管理员检查分类初始化。
          </p>
          <div class="form-grid">
            <label
              >周期<select v-model="ruleForm.frequency">
                <option value="MONTHLY">每月</option>
                <option value="YEARLY">每年</option>
              </select></label
            ><label
              >首次到期日<input
                v-model="ruleForm.anchorOn"
                type="date"
                required
            /></label>
          </div>
          <p class="fixed-reminder-help">
            后续到期日按所选周期重复计算。提醒时间和提前天数由「我的 ·
            提醒设置」控制，到期当天也会提醒。
          </p>
          <label
            >预计金额（可选）<input
              v-model="ruleForm.expectedAmount"
              inputmode="decimal"
              placeholder="0.00"
          /></label>
          <div class="ledger-dialog-actions">
            <button
              type="button"
              class="quiet-button"
              @click="ruleDialog = false"
            >
              取消</button
            ><button
              class="primary-button"
              :disabled="saving || !categories.length"
            >
              {{ categories.length ? "保存规则" : "分类未就绪" }}
            </button>
          </div>
        </form>
      </div></Transition
    >

    <Transition name="modal"
      ><div
        v-if="paymentTarget"
        class="ledger-overlay"
        v-dialog
        @click.self="paymentTarget = null"
      >
        <form class="ledger-dialog" @submit.prevent="payOccurrence">
          <header class="ledger-dialog-header">
            <div>
              <span class="eyebrow"
                >确认付款 · {{ paymentTarget.periodKey }}</span
              >
              <h2>确认本期付款</h2>
            </div>
            <button
              type="button"
              class="dialog-close"
              aria-label="关闭弹窗"
              @click="paymentTarget = null"
            >
              ×
            </button>
          </header>
          <p class="payment-hint">
            确认后会创建一笔支出并进入账本，付款人记录为当前账号。
          </p>
          <label
            >实际金额<input
              v-model="paymentForm.amount"
              inputmode="decimal"
              required
              pattern="(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?"
              placeholder="0.00" /></label
          ><label
            >付款日期<input
              v-model="paymentForm.occurredOn"
              type="date"
              required
          /></label>
          <div class="ledger-dialog-actions">
            <button
              type="button"
              class="quiet-button"
              @click="paymentTarget = null"
            >
              取消</button
            ><button class="primary-button" :disabled="saving">
              {{ saving ? "提交中…" : "确认付款并记账" }}
            </button>
          </div>
        </form>
      </div></Transition
    >
  </section>
</template>
