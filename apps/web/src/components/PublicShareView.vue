<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiClientError, apiRequest, postJson } from "../api/client";

const props = defineProps<{ token: string }>();
type SharePayload = {
  summary: {
    from: string;
    to: string;
    scopeLabel: string;
    expense: string;
    refund: string;
    net: string;
  };
  trend: Array<{
    period: string;
    expense: string;
    refund: string;
    net: string;
  }>;
  categories: Array<{
    code: string;
    name: string;
    expense: string;
    refund: string;
    net: string;
  }>;
};
type PublicShare = {
  status: "available" | "locked" | "unavailable";
  generatedAt?: string;
  expiresAt?: string;
  payload?: SharePayload;
};

const view = ref<PublicShare | null>(null);
const passcode = ref("");
const loading = ref(true);
const unlocking = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    view.value = await apiRequest<PublicShare>(
      `/public/shares/${encodeURIComponent(props.token)}`,
    );
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError
        ? reason.message
        : "分享内容暂时无法读取。";
  } finally {
    loading.value = false;
  }
}

async function unlock() {
  unlocking.value = true;
  error.value = "";
  try {
    await postJson(`/public/shares/${encodeURIComponent(props.token)}/unlock`, {
      passcode: passcode.value,
    });
    passcode.value = "";
    await load();
  } catch (reason) {
    error.value =
      reason instanceof ApiClientError
        ? reason.message
        : "口令验证失败，请检查后重试。";
  } finally {
    unlocking.value = false;
  }
}

function money(value: string) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

onMounted(() => void load());
</script>

<template>
  <main class="public-share-page">
    <header class="public-share-brand">
      <span class="brand-mark">家</span>
      <span>家常账<small>家庭支出分享</small></span>
    </header>

    <section v-if="loading" class="public-share-state" aria-live="polite">
      <span class="eyebrow">SECURE SNAPSHOT</span>
      <h1>正在打开分享…</h1>
    </section>
    <section v-else-if="error && !view" class="public-share-state">
      <span class="eyebrow">暂时无法访问</span>
      <h1>分享内容无法读取</h1>
      <p>{{ error }}</p>
      <button class="quiet-button" @click="load">重新加载</button>
    </section>
    <section
      v-else-if="view?.status === 'unavailable'"
      class="public-share-state"
    >
      <span class="eyebrow">SHARE UNAVAILABLE</span>
      <h1>此分享已失效</h1>
      <p>链接可能已过期、撤销，或分享者的访问权限发生变化。</p>
    </section>
    <section
      v-else-if="view?.status === 'locked'"
      class="public-share-state share-unlock-card"
    >
      <span class="eyebrow">PASSCODE PROTECTED</span>
      <h1>输入访问口令</h1>
      <p>分享者为这份汇总设置了口令。</p>
      <form @submit.prevent="unlock">
        <label for="share-passcode">访问口令</label>
        <input
          id="share-passcode"
          v-model="passcode"
          type="password"
          autocomplete="current-password"
          required
          maxlength="64"
        />
        <p v-if="error" class="notice error-notice" role="alert">{{ error }}</p>
        <button class="primary-button" :disabled="unlocking || !passcode">
          {{ unlocking ? "正在验证…" : "查看汇总" }}
        </button>
      </form>
    </section>
    <template v-else-if="view?.status === 'available' && view.payload">
      <section class="public-share-heading">
        <span class="eyebrow">READ-ONLY SUMMARY</span>
        <h1>{{ view.payload.summary.scopeLabel }}</h1>
        <p>{{ view.payload.summary.from }} 至 {{ view.payload.summary.to }}</p>
      </section>
      <section class="public-share-metrics" aria-label="支出汇总">
        <article class="report-metric featured">
          <span>净支出</span
          ><strong>¥ {{ money(view.payload.summary.net) }}</strong>
          <small>原始支出 − 退款</small>
        </article>
        <article class="report-metric">
          <span>原始支出</span
          ><strong>¥ {{ money(view.payload.summary.expense) }}</strong>
        </article>
        <article class="report-metric">
          <span>退款</span
          ><strong>¥ {{ money(view.payload.summary.refund) }}</strong>
        </article>
      </section>
      <section class="report-panel public-share-categories">
        <header class="report-panel-heading">
          <div>
            <h3>分类汇总</h3>
            <small>此页面不展示逐笔记录或成员信息</small>
          </div>
          <span>人民币 · 元</span>
        </header>
        <div
          v-if="view.payload.categories.length"
          class="public-share-category-list"
        >
          <div v-for="category in view.payload.categories" :key="category.code">
            <span>{{ category.name }}</span>
            <strong>¥ {{ money(category.net) }}</strong>
          </div>
        </div>
        <p v-else class="report-empty">该周期暂无分类支出。</p>
      </section>
      <p class="public-share-footnote">
        快照生成于
        {{
          new Date(view.generatedAt!).toLocaleString("zh-CN")
        }}。此页面为只读副本。
      </p>
    </template>
  </main>
</template>
