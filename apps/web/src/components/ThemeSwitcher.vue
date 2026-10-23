<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { activeColorTheme, colorThemes, selectColorTheme } from "../theme";

const picker = ref<HTMLDetailsElement>();
function closeOutside(event: PointerEvent) {
  if (event.target instanceof Node && !picker.value?.contains(event.target)) {
    picker.value?.removeAttribute("open");
  }
}
onMounted(() => document.addEventListener("pointerdown", closeOutside));
onBeforeUnmount(() =>
  document.removeEventListener("pointerdown", closeOutside),
);
</script>

<template>
  <details
    ref="picker"
    class="theme-picker"
    @keydown.esc.prevent="picker?.removeAttribute('open')"
  >
    <summary aria-label="日常配色" title="日常配色">
      <span class="theme-current-swatch" aria-hidden="true"></span>
      <span class="theme-picker-label">配色</span>
    </summary>
    <div class="theme-menu" role="group" aria-label="日常配色方案">
      <strong>给日常换个颜色</strong>
      <button
        v-for="theme in colorThemes"
        :key="theme.id"
        type="button"
        :aria-pressed="activeColorTheme === theme.id"
        @click="selectColorTheme(theme.id)"
      >
        <span
          class="theme-pair"
          aria-hidden="true"
          :style="{ '--theme-a': theme.accent, '--theme-b': theme.yellow }"
        ></span>
        <span>{{ theme.name }}</span>
        <span class="theme-check" aria-hidden="true">{{
          activeColorTheme === theme.id ? "✓" : ""
        }}</span>
      </button>
      <small>自动记住这台设备上的选择</small>
    </div>
  </details>
</template>
