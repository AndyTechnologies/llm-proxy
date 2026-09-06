/**
 * Bun test preload: jsdom browser environment for component tests
 * (svelte-ui task 3.7 infra).
 *
 * Creates one jsdom instance and mirrors its window keys onto globalThis so
 * Svelte client components mount normally (document, Text, SVGElement, …).
 * Existing Bun globals are never overwritten (the `key in globalThis` guard),
 * so the backend suites keep bun's fetch/Response/navigator. Testing Library
 * cleanup runs after every test so mounted components never leak DOM between
 * cases.
 *
 * Loaded via `[test] preload` in bunfig.toml for every `bun test` run; a
 * no-op for suites that never touch the DOM.
 */
import { JSDOM } from "jsdom";
import { afterEach, expect } from "bun:test";
import * as jestDom from "@testing-library/jest-dom/matchers";

// @testing-library/svelte registers its own auto beforeEach/afterEach at
// module-eval time (src/index.js). Eager suites (src/ui-svelte) evaluate it
// at file scope, which is legal — but backend suites only touch it through
// the lazy import in afterEach below, where module-eval would land INSIDE a
// test lifecycle and bun rejects "Cannot call beforeEach() inside a test".
// The library's documented opt-out (STL_SKIP_AUTO_CLEANUP) keeps our manual
// afterEach below as the single cleanup path for every suite.
process.env.STL_SKIP_AUTO_CLEANUP = "1";

// jest-dom matchers (toBeVisible, toHaveAttribute, …) on bun:test's expect.
// The jest-dom module shape (default + named) does not match bun's
// ExpectExtendMatchers contract directly, so adapt it through `unknown`.
expect.extend(jestDom as unknown as Parameters<typeof expect.extend>[0]);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "navigator") continue;
  if (!(key in g)) {
    g[key] = dom.window[key as keyof typeof dom.window];
  }
}

// jsdom does not implement HTMLDialogElement; the editor views call
// showModal()/close() for the validate/apply dialogs. Real browsers are
// unaffected (the polyfill is guarded), jsdom tests keep working.
if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}

// jsdom does not implement PointerEvent or Element#setPointerCapture; the
// editor canvas interacts through pointer events (drag/connect/pan), so the
// tests need a MouseEvent-based stand-in. Real browsers are unaffected.
if (typeof PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  g.PointerEvent = PointerEventPolyfill;
}
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function (this: Element, _pointerId: number): void {
    // no-op: jsdom has no pointer-capture model; handlers live on window
  };
  Element.prototype.releasePointerCapture = function (this: Element): void {
    // no-op
  };
}

// cleanup is imported LAZILY (dynamic) — importing @testing-library/svelte
// here at top level would evaluate testing-library's raw `.svelte.js` runes
// modules BEFORE the svelte-loader preload registers its compiler plugin,
// and bun caches modules per process, so the raw versions would poison every
// later render. By the time afterEach runs, the loader is registered and the
// document global exists, so the import compiles cleanly.
afterEach(() => {
  void import("@testing-library/svelte").then(({ cleanup }) => cleanup());
});