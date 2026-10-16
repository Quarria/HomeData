<script setup lang="ts">
import { ref } from "vue";

withDefaults(defineProps<{ errorMessage?: string; forced?: boolean }>(), {
  forced: true,
});
const emit = defineEmits<{
  submit: [currentPassword: string, newPassword: string];
  cancel: [];
}>();
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const localError = ref("");

function submit() {
  localError.value = "";
  if (newPassword.value !== confirmPassword.value) {
    localError.value = "两次输入的新密码不一致。";
    return;
  }
  if (newPassword.value.length < 12) {
    localError.value = "新密码至少需要 12 个字符。";
    return;
  }
  emit("submit", currentPassword.value, newPassword.value);
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <a class="brand auth-brand" href="#home"
        ><span class="brand-mark">家</span
        ><span>家常账<small>日常费用与提醒</small></span></a
      >
      <div class="auth-heading">
        <span class="eyebrow">SECURE YOUR ACCOUNT</span>
        <h1>{{ forced ? "先设置新密码" : "修改密码" }}</h1>
        <p>
          {{
            forced
              ? "这是首次登录，请修改管理员分配的初始密码后继续。"
              : "更新密码后，其他已登录设备需要重新登录。"
          }}
        </p>
      </div>
      <form class="auth-form" @submit.prevent="submit">
        <label
          >当前密码<input
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            maxlength="128"
        /></label>
        <label
          >新密码<input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="12"
            maxlength="128"
        /></label>
        <label
          >再次输入新密码<input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="12"
            maxlength="128"
        /></label>
        <p v-if="localError || errorMessage" class="form-error" role="alert">
          {{ localError || errorMessage }}
        </p>
        <button class="primary-button auth-submit" type="submit">
          保存并继续<span>↗</span>
        </button>
      </form>
      <button
        v-if="!forced"
        class="text-button auth-cancel"
        type="button"
        @click="emit('cancel')"
      >
        返回我的页面
      </button>
      <p class="auth-footnote">密码不会显示给管理员，也不会写入应用日志。</p>
    </section>
  </main>
</template>
