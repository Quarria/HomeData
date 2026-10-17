import type { ObjectDirective } from "vue";

type State = { previous: HTMLElement | null; cleanup: () => void };
const states = new WeakMap<HTMLElement, State>();
let openCount = 0;
let previousOverflow = "";
const focusable =
  "button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']";

export const dialogDirective: ObjectDirective<HTMLElement> = {
  mounted(element) {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog =
      element.querySelector<HTMLElement>(".ledger-dialog") ?? element;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = dialog.querySelector("h2");
    if (heading && !dialog.hasAttribute("aria-label"))
      dialog.setAttribute(
        "aria-label",
        heading.textContent?.trim() || "操作窗口",
      );
    if (openCount++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const close = dialog.querySelector<HTMLButtonElement>(
          ".ledger-close, .dialog-close",
        );
        if (close && !close.disabled) {
          event.preventDefault();
          close.click();
        }
      }
      if (event.key !== "Tab") return;
      const targets = [
        ...dialog.querySelectorAll<HTMLElement>(focusable),
      ].filter((target) => target.getClientRects().length > 0);
      const first = targets[0];
      const last = targets.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener("keydown", keydown);
    const initial =
      dialog.querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, select",
      ) ?? dialog.querySelector<HTMLElement>(focusable);
    initial?.focus({ preventScroll: true });
    states.set(element, {
      previous,
      cleanup: () => element.removeEventListener("keydown", keydown),
    });
  },
  unmounted(element) {
    const state = states.get(element);
    state?.cleanup();
    states.delete(element);
    if (--openCount === 0) document.body.style.overflow = previousOverflow;
    if (state?.previous?.isConnected)
      state.previous.focus({ preventScroll: true });
    else
      document
        .querySelector<HTMLElement>(
          ".ledger-actions .primary-button, .tasks-toolbar-actions .primary-button",
        )
        ?.focus({ preventScroll: true });
  },
};
