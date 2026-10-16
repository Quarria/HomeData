<script setup lang="ts">
import { ref } from "vue";

defineProps<{ errorMessage?: string }>();
const emit = defineEmits<{
  submit: [username: string, password: string];
}>();
const username = ref("");
const password = ref("");
function submit() {
  emit("submit", username.value.trim(), password.value);
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
        <span class="eyebrow">A QUIETER WAY TO KEEP TRACK</span>
        <h1>欢迎回来</h1>
        <p>登录后，继续照看自己的日常。</p>
      </div>
      <form class="auth-form" @submit.prevent="submit">
        <label
          >用户名<input
            v-model="username"
            name="username"
            autocomplete="username"
            required
            maxlength="40"
            placeholder="请输入管理员分配的用户名"
        /></label>
        <label
          >密码<input
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="128"
            placeholder="请输入密码"
        /></label>
        <p v-if="errorMessage" class="form-error" role="alert">
          {{ errorMessage }}
        </p>
        <button class="primary-button auth-submit" type="submit">
          登录<span>↗</span>
        </button>
      </form>
      <p class="auth-footnote">
        账号由系统管理员创建；如需帮助，请联系家庭账本管理员。
      </p>
    </section>
  </main>
</template>
