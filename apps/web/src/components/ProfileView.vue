<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ApiClientError,
  apiRequest,
  deleteJson,
  patchJson,
  postJson,
} from "../api/client";
import { useSessionStore, type AccountSummary } from "../stores/session";

const session = useSessionStore();
defineProps<{ notice?: string }>();
const emit = defineEmits<{ logout: []; changePassword: [] }>();
const familyName = ref("");
const memberUsername = ref("");
const handoverTarget = ref("");
const loading = ref(false);
const message = ref("");
const error = ref("");
const accountsOpen = ref(false);
const accounts = ref<AccountSummary[]>([]);
const accountNextCursor = ref<string | null>(null);
const accountLoadingMore = ref(false);
const accountForm = ref({ username: "", nickname: "", initialPassword: "" });
const accountPasswords = ref<Record<string, string>>({});
const nickname = ref("");
const reminderPreference = ref({
  localTime: "09:00",
  taskAdvanceDays: 1,
  feeAdvanceDays: 3,
  overdueEnabled: true,
});
const currentAccountId = computed(() => session.account?.id);

watch(
  () => session.account?.nickname,
  (value) => {
    if (value) nickname.value = value;
  },
  { immediate: true },
);

function showError(reason: unknown) {
  error.value =
    reason instanceof ApiClientError
      ? reason.message
      : "操作未完成，请稍后重试。";
  message.value = "";
}

async function createFamily() {
  loading.value = true;
  error.value = "";
  try {
    await postJson("/families", { name: familyName.value });
    familyName.value = "";
    await session.refresh();
    message.value = "家庭已创建，你现在是家庭管理员。";
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

async function addMember() {
  if (!session.family) return;
  loading.value = true;
  error.value = "";
  try {
    await postJson(`/families/${session.family.id}/members`, {
      username: memberUsername.value,
    });
    memberUsername.value = "";
    await session.refresh();
    message.value = "成员已加入家庭。";
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

async function saveNickname() {
  if (!session.account) return;
  loading.value = true;
  error.value = "";
  try {
    await patchJson("/me", {
      nickname: nickname.value,
      version: session.account.version,
    });
    await session.refresh();
    message.value = "昵称已更新。";
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

async function removeMember(memberId: string) {
  if (!session.family) return;
  loading.value = true;
  error.value = "";
  try {
    await deleteJson(`/families/${session.family.id}/members/${memberId}`, {
      version: session.family.version,
    });
    await session.refresh();
    message.value = "成员已移出家庭。";
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

async function changeFamilyState(
  action: "handover" | "archive" | "restore" | "leave",
) {
  const family = session.family;
  if (!family) return;
  loading.value = true;
  error.value = "";
  try {
    if (action === "handover") {
      await postJson(`/families/${family.id}/handover`, {
        targetAccountId: handoverTarget.value,
        version: family.version,
      });
      handoverTarget.value = "";
      message.value = "家庭管理权已交接。";
    } else if (action === "leave") {
      await postJson(`/families/${family.id}/leave`, {
        version: family.version,
      });
      message.value = "你已退出该家庭。";
    } else {
      await postJson(`/families/${family.id}/${action}`, {
        version: family.version,
      });
      message.value =
        action === "archive"
          ? "家庭已归档，成员可继续查看历史。"
          : "家庭已恢复。";
    }
    await session.refresh();
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

async function loadAccounts() {
  accountsOpen.value = !accountsOpen.value;
  if (!accountsOpen.value) return;
  await refreshAccounts();
}

async function refreshAccounts() {
  try {
    const page = await apiRequest<{
      items: AccountSummary[];
      nextCursor: string | null;
    }>("/admin/accounts?limit=10");
    accounts.value = page.items;
    accountNextCursor.value = page.nextCursor;
  } catch (reason) {
    showError(reason);
  }
}

async function loadMoreAccounts() {
  if (!accountNextCursor.value || accountLoadingMore.value) return;
  accountLoadingMore.value = true;
  try {
    const page = await apiRequest<{
      items: AccountSummary[];
      nextCursor: string | null;
    }>(
      `/admin/accounts?limit=10&cursor=${encodeURIComponent(accountNextCursor.value)}`,
    );
    accounts.value.push(...page.items);
    accountNextCursor.value = page.nextCursor;
  } catch (reason) {
    showError(reason);
  } finally {
    accountLoadingMore.value = false;
  }
}

async function createAccount() {
  try {
    await postJson("/admin/accounts", accountForm.value);
    accountForm.value = { username: "", nickname: "", initialPassword: "" };
    await refreshAccounts();
    message.value = "账号已创建；请线下将初始密码交给本人。";
  } catch (reason) {
    showError(reason);
  }
}

async function resetPassword(account: AccountSummary) {
  const initialPassword = accountPasswords.value[account.id] ?? "";
  try {
    await postJson(`/admin/accounts/${account.id}/reset-password`, {
      initialPassword,
    });
    accountPasswords.value[account.id] = "";
    await refreshAccounts();
    message.value = `已为 ${account.username} 重置密码；请线下告知本人。`;
  } catch (reason) {
    showError(reason);
  }
}

async function toggleAccount(account: AccountSummary) {
  const action = account.status === "ACTIVE" ? "disable" : "enable";
  try {
    await postJson(`/admin/accounts/${account.id}/${action}`, {
      version: account.version,
    });
    await refreshAccounts();
    message.value =
      account.status === "ACTIVE" ? "账号已停用。" : "账号已恢复。";
  } catch (reason) {
    showError(reason);
  }
}

onMounted(() => void session.refresh());

async function loadReminderPreference() {
  try {
    reminderPreference.value = await apiRequest<
      typeof reminderPreference.value
    >("/notification-preferences");
  } catch (reason) {
    showError(reason);
  }
}

async function saveReminderPreference() {
  loading.value = true;
  error.value = "";
  try {
    reminderPreference.value = await apiRequest<
      typeof reminderPreference.value
    >("/notification-preferences", {
      method: "PUT",
      body: JSON.stringify(reminderPreference.value),
    });
    message.value = "提醒设置已保存。";
  } catch (reason) {
    showError(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadReminderPreference());
</script>

<template>
  <section class="profile-page">
    <div class="profile-notices">
      <div v-if="message" class="notice success-notice" role="status">
        {{ message }}
      </div>
      <div v-if="notice" class="notice success-notice" role="status">
        {{ notice }}
      </div>
      <div v-if="error" class="notice error-notice" role="alert">
        {{ error }}
      </div>
    </div>

    <div class="profile-columns">
      <div class="profile-column">
        <section class="profile-section account-section">
          <div class="section-heading account-section-heading">
            <div>
              <h2>个人账号</h2>
            </div>
            <div class="profile-heading-actions">
              <span class="role-badge">{{
                session.account?.systemRole === "SYSTEM_ADMIN"
                  ? "系统管理员"
                  : "普通账号"
              }}</span>
              <button class="text-button danger-text" @click="emit('logout')">
                退出登录
              </button>
            </div>
          </div>
          <div class="account-overview">
            <span class="avatar profile-avatar">{{
              session.account?.nickname.slice(0, 1)
            }}</span>
            <div class="account-identity">
              <strong>{{ session.account?.nickname }}</strong>
              <p>用户名：{{ session.account?.username }}</p>
            </div>
            <form class="nickname-form" @submit.prevent="saveNickname">
              <label class="sr-only" for="nickname">昵称</label
              ><input
                id="nickname"
                v-model="nickname"
                required
                maxlength="80"
              /><button
                class="quiet-button"
                :disabled="loading || nickname === session.account?.nickname"
              >
                保存昵称
              </button>
            </form>
            <button
              class="text-button password-action"
              @click="emit('changePassword')"
            >
              修改密码
            </button>
          </div>
        </section>

        <section class="profile-section reminder-section">
          <div class="section-heading">
            <div>
              <h2>提醒设置</h2>
            </div>
            <span class="role-badge">站内提醒</span>
          </div>
          <form
            class="reminder-settings"
            @submit.prevent="saveReminderPreference"
          >
            <label class="reminder-field"
              ><span>每日提醒时间</span
              ><input
                v-model="reminderPreference.localTime"
                type="time"
                required
            /></label>
            <label class="reminder-field"
              ><span>待办提前提醒</span
              ><span class="reminder-input-wrap"
                ><input
                  v-model.number="reminderPreference.taskAdvanceDays"
                  type="number"
                  min="0"
                  max="30"
                  required
                /><small>天前</small></span
              ></label
            >
            <label class="reminder-field"
              ><span>固定费用提前提醒</span
              ><span class="reminder-input-wrap"
                ><input
                  v-model.number="reminderPreference.feeAdvanceDays"
                  type="number"
                  min="0"
                  max="30"
                  required
                /><small>天前</small></span
              ></label
            >
            <label class="reminder-overdue"
              ><input
                v-model="reminderPreference.overdueEnabled"
                type="checkbox"
              />每天提醒尚未处理的逾期事项</label
            >
            <button class="quiet-button" :disabled="loading">
              保存提醒偏好
            </button>
          </form>
        </section>
      </div>

      <div class="profile-column">
        <section class="profile-section family-section">
          <div class="section-heading">
            <div>
              <h2>家庭</h2>
            </div>
            <span v-if="session.family" class="role-badge">{{
              session.family.role === "ADMIN" ? "家庭管理员" : "家庭成员"
            }}</span>
          </div>
          <template v-if="session.family">
            <div class="family-overview">
              <div>
                <strong>{{ session.family.name }}</strong>
                <p>
                  {{
                    session.family.status === "ACTIVE"
                      ? `${session.family.members.length} 位有效成员`
                      : "家庭已归档"
                  }}
                </p>
              </div>
              <span class="status-pill"
                ><i></i
                >{{
                  session.family.status === "ACTIVE" ? "正常使用" : "只读归档"
                }}</span
              >
            </div>
            <ul class="member-list">
              <li v-for="member in session.family.members" :key="member.id">
                <span class="avatar member-avatar">{{
                  member.nickname.slice(0, 1)
                }}</span
                ><span class="member-identity"
                  >{{ member.nickname
                  }}<small>{{
                    member.id === session.family?.adminAccountId
                      ? "家庭管理员"
                      : member.username
                  }}</small></span
                ><span v-if="member.id === currentAccountId" class="you-tag"
                  >你</span
                ><button
                  v-else-if="
                    session.family.role === 'ADMIN' &&
                    session.family.status === 'ACTIVE'
                  "
                  class="text-button danger-text"
                  :disabled="loading"
                  @click="removeMember(member.id)"
                >
                  移出
                </button>
              </li>
            </ul>
            <form
              v-if="
                session.family.role === 'ADMIN' &&
                session.family.status === 'ACTIVE'
              "
              class="inline-form"
              @submit.prevent="addMember"
            >
              <label
                >添加已有账号<input
                  v-model="memberUsername"
                  required
                  maxlength="40"
                  placeholder="输入完整用户名" /></label
              ><button class="primary-button small-button" :disabled="loading">
                添加成员
              </button>
            </form>
            <div
              v-if="
                session.family.role === 'ADMIN' &&
                session.family.status === 'ACTIVE' &&
                session.family.members.length > 1
              "
              class="inline-form"
            >
              <label
                >移交家庭管理权<select v-model="handoverTarget" required>
                  <option disabled value="">选择一位当前成员</option>
                  <option
                    v-for="member in session.family.members.filter(
                      (item) => item.id !== currentAccountId,
                    )"
                    :key="member.id"
                    :value="member.id"
                  >
                    {{ member.nickname }}（{{ member.username }}）
                  </option>
                </select></label
              ><button
                class="quiet-button"
                :disabled="!handoverTarget || loading"
                @click="changeFamilyState('handover')"
              >
                确认交接
              </button>
            </div>
            <div class="family-actions">
              <button
                v-if="session.family.role === 'ADMIN'"
                class="quiet-button"
                :disabled="loading"
                @click="
                  changeFamilyState(
                    session.family.status === 'ACTIVE' ? 'archive' : 'restore',
                  )
                "
              >
                {{
                  session.family.status === "ACTIVE" ? "归档家庭" : "恢复家庭"
                }}</button
              ><button
                v-else
                class="text-button danger-text"
                :disabled="loading || session.family.status !== 'ACTIVE'"
                @click="changeFamilyState('leave')"
              >
                退出家庭
              </button>
            </div>
          </template>
          <form
            v-else
            class="inline-form create-family"
            @submit.prevent="createFamily"
          >
            <div>
              <strong>创建家庭空间</strong>
              <p>你会成为家庭管理员，之后可手动添加已有账号。</p>
            </div>
            <label
              >家庭名称<input
                v-model="familyName"
                required
                maxlength="80"
                placeholder="例如：林间小家" /></label
            ><button class="primary-button small-button" :disabled="loading">
              创建家庭
            </button>
          </form>
        </section>

        <section
          v-if="session.isSystemAdmin"
          class="profile-section admin-section"
        >
          <div class="section-heading">
            <div>
              <h2>账号管理</h2>
            </div>
            <button class="quiet-button" @click="loadAccounts">
              {{ accountsOpen ? "收起" : "管理账号" }}
            </button>
          </div>
          <template v-if="accountsOpen">
            <form class="admin-create-form" @submit.prevent="createAccount">
              <label
                >用户名<input
                  v-model="accountForm.username"
                  required
                  maxlength="40" /></label
              ><label
                >昵称<input
                  v-model="accountForm.nickname"
                  required
                  maxlength="80" /></label
              ><label
                >初始密码<input
                  v-model="accountForm.initialPassword"
                  required
                  type="password"
                  minlength="12"
                  maxlength="128" /></label
              ><button class="primary-button small-button">创建账号</button>
            </form>
            <div class="admin-account-list">
              <article
                v-for="item in accounts"
                :key="item.id"
                class="admin-account-row"
              >
                <div>
                  <strong>{{ item.nickname }}</strong>
                  <p>
                    {{ item.username }} ·
                    {{ item.status === "ACTIVE" ? "启用" : "停用"
                    }}<span v-if="item.mustChangePassword">
                      · 首次登录须改密</span
                    >
                  </p>
                </div>
                <input
                  v-model="accountPasswords[item.id]"
                  type="password"
                  minlength="12"
                  maxlength="128"
                  placeholder="重置初始密码"
                /><button
                  class="quiet-button"
                  :disabled="!accountPasswords[item.id]"
                  @click="resetPassword(item)"
                >
                  重置</button
                ><button
                  v-if="item.id !== currentAccountId"
                  class="text-button"
                  @click="toggleAccount(item)"
                >
                  {{ item.status === "ACTIVE" ? "停用" : "恢复" }}
                </button>
              </article>
            </div>
            <button
              v-if="accountNextCursor"
              class="quiet-button account-load-more"
              :disabled="accountLoadingMore"
              @click="loadMoreAccounts"
            >
              {{ accountLoadingMore ? "正在加载…" : "加载更多账号" }}
            </button>
          </template>
        </section>
      </div>
    </div>
  </section>
</template>
