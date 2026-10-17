<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiClientError } from "./api/client";
import AppIcon from "./components/AppIcon.vue";
import HomeView from "./components/HomeView.vue";
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
  { id: "home", title: "首页" },
  { id: "ledger", title: "账本" },
  { id: "tasks", title: "待办与提醒" },
  { id: "reports", title: "报表" },
  { id: "profile", title: "我的" },
] as const;
const activePage = ref<(typeof pages)[number]["id"]>("home");
const activeTitle = computed(
  () => pages.find(({ id }) => id === activePage.value)?.title ?? "首页",
);
const activeIndex = computed(() =>
  pages.findIndex((page) => page.id === activePage.value),
);
const pageAction = ref("");
const targetId = ref("");
const receiptFile = ref<File>();
const pageComponents = {
  home: HomeView,
  ledger: LedgerView,
  tasks: TasksView,
  reports: ReportsView,
  profile: ProfileView,
};
const pageProps = computed(() =>
  activePage.value === "ledger"
    ? { initialAction: pageAction.value, initialReceipt: receiptFile.value }
    : activePage.value === "tasks"
      ? { initialAction: pageAction.value, targetId: targetId.value }
      : activePage.value === "profile"
        ? { notice: passwordNotice.value }
        : {},
);
function navigate(target: {
  page: typeof activePage.value;
  action?: string;
  id?: string;
  file?: File;
}) {
  pageAction.value = target.action ?? "";
  targetId.value = target.id ?? "";
  receiptFile.value = target.file;
  activePage.value = target.page;
  window.scrollTo({ top: 0, behavior: "instant" });
}
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

function disableLeavingPage(element: Element) {
  element.setAttribute("inert", "");
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
      <nav
        class="desktop-nav"
        aria-label="主导航"
        :style="{ '--active-index': activeIndex }"
      >
        <span class="nav-selection" aria-hidden="true"></span>
        <button
          v-for="page in pages"
          :key="page.id"
          :class="['nav-item', { active: activePage === page.id }]"
          :aria-current="activePage === page.id ? 'page' : undefined"
          @click="navigate({ page: page.id })"
        >
          <span class="nav-icon"><AppIcon :name="page.id" /></span
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
            <span
              class="scope-selection"
              :class="{ family: session.activeSpace === 'family' }"
              aria-hidden="true"
            ></span>
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
          <span
            v-if="
              session.family?.status === 'ARCHIVED' &&
              session.activeSpace === 'family'
            "
            class="preview-tag"
            >{{
              session.family?.status === "ARCHIVED" &&
              session.activeSpace === "family"
                ? "只读归档"
                : "安全记录"
            }}</span
          >
          <button
            class="icon-button"
            aria-label="消息提醒"
            :aria-expanded="notificationsOpen"
            @click="notificationsOpen = !notificationsOpen"
          >
            <AppIcon name="bell" /><i v-if="unreadNotifications"></i>
          </button>
          <span class="avatar small-avatar">{{
            session.account.nickname.slice(0, 1)
          }}</span>
        </div>
        <Transition name="popover">
          <NotificationsView
            v-if="notificationsOpen"
            @close="notificationsOpen = false"
            @unread-change="unreadNotifications = $event"
            @open-tasks="
              notificationsOpen = false;
              activePage = 'tasks';
            "
          />
        </Transition>
      </header>
      <main class="page-content">
        <div
          v-if="activePage !== 'reports' && activePage !== 'home'"
          class="page-intro"
        >
          <h1>{{ activeTitle }}</h1>
        </div>

        <Transition
          name="page"
          mode="out-in"
          @before-leave="disableLeavingPage"
        >
          <component
            :is="pageComponents[activePage]"
            :key="activePage"
            v-bind="pageProps"
            @navigate="navigate"
            @change-password="
              passwordMode = true;
              authError = '';
              passwordNotice = '';
            "
            @logout="logout"
          />
        </Transition>

        <footer class="page-footer">
          家常账 <span>{{ spaceName }} · 人民币</span>
        </footer>
      </main>
    </div>
    <nav
      class="mobile-nav"
      aria-label="手机主导航"
      :style="{ '--active-index': activeIndex }"
    >
      <span class="mobile-nav-selection" aria-hidden="true"></span>
      <button
        v-for="page in pages"
        :key="page.id"
        :class="['mobile-nav-item', { active: activePage === page.id }]"
        :aria-current="activePage === page.id ? 'page' : undefined"
        @click="navigate({ page: page.id })"
      >
        <span><AppIcon :name="page.id" /></span
        ><small>{{ page.title === "待办与提醒" ? "待办" : page.title }}</small>
      </button>
    </nav>
  </div>
</template>
