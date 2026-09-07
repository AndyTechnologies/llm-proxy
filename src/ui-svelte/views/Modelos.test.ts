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
import { render, within, fireEvent, waitFor } from "@testing-library/svelte";
import Modelos from "./Modelos.svelte";
import { createDashboardStore } from "../stores/dashboard-store.js";
import { makeDashboardStore, makeFakeDashboardApi } from "../test-setup/fakes.js";
import type { FakeDashboardData } from "../test-setup/fakes.js";
import type { ModelEntry, LifecycleConfig } from "../stores/types.js";

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

describe("Modelos view (lifecycle apply, spec scenario 10)", () => {
  const CONFIG = {
    llama: { lifecycle: { ttl: 30, vram: { mode: "dynamic", freeGb: 2, capGb: 8 } } },
  } as LifecycleConfig;

  function renderPanel(data: Partial<FakeDashboardData>) {
    const api = makeFakeDashboardApi(data);
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    return { api, store };
  }

  it("renders the schema VRAM modes with their labels", async () => {
    const store = makeDashboardStore({
      config: {
        llama: { lifecycle: { ttl: 30, vram: { mode: "margin", freeGb: 4, capGb: 12 } } },
      } as LifecycleConfig,
    });
    await store.actions.loadConfig();
    const { getByTestId } = render(Modelos, { props: { store } });
    const select = getByTestId("lc-vram-mode") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["dynamic", "margin", "cap"]);
    expect(select.value).toBe("margin");
  });

  it("enables save only when dirty and applies the merged config", async () => {
    const { api, store } = renderPanel({ config: CONFIG });
    await store.actions.loadConfig();
    const { getByTestId } = render(Modelos, { props: { store } });
    const save = getByTestId("lc-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.input(getByTestId("lc-ttl"), { target: { value: "60" } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.applyConfig).toBe(1));
    expect(api.lastAppliedConfig).toEqual({
      llama: { lifecycle: { ttl: 60, vram: { mode: "dynamic", freeGb: 2, capGb: 8 } } },
    });
    await waitFor(() => expect(api.calls.config).toBe(2));
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("blocks save and surfaces the error when the TTL is invalid", async () => {
    const { api, store } = renderPanel({ config: CONFIG });
    await store.actions.loadConfig();
    const { getByTestId } = render(Modelos, { props: { store } });
    const save = getByTestId("lc-save") as HTMLButtonElement;
    await fireEvent.input(getByTestId("lc-ttl"), { target: { value: "-5" } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(getByTestId("lc-form-error")).toBeTruthy());
    expect(api.calls.applyConfig).toBe(0);
  });

  it("shows the freeGb field for dynamic/margin and the capGb field only for cap", async () => {
    const store = makeDashboardStore({
      config: {
        llama: { lifecycle: { ttl: 30, vram: { mode: "margin", freeGb: 4, capGb: 12 } } },
      } as LifecycleConfig,
    });
    await store.actions.loadConfig();
    const { getByTestId } = render(Modelos, { props: { store } });
    const freegb = getByTestId("lc-freegb");
    const capgb = getByTestId("lc-capgb");
    expect(freegb).toBeVisible();
    expect(capgb).not.toBeVisible();
    await fireEvent.change(getByTestId("lc-vram-mode"), { target: { value: "cap" } });
    await waitFor(() => expect(capgb).toBeVisible());
    expect(freegb).not.toBeVisible();
  });

  it("unloads all models through the api and reloads the registry", async () => {
    const { api, store } = renderPanel({
      models: [{ id: "qwen:7b", loaded: true }] as ModelEntry[],
      modelsDir: "/models",
    });
    await store.actions.loadModels();
    const { getByTestId } = render(Modelos, { props: { store } });
    fireEvent.click(getByTestId("lc-unload-all"));
    await waitFor(() => expect(api.calls.unloadAllModels).toBe(1));
    await waitFor(() => expect(api.calls.models).toBe(2));
  });
});