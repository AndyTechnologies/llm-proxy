/**
 * Modelos (models) view component tests (svelte-ui task 3.3).
 *
 * Renders the lifecycle backend panel (config + VRAM state, wired in 3.6)
 * and the model registry rows from the dashboard store.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect } from "bun:test";
import { render, within } from "@testing-library/svelte";
import Modelos from "./Modelos.svelte";
import { makeDashboardStore } from "../test-setup/fakes.js";
import type { ModelEntry } from "../stores/types.js";

const MODELS = [
  { id: "qwen2.5:7b", loaded: true, processLoaded: true, ctx: 8192 },
  { id: "llama3.2:3b", loaded: true, ctx: 4096 },
  { id: "mistral:7b" },
] as ModelEntry[];

describe("Modelos view (task 3.3)", () => {
  it("renders the section with its title", () => {
    const { getByRole } = render(Modelos, { props: { store: makeDashboardStore() } });
    expect(getByRole("heading", { level: 2, name: "Modelos" })).toBeTruthy();
  });

  it("shows the models directory hint", async () => {
    const store = makeDashboardStore({ modelsDir: "/models/gguf" });
    await store.actions.loadModels();
    const { getByText } = render(Modelos, { props: { store } });
    expect(getByText(/Modelos en \/models\/gguf/)).toBeTruthy();
  });

  it("renders the backend lifecycle panel (fields wired in 3.6)", async () => {
    const store = makeDashboardStore({
      config: {
        llama: {
          lifecycle: { ttl: 30, vram: { mode: "auto", freeGb: 4, capGb: 12 } },
        },
      },
    });
    await store.actions.loadConfig();
    const { getByTestId } = render(Modelos, { props: { store } });
    const panel = getByTestId("backend-panel");
    const panelQueries = within(panel);
    expect(panelQueries.getByTestId("lc-ttl")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-vram-mode")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-freegb")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-capgb")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-status")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-save")).toBeTruthy();
    expect(panelQueries.getByTestId("lc-unload-all")).toBeTruthy();
    expect((panelQueries.getByTestId("lc-ttl") as HTMLInputElement).value).toBe("30");
  });

  it("shows VRAM lifecycle state in the panel status", async () => {
    const store = makeDashboardStore({
      lifecycle: {
        vramPolicyActive: true,
        lastVramSample: { usedMiB: 512, totalMiB: 8192, at: "2026-09-06T10:00:00Z" },
      },
    });
    await store.actions.loadModels();
    const { getByTestId } = render(Modelos, { props: { store } });
    const status = getByTestId("lc-status");
    expect(status.textContent).toContain("VRAM");
    expect(status.textContent).toContain("512");
  });

  it("lists one row per model with status and context", async () => {
    const store = makeDashboardStore({ models: MODELS, modelsDir: "/models/gguf" });
    await store.actions.loadModels();
    const { getByTestId } = render(Modelos, { props: { store } });
    const rows = within(getByTestId("models-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // process-loaded model shows the "banner" badge + ctx
    expect(rows[0]!.textContent).toContain("qwen2.5:7b");
    expect(rows[0]!.textContent).toContain("banner");
    expect(rows[0]!.textContent).toContain("8192");
    // plain loaded model
    expect(rows[1]!.textContent).toContain("cargado");
    // unloaded model
    expect(rows[2]!.textContent).toContain("descargado");
  });

  it("shows a hint when no models are registered", async () => {
    const store = makeDashboardStore({ models: [] });
    await store.actions.loadModels();
    const { getByText } = render(Modelos, { props: { store } });
    expect(getByText(/No hay modelos/i)).toBeTruthy();
  });
});