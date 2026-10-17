import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import "./life-calendar.css";
import { dialogDirective } from "./directives/dialog";

const pointerGlowCandidates = [
  "button:not(:disabled)",
  "a",
  "[role='button']",
  ".ledger-paper",
  ".ledger-row",
  ".ledger-row-mark",
  ".profile-section",
  ".report-panel",
  ".report-metric",
  ".report-rank-row",
  ".fixed-card",
  ".task-row",
  ".life-task",
  ".life-summary",
  ".welcome-panel",
  ".preview-tag",
  ".status-pill",
  ".role-badge",
  ".you-tag",
  ".rule-status",
  ".occurrence-status",
].join(",");
const pointerGlowAlways =
  ".segmented-control, .nav-item.active, .scope-switch button.selected, .mobile-nav-item.active";
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
let activeGlowTarget: HTMLElement | null = null;

function clearPointerGlow() {
  activeGlowTarget?.classList.remove("pointer-glow-active");
  activeGlowTarget = null;
}

function hasVisibleSurface(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const transparentColor =
    style.backgroundColor === "transparent" ||
    /,\s*0(?:\.0+)?\s*\)$/.test(style.backgroundColor) ||
    /\/\s*0(?:\.0+)?\s*\)$/.test(style.backgroundColor);
  return style.backgroundImage !== "none" || !transparentColor;
}

function followPointerGlow(event: PointerEvent) {
  if (event.pointerType !== "mouse" || prefersReducedMotion.matches) {
    clearPointerGlow();
    return;
  }

  let target: HTMLElement | null = null;
  let element = event.target instanceof Element ? event.target : null;
  while (element && element !== document.documentElement) {
    if (
      element.matches(pointerGlowCandidates) ||
      element.matches(pointerGlowAlways)
    ) {
      const candidate = element as HTMLElement;
      if (element.matches(pointerGlowAlways) || hasVisibleSurface(candidate)) {
        target = candidate;
        break;
      }
    }
    element = element.parentElement;
  }

  if (target !== activeGlowTarget) {
    clearPointerGlow();
    activeGlowTarget = target;
    if (target) {
      if (!target.matches(".segmented-control")) {
        target.classList.add("pointer-glow-surface");
      }
      target.classList.add("pointer-glow-active");
    }
  }
  if (!target) return;

  const rect = target.getBoundingClientRect();
  target.style.setProperty(
    "--pointer-glow-x",
    `${event.clientX - rect.left}px`,
  );
  target.style.setProperty("--pointer-glow-y", `${event.clientY - rect.top}px`);
}

document.addEventListener("pointerover", followPointerGlow, { passive: true });
document.addEventListener("pointermove", followPointerGlow, { passive: true });
document.addEventListener("pointerout", (event) => {
  if (!event.relatedTarget) clearPointerGlow();
});
window.addEventListener("blur", clearPointerGlow);

createApp(App)
  .use(createPinia())
  .directive("dialog", dialogDirective)
  .mount("#app");
