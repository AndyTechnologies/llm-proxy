/**
 * Playwright E2E specs for the `/ui` dashboard (served by e2e/e2e-server.ts).
 *
 * svelte-ui 2.4 rewrite: the SPA is the compiled Svelte 5 bundle under
 * `dist/ui` (built with `bun run build:ui`). Specs cover the serving shell
 * (already green in Unit 1) and the full editor behavior contract —
 * drag/keys/connect, undo/redo, validate/apply, SSE live — with the Spanish
 * labels and ARIA the SPA exposes (title "Panel de control", nav
 * "Principal", toolbar "Validar").
 *
 * Selectors use stable ids/roles/aria + `data-view`/`data-type` attributes —
 * never display text that could change (the three Spanish assertions below
 * are the explicit spec'd labels).
 *
 * NOTE: the editor/views interaction specs target the Phase 3 SPA; until
 * then they are the RED acceptance device for Unit 2 (`bun run test:e2e`).
 * Only the "serving shell" describe block documents the Unit 1 deliverable.
 */
import { test, expect } from "@playwright/test";

/** Open the dashboard root. Runs before every test so state is fresh. */
test.beforeEach(async ({ page, request }) => {
  // Rebuild the harness: fresh tracker (1 seeded execution), no applied
  // chains — deterministic regardless of run order or server reuse.
  await request.post("/api/ui/_e2e/reset");
  await page.goto("/ui");
});

test.describe("serving shell (svelte-ui 2.4 / compiled dist/ui)", () => {
  test("loads with the Spanish title and banner landmark", async ({ page }) => {
    await expect(page).toHaveTitle("llm-proxy Panel de control");
    await expect(page.locator('header[role="banner"]')).toBeVisible();
  });

  test("nav exposes the FIVE views as links under the Principal label", async ({ page }) => {
    const nav = page.locator('nav.app-nav[aria-label="Principal"]');
    await expect(nav).toBeVisible();
    // Ordered set of view links (editor, pipelines, models, executions, agents).
    await expect(nav.locator('a.nav-link[data-view="editor"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="pipelines"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="models"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="executions"]')).toBeVisible();
    await expect(nav.locator('a.nav-link[data-view="agents"]')).toBeVisible();
    await expect(nav.locator("a.nav-link")).toHaveCount(5);
  });
});

test.describe("editor view", () => {
  test("editor is the default view with a focusable canvas", async ({ page }) => {
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
  test("navigating to Modelos loads the models list", async ({ page }) => {
    await expect(page.locator("#models")).toBeHidden();
    await page.locator('a.nav-link[data-view="models"]').click();
    await expect(page.locator("#models")).toBeVisible();
    await expect(page.locator("#models-list .list-item")).toHaveCount(3);
  });

  test("navigating to Pipelines shows the example pipelines", async ({ page }) => {
    await page.locator('a.nav-link[data-view="pipelines"]').click();
    await expect(page.locator("#pipelines")).toBeVisible();
    await expect(page.locator("#pipelines-list .list-item")).toHaveCount(2);
  });

  test("navigating to Ejecuciones shows the example execution", async ({ page }) => {
    await page.locator('a.nav-link[data-view="executions"]').click();
    await expect(page.locator("#executions")).toBeVisible();
    // The harness seeds exactly one completed execution.
    await expect(page.locator("#executions-list .list-item")).toHaveCount(1);
  });

  test("navigating to Agentes shows the agents view", async ({ page }) => {
    await expect(page.locator("#agents")).toBeHidden();
    await page.locator('a.nav-link[data-view="agents"]').click();
    await expect(page.locator("#agents")).toBeVisible();
  });
});

test.describe("editor interaction (SVG render)", () => {
  test("pressing 1..6 on the focused canvas inserts each node type", async ({ page }) => {
    const canvas = page.locator("#graph-canvas");
    await canvas.focus();
    const types = ["start", "llm_call", "condition", "loop", "pipeline", "end"];
    for (let i = 0; i < types.length; i++) {
      await page.keyboard.press(String(i + 1));
      await expect(
        page.locator(`#graph-svg .graph-node[data-type="${types[i]}"]`),
      ).toHaveCount(1);
    }
  });

  test("dragging a palette item onto the canvas inserts a node", async ({ page }) => {
    const palette = page.locator('.palette-item[data-node-type="llm_call"]');
    const canvas = page.locator("#graph-canvas");
    await palette.dragTo(canvas, { targetPosition: { x: 300, y: 200 } });
    await expect(page.locator('#graph-svg .graph-node[data-type="llm_call"]')).toHaveCount(1);
  });

  test("connect: drag from an output port to an input port draws an edge", async ({ page }) => {
    await page.locator("#graph-canvas").focus();
    await page.keyboard.press("1"); // start
    await page.keyboard.press("2"); // llm_call
    const output = page.locator('#graph-svg .graph-node[data-type="start"] .port--output');
    const input = page.locator('#graph-svg .graph-node[data-type="llm_call"] .port--input');
    await output.dragTo(input);
    await expect(page.locator("#graph-svg .graph-edge")).toHaveCount(1);
  });

  test("self-edge connect is rejected on the 24px snap", async ({ page }) => {
    await page.locator("#graph-canvas").focus();
    await page.keyboard.press("1"); // start
    const node = page.locator('#graph-svg .graph-node[data-type="start"]');
    const output = node.locator(".port--output");
    const input = node.locator(".port--input");
    // Attempt to connect a node to itself (marked invalid by the editor).
    await output.dragTo(input);
    await expect(page.locator("#graph-svg .graph-edge")).toHaveCount(0);
    await expect(page.locator("#graph-svg .graph-node.edge-invalid")).toHaveCount(0);
  });

  test("selected node is deleted with the Delete key", async ({ page }) => {
    await page.locator("#graph-canvas").focus();
    await page.keyboard.press("1");
    const node = page.locator('#graph-svg .graph-node[data-type="start"]');
    await node.click();
    await page.keyboard.press("Delete");
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(0);
  });
});

test.describe("undo/redo", () => {
  test("undo removes the inserted node and redo restores it", async ({ page }) => {
    await page.locator("#graph-canvas").focus();
    await page.keyboard.press("1");
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(1);

    await page.locator("#btn-undo").click();
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(0);

    await page.locator("#btn-redo").click();
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(1);
  });
});

test.describe("validate + apply", () => {
  test("the Validar toolbar button opens the validation dialog", async ({ page }) => {
    const validate = page.locator("#btn-validate");
    await expect(validate).toBeVisible();
    await expect(validate).toHaveText("Validar");
    await validate.click();
    await expect(page.locator("#validate-dialog")).toBeVisible();
    // A valid graph reports no errors in the dialog.
    await expect(page.locator("#validate-dialog .validation-error")).toHaveCount(0);
  });

  test("apply applies the pipeline through the apply dialog", async ({ page }) => {
    // A chain needs at least one node (chainConfigSchema.nodes.min(1)) — the
    // user builds a minimal graph before applying it.
    await page.locator("#graph-canvas").focus();
    await page.keyboard.press("1");
    await expect(page.locator("#graph-svg .graph-node")).toHaveCount(1);

    await page.locator("#btn-apply").click();
    await expect(page.locator("#apply-dialog")).toBeVisible();
    await page.locator("#apply-dialog #btn-confirm-apply").click();
    await expect(page.locator("#apply-dialog")).toBeHidden();
    // Applying persists — the Pipelines list now includes the applied chain.
    await page.locator('a.nav-link[data-view="pipelines"]').click();
    await expect(page.locator("#pipelines-list .list-item")).toHaveCount(3);
  });
});

test.describe("SSE live updates", () => {
  test("a completed execution appears in Ejecuciones without reload", async ({ page }) => {
    await page.locator('a.nav-link[data-view="executions"]').click();
    await expect(page.locator("#executions-list .list-item")).toHaveCount(1);
    // The harness debug seam records + publishes one completed execution while
    // the page is open; the list updates via SSE (no page reload).
    await page.evaluate(() =>
      fetch("/api/ui/_e2e/complete", { method: "POST" }),
    );
    await expect(page.locator("#executions-list .list-item")).toHaveCount(2);
  });
});