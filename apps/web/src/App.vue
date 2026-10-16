<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiClientError } from "./api/client";
import LoginView from "./components/LoginView.vue";
import PasswordChangeView from "./components/PasswordChangeView.vue";
import ProfileView from "./components/ProfileView.vue";
import LedgerView from "./components/LedgerView.vue";
import TasksView from "./components/TasksView.vue";
import NotificationsView from "./components/NotificationsView.vue";
import ReportsView from "./components/ReportsView.vue";
import PublicShareView from "./components/PublicShareView.vue";
import { useSessionStore } from "./stores/session";

const session = useSessionStore();
const shareToken = computed(() => {
  const match = window.location.pathname.match(
    /^\/s\/([A-Za-z0-9_-]{30,})\/?$/,
  );
  return match?.[1] ?? "";
});
const authError = ref("");
const passwordMode = ref(false);
const passwordNotice = ref("");
const notificationsOpen = ref(false);
const unreadNotifications = ref(0);
const pages = [
  { id: "home", title: "首页", icon: "⌂" },
  { id: "ledger", title: "账本", icon: "▤" },
  { id: "tasks", title: "待办与提醒", icon: "◷" },
  { id: "reports", title: "报表", icon: "▥" },
  { id: "profile", title: "我的", icon: "◉" },
] as const;
const activePage = ref<(typeof pages)[number]["id"]>("home");
const activeTitle = computed(
  () => pages.find(({ id }) => id === activePage.value)?.title ?? "首页",
);
const spaceName = computed(() =>
  session.activeSpace === "family" && session.family
    ? session.family.name
    : "个人空间",
);

onMounted(() => {
  if (!shareToken.value) void session.refresh();
});

async function login(username: string, password: string) {
  authError.value = "";
  try {
    await session.login(username, password);
  } catch (reason) {
    authError.value =
      reason instanceof ApiClientError
        ? reason.message
        : "暂时无法登录，请检查网络后重试。";
  }
}

async function changePassword(currentPassword: string, newPassword: string) {
  authError.value = "";
  try {
    await session.changePassword(currentPassword, newPassword);
    passwordMode.value = false;
    passwordNotice.value = "密码已更新，其他设备需要重新登录。";
  } catch (reason) {
    authError.value =
      reason instanceof ApiClientError
        ? reason.message
        : "密码更新失败，请稍后重试。";
  }
}

async function logout() {
  await session.logout();
  activePage.value = "home";
}

function toggleSpace() {
  session.setSpace(session.activeSpace === "personal" ? "family" : "personal");
}
</script>

<template>
  <PublicShareView v-if="shareToken" :token="shareToken" />
  <main v-else-if="session.isLoading" class="loading-screen" aria-live="polite">
    <span class="brand-mark">家</span>
    <p>正在打开你的账本…</p>
  </main>
  <LoginView
    v-else-if="!session.account"
    :error-message="authError"
    @submit="login"
  />
  <PasswordChangeView
    v-else-if="session.account.mustChangePassword || passwordMode"
    :error-message="authError"
    :forced="session.account.mustChangePassword"
    @submit="changePassword"
    @cancel="
      passwordMode = false;
      authError = '';
    "
  />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <a
        class="brand"
        href="#home"
        aria-label="家常账首页"
        @click.prevent="activePage = 'home'"
        ><span class="brand-mark">家</span
        ><span>家常账<small>日常费用与提醒</small></span></a
      >
      <nav class="desktop-nav" aria-label="主导航">
        <button
          v-for="page in pages"
          :key="page.id"
          :class="['nav-item', { active: activePage === page.id }]"
          @click="activePage = page.id"
        >
          <span class="nav-icon" aria-hidden="true">{{ page.icon }}</span
          >{{ page.title }}
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="space-label">{{ spaceName }}<span>当前</span></div>
        <button class="profile-button" @click="activePage = 'profile'">
          <span class="avatar">{{ session.account.nickname.slice(0, 1) }}</span>
          <span
            >{{ session.account.nickname
            }}<small>{{ session.account.username }}</small></span
          >
          <span class="chevron">›</span>
        </button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="mobile-brand">
          <span class="brand-mark small-mark">家</span>家常账
          <button
            v-if="session.family"
            class="mobile-current-space"
            :aria-label="`当前空间：${spaceName}，点击切换`"
            @click="toggleSpace"
          >
            {{ spaceName }}
          </button>
          <span v-else class="mobile-current-space">个人空间</span>
        </div>
        <div class="top-context">
          <div
            v-if="session.family"
            class="scope-switch"
            role="group"
            aria-label="空间切换"
          >
            <button
              :class="{ selected: session.activeSpace === 'personal' }"
              @click="session.setSpace('personal')"
            >
              个人
            </button>
            <button
              :class="{ selected: session.activeSpace === 'family' }"
              @click="session.setSpace('family')"
            >
              家庭
            </button>
          </div>
          <div class="breadcrumb">
            <span>{{ spaceName }}</span
            ><span class="slash">/</span><strong>{{ activeTitle }}</strong>
          </div>
        </div>
        <div class="top-actions">
          <span class="preview-tag">{{
            session.family?.status === "ARCHIVED" &&
            session.activeSpace === "family"
              ? "只读归档"
              : "安全记录"
          }}</span>
          <button
            class="icon-button"
            aria-label="消息提醒"
            :aria-expanded="notificationsOpen"
            @click="notificationsOpen = !notificationsOpen"
          >
            ♧<i v-if="unreadNotifications"></i>
          </button>
          <span class="avatar small-avatar">{{
            session.account.nickname.slice(0, 1)
          }}</span>
        </div>
        <NotificationsView
          v-if="notificationsOpen"
          @close="notificationsOpen = false"
          @unread-change="unreadNotifications = $event"
          @open-tasks="
            notificationsOpen = false;
            activePage = 'tasks';
          "
        />
      </header>
      <main class="page-content">
        <div v-if="activePage !== 'reports'" class="page-intro">
          <h1>{{ activeTitle }}</h1>
          <p>
            {{
              activePage === "home"
                ? "为日常开支和家庭事务，留一份清晰、安心的记录。"
                : `${spaceName} · ${activeTitle}`
            }}
          </p>
        </div>

        <ProfileView
          v-if="activePage === 'profile'"
          :notice="passwordNotice"
          @change-password="
            passwordMode = true;
            authError = '';
            passwordNotice = '';
          "
          @logout="logout"
        />

        <LedgerView v-else-if="activePage === 'ledger'" />

        <TasksView v-else-if="activePage === 'tasks'" />

        <ReportsView v-else-if="activePage === 'reports'" />

        <template v-else-if="activePage === 'home'">
          <section class="welcome-panel" aria-label="首页概览">
            <div class="welcome-copy">
              <span class="status-pill"
                ><i></i> {{ spaceName }} · 记录由你掌握</span
              >
              <h2>把每一笔日常，<br />记得明白一些。</h2>
              <p>从一笔清楚的日常开支开始，慢慢建立适合自己的家庭账本。</p>
              <div class="welcome-actions">
                <button class="primary-button" @click="activePage = 'ledger'">
                  开始记一笔 <span>↗</span>
                </button>
                <button class="text-button" @click="activePage = 'tasks'">
                  查看待办 <span>→</span>
                </button>
              </div>
            </div>
            <div class="welcome-art" aria-hidden="true">
              <div class="art-orbit"></div>
              <div class="art-card">
                <span class="art-label">TODAY'S NOTE</span
                ><span class="art-line"></span
                ><span class="art-line short"></span
                ><span class="art-stamp">家</span>
              </div>
              <span class="art-spark spark-one">✳</span
              ><span class="art-spark spark-two">·</span>
            </div>
          </section>
          <section class="next-step">
            <span class="step-number">01</span>
            <div>
              <strong>从清晰的账本开始</strong>
              <p>
                分类统一、个人付款，水电燃气分别统计；家庭空间由你主动切换。
              </p>
            </div>
            <span class="step-arrow">↗</span>
          </section>
        </template>

        <section v-else class="feature-placeholder">
          <span class="eyebrow"
            >{{ activeTitle.toUpperCase() }} · 正在按批次开发</span
          >
          <h2>{{ activeTitle }}会使用同一套个人与家庭权限。</h2>
          <p>
            当前批次已完成账号、家庭和安全会话基础。后续批次会逐步接入真实记录、提醒、报表和主动
            AI 功能。
          </p>
          <button class="quiet-button" @click="activePage = 'profile'">
            查看账号与家庭设置
          </button>
        </section>

        <footer class="page-footer">
          家常账 <span>记录日常，也照顾生活。</span>
        </footer>
      </main>
    </div>
    <nav class="mobile-nav" aria-label="手机主导航">
      <button
        v-for="page in pages"
        :key="page.id"
        :class="['mobile-nav-item', { active: activePage === page.id }]"
        @click="activePage = page.id"
      >
        <span>{{ page.icon }}</span
        ><small>{{ page.title === "待办与提醒" ? "待办" : page.title }}</small>
      </button>
    </nav>
  </div>
</template>
