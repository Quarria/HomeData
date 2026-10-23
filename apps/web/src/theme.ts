import { ref } from "vue";

export const colorThemes = [
  { id: "blue", name: "明黄 × 雾蓝", accent: "#9dc9ee", yellow: "#ffda57" },
  { id: "sun", name: "暖黄 × 墨黑", accent: "#ffda57", yellow: "#ffda57" },
  { id: "sage", name: "奶黄 × 鼠尾草", accent: "#b8cbb5", yellow: "#f3d86d" },
  { id: "pink", name: "鹅黄 × 杏桃", accent: "#efb3a5", yellow: "#f5dc79" },
] as const;

type ColorTheme = (typeof colorThemes)[number]["id"];
const storageKey = "homedata:daily-color-theme";
export const activeColorTheme = ref<ColorTheme>("blue");

function applyTheme(value: string | null) {
  const theme = colorThemes.find(({ id }) => id === value)?.id ?? "blue";
  activeColorTheme.value = theme;
  document.documentElement.dataset.colorTheme = theme;
}

export function selectColorTheme(theme: ColorTheme) {
  applyTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Storage may be disabled; the selected palette still works for this visit.
  }
}

export function initializeColorTheme() {
  try {
    applyTheme(localStorage.getItem(storageKey));
  } catch {
    applyTheme(null);
  }
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null)
      applyTheme(event.newValue);
  });
}
