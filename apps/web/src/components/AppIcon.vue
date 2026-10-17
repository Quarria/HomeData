<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 22 });
const paths: Record<string, string[]> = {
  home: ["m3 10 9-7 9 7v10H4V10", "M9 21v-8h6v8"],
  ledger: ["M12 5v16M3 4h6l3 2 3-2h6v16h-6l-3 2-3-2H3Z"],
  tasks: ["M4 3h16v18H4Z", "m7 9 2 2 3-3M14 9h3M7 16h10"],
  reports: ["M4 3v17h17M8 15v-4M13 15V6M18 15v-7"],
  profile: ["M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0", "M4 21v-2a8 8 0 0 1 16 0v2"],
  camera: ["M8 5 9 3h6l1 2h4v16H3V5Z", "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0"],
  plus: ["M12 4v16M4 12h16"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 7v5l3 2"],
  bell: ["M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4"],
  arrow: ["M4 12h16m-6-6 6 6-6 6"],
  check: ["m5 12 4 4L19 6"],
};
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="ui-icon"
  >
    <path
      v-for="(path, index) in paths[name] ?? paths.tasks"
      :key="index"
      :d="path"
    />
  </svg>
</template>
