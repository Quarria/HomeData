<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

type SegmentOption = { value: string; label: string };

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SegmentOption[];
    ariaLabel: string;
    role?: "tablist" | "group";
    size?: "compact" | "regular";
  }>(),
  { role: "group", size: "regular" },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const root = ref<HTMLElement | null>(null);
const buttons = ref<HTMLButtonElement[]>([]);
const indicator = ref({ left: 0, width: 0, ready: false, instant: true });
const ripple = ref<{ id: number; left: number; top: number } | null>(null);
let resizeObserver: ResizeObserver | undefined;
let readyFrame = 0;
let rippleTimer = 0;
let rippleId = 0;

const rootClasses = computed(() => [
  "segmented-control",
  `segmented-control--${props.size}`,
  { "is-ready": indicator.value.ready },
  { "no-motion": indicator.value.instant },
]);

function setButtonRef(element: Element | null, index: number) {
  if (element instanceof HTMLButtonElement) buttons.value[index] = element;
  else delete buttons.value[index];
}

function syncIndicator(animate = true) {
  const selectedIndex = props.options.findIndex(
    (option) => option.value === props.modelValue,
  );
  const selectedButton = buttons.value[selectedIndex];
  if (!selectedButton) return;
  indicator.value.instant = !animate;
  indicator.value.left = selectedButton.offsetLeft;
  indicator.value.width = selectedButton.offsetWidth;
  if (!animate) {
    window.cancelAnimationFrame(readyFrame);
    readyFrame = window.requestAnimationFrame(() => {
      indicator.value.instant = false;
      indicator.value.ready = true;
    });
  }
}

function select(value: string, button?: HTMLButtonElement) {
  if (value === props.modelValue) return;
  if (root.value && button) {
    const rootRect = root.value.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    ripple.value = {
      id: ++rippleId,
      left: buttonRect.left + buttonRect.width / 2 - rootRect.left,
      top: buttonRect.top + buttonRect.height / 2 - rootRect.top,
    };
    window.clearTimeout(rippleTimer);
    rippleTimer = window.setTimeout(() => (ripple.value = null), 600);
  }
  emit("update:modelValue", value);
}

function handleKeydown(event: KeyboardEvent, index: number) {
  if (props.role !== "tablist") return;
  const direction =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  const targetIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? props.options.length - 1
        : direction
          ? (index + direction + props.options.length) % props.options.length
          : -1;
  if (targetIndex < 0) return;
  event.preventDefault();
  buttons.value[targetIndex]?.focus();
  select(props.options[targetIndex]!.value, buttons.value[targetIndex]);
}

watch(
  [() => props.modelValue, () => props.options.map((option) => option.value)],
  async () => {
    await nextTick();
    syncIndicator();
  },
  { deep: true },
);

onMounted(async () => {
  await nextTick();
  syncIndicator(false);
  if (root.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => syncIndicator(false));
    resizeObserver.observe(root.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.cancelAnimationFrame(readyFrame);
  window.clearTimeout(rippleTimer);
});
</script>

<template>
  <div ref="root" :class="rootClasses" :role="role" :aria-label="ariaLabel">
    <span
      class="segmented-indicator"
      aria-hidden="true"
      :style="{ left: `${indicator.left}px`, width: `${indicator.width}px` }"
    ></span>
    <span
      v-if="ripple"
      :key="ripple.id"
      class="segmented-ripple"
      aria-hidden="true"
      :style="{ left: `${ripple.left}px`, top: `${ripple.top}px` }"
    ></span>
    <button
      v-for="(option, index) in options"
      :key="option.value"
      :ref="(element) => setButtonRef(element as Element | null, index)"
      type="button"
      :class="{ selected: modelValue === option.value }"
      :role="role === 'tablist' ? 'tab' : undefined"
      :aria-selected="
        role === 'tablist' ? modelValue === option.value : undefined
      "
      :tabindex="
        role === 'tablist' && modelValue !== option.value ? -1 : undefined
      "
      @click="select(option.value, $event.currentTarget as HTMLButtonElement)"
      @keydown="handleKeydown($event, index)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
