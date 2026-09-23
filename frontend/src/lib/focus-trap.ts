/**
 * Keyboard focus containment for modal dialogs (WAI-ARIA dialog pattern).
 *
 * On activation it moves focus to the first interactive element inside
 * `container` unless focus already landed there, then traps Tab / Shift+Tab
 * within it (cycles at both ends). Returns a cleanup that detaches the key
 * listener.
 *
 * DOM glue (querySelectorAll + focus) — exercised through the console's
 * dialog components, not unit-tested (no DOM harness in this repo).
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

export function trapFocus(container: HTMLElement): () => void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const els = focusables(container);
    const first = els.at(0);
    const last = els.at(-1);
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    const focusInside = active instanceof HTMLElement && container.contains(active);
    if (event.shiftKey) {
      if (!focusInside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!focusInside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Move focus in unless it already landed inside (some dialogs focus a
  // specific field themselves).
  const active = document.activeElement;
  const focusInside = active instanceof HTMLElement && container.contains(active);
  if (!focusInside) focusables(container).at(0)?.focus();

  container.addEventListener("keydown", onKeydown);
  return () => container.removeEventListener("keydown", onKeydown);
}