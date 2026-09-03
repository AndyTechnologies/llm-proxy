/**
 * Playwright E2E specs for the `/ui` dashboard (served by e2e/e2e-server.ts).
 *
 * Covers: document/landmark structure, default editor view, view navigation
 * with data-loading, keyboard node insertion (the SVG render path), and the
 * Validate toolbar action. Selectors use stable ids/roles/aria + the SVG
 * `data-type`/`data-id` attributes — never display text that could change.
 */
import { test, expect } from "@playwright/test";

/** Open the dashboard root. Runs before every test so state is fresh. */
test.beforeEach(async ({ page }) => {
  await page.goto("/ui");
});

test.describe("dashboard document structure", () => {
  test("loads with the expected title and banner landmark", async ({ page }) => {
    await expect(page).toHaveTitle("llm-proxy Dashboard");
    await expect(page.locator('header[role="banner"]')).toBeVisible();
  });

  test("nav exposes the four views as links", async ({ page }) => {
    const nav = page.locator('nav.app-nav[aria-label="Primary"]');
    await expect(nav).toBeVisible();
    // Ordered set of view links.
    await expect(nav.locator('a.nav-link[data-view="editor"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="pipelines"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="models"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="executions"]')).toBeVisible();
    await expect(nav.locator("a.nav-link")).toHaveCount(4);
  });
});

test.describe("editor default view", () => {
  test("editor view is visible by default", async ({ page }) => {
    // #editor is the only view initially not hidden.
    await expect(page.locator("#editor")).toBeVisible();
    const canvas = page.locator("#graph-canvas");
    await expect(canvas).toBeVisible();
    // It is focusable for keyboard node insertion (tabindex=0).
    await expect(canvas).toHaveAttribute("tabindex", "0");
  });

  test("the node palette lists the six node types", async ({ page }) => {
    const list = page.locator("#palette-list");
    await expect(list).toBeVisible();
    await expect(list.locator(".palette-item")).toHaveCount(6);
    // Each palette item carries a data-node-type that maps to a key (1-6).
    const types = ["start", "llm_call", "condition", "loop", "pipeline", "end"];
    for (const type of types) {
      await expect(list.locator(`.palette-item[data-node-type="${type}"]`)).toHaveCount(1);
    }
  });
});

test.describe("view navigation", () => {
  test("navigating to Models loads the models list", async ({ page }) => {
    await expect(page.locator("#models")).toBeHidden();
    await page.locator('a.nav-link[data-view="models"]').click();
    await expect(page.locator("#models")).toBeVisible();
    // loadModels() is async — poll for the list to populate (no fixed sleep).
    await expect(page.locator("#models-list .list-item")).toHaveCount(3);
  });

  test("navigating to Pipelines shows the example pipelines", async ({ page }) => {
    await page.locator('a.nav-link[data-view="pipelines"]').click();
    await expect(page.locator("#pipelines")).toBeVisible();
    // Two deterministic example pipelines from the harness.
    await expect(page.locator("#pipelines-list .list-item")).toHaveCount(2);
  });

  test("navigating to Executions shows the example execution", async ({ page }) => {
    await page.locator('a.nav-link[data-view="executions"]').click();
    await expect(page.locator("#executions")).toBeVisible();
    // The harness seeds exactly one completed execution.
    await expect(page.locator("#executions-list .list-item")).toHaveCount(1);
  });
});

test.describe("editor interaction (SVG render)", () => {
  test("pressing 1 while the canvas is focused adds a start node", async ({ page }) => {
    const canvas = page.locator("#graph-canvas");
    await canvas.focus();
    await page.keyboard.press("1");
    // Keyboard insertion renders the node into the SVG graph.
    await expect(
      page.locator('#graph-svg .graph-node[data-type="start"]'),
    ).toHaveCount(1);
  });

  test("pressing 2 adds an llm_call node, accumulating nodes", async ({ page }) => {
    const canvas = page.locator("#graph-canvas");
    await canvas.focus();

    await page.keyboard.press("1"); // start
    await expect(page.locator('#graph-svg .graph-node[data-type="start"]')).toHaveCount(1);

    await page.keyboard.press("2"); // llm_call
    await expect(page.locator('#graph-svg .graph-node[data-type="llm_call"]')).toHaveCount(1);

    // Both nodes coexist in the same SVG graph.
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(2);
  });
});

test.describe("validate action", () => {
  test("the Validate toolbar button is present", async ({ page }) => {
    const validate = page.locator("#btn-validate");
    await expect(validate).toBeVisible();
    await expect(validate).toHaveText("Validate");
  });
});
