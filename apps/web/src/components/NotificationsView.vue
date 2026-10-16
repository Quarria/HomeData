<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiClientError, apiRequest, postJson } from "../api/client";

type Item = {
  id: string;
  subjectType: "TASK" | "OCCURRENCE";
  subjectId: string;
  reminderKind: "ADVANCE" | "DUE" | "OVERDUE";
  scheduledOn: string;
  title: string;
  periodKey?: string;
};
type Message = {
  id: string;
  slotAt: string;
  readAt: string | null;
  unreadCount: number;
  items: Item[];
};
const emit = defineEmits<{
  close: [];
  openTasks: [];
  unreadChange: [count: number];
}>();
const messages = ref<Message[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    messages.value = await apiRequest<Message[]>("/notifications");
    emit(
      "unreadChange",
      messages.value.reduce((total, message) => total + message.unreadCount, 0),
    );
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError ? reason.message : "消息暂时无法加载。";
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());

async function openMessage(message: Message) {
  if (!message.readAt) {
    try {
      await postJson(`/notifications/${message.id}/read`, {});
      message.readAt = new Date().toISOString();
      message.unreadCount = 0;
      emit(
        "unreadChange",
        messages.value.reduce(
          (total, current) => total + current.unreadCount,
          0,
        ),
      );
    } catch (reason) {
      error.value =
        reason instanceof ApiClientError
          ? reason.message
          : "已读状态保存失败。";
      return;
    }
  }
  emit("openTasks");
}
</script>

<template>
  <section class="notification-popover" aria-label="提醒消息">
    <header>
      <div>
        <span class="eyebrow">INBOX</span>
        <h2>提醒</h2>
      </div>
      <button class="dialog-close" aria-label="关闭提醒" @click="emit('close')">
        ×
      </button>
    </header>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div v-if="loading" class="notification-empty">正在读取提醒…</div>
    <div v-else-if="!messages.length" class="notification-empty">
      <span>◷</span><strong>目前没有新的提醒</strong
      ><small>待办和固定费用将在提醒时间显示在这里。</small>
    </div>
    <div v-else class="notification-list">
      <button
        v-for="message in messages"
        :key="message.id"
        class="notification-message"
        :class="{ unread: message.unreadCount > 0 }"
        @click="openMessage(message)"
      >
        <span class="notification-dot"></span
        ><span class="notification-copy"
          ><strong>{{
            message.items.length === 1
              ? message.items[0]?.title
              : `${message.items.length} 项待处理`
          }}</strong
          ><small
            >{{
              message.items[0]?.reminderKind === "OVERDUE"
                ? "已逾期 · "
                : message.items[0]?.reminderKind === "DUE"
                  ? "今天到期 · "
                  : "即将到期 · "
            }}{{ message.items[0]?.scheduledOn
            }}<template v-if="message.items.length > 1"> 等</template></small
          ></span
        ><span class="notification-arrow">›</span>
      </button>
    </div>
    <footer>
      <span>站内提醒 · 北京时间</span
      ><button @click="emit('openTasks')">查看待办与固定费用 →</button>
    </footer>
  </section>
</template>
