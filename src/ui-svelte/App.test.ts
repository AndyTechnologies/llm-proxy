/**
 * App shell + hash-routing component tests (svelte-ui task 3.3).
 *
 * The App is the composition root: it creates the store layer through
 * injected factories (fakes here), starts/tears down the SSE service, and
 * renders the a11y shell (skip link, banner, Spanish nav) around the five
 * hash-routed views. The static header/nav of the placeholder build moved
 * INTO this component — this test pins the a11y contract that supersedes it.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { render, within, waitFor, fireEvent } from "@testing-library/svelte";
import App from "./App.svelte";
import { makeAppDeps } from "./test-setup/fakes.js";
import type { PipelineSummary, ModelEntry, ExecutionEntry, AgentEntry } from "./stores/types.js";

const DATA = {
  pipelines: [
    { id: "rag", displayName: "RAG", nodeCount: 4 },
    { id: "chat", displayName: "Chat", nodeCount: 3 },
  ] as PipelineSummary[],
  models: [
    { id: "qwen2.5:7b", loaded: true, processLoaded: true, ctx: 8192 },
    { id: "llama3.2:3b", loaded: true, ctx: 4096 },
    { id: "mistral:7b" },
  ] as ModelEntry[],
  executions: [{ id: "ex1", pipelineId: "rag", status: "completed", totalLatencyMs: 1234 }] as ExecutionEntry[],
  agents: [
    { id: "opencode", label: "OpenCode", configPath: "~/.config/opencode/opencode.json", providerPresent: true, modelCount: 2 },
  ] as AgentEntry[],
};

afterEach(() => {
  window.location.hash = "";
});

function renderApp() {
  const fakes = makeAppDeps(DATA);
  const utils = render(App, { props: { deps: fakes.deps } });
  return { ...utils, ...fakes };
}

describe("App shell (task 3.3)", () => {
  it("renders skip link, banner title and Spanish nav with the five views", () => {
    const { getByText, getByRole } = renderApp();
    expect(getByText("Saltar al contenido principal")).toHaveAttribute("href", "#main");
    const banner = getByRole("banner");
    expect(within(banner).getByRole("heading", { level: 1, name: "llm-proxy" })).toBeTruthy();
    const nav = within(banner).getByRole("navigation", { name: "Principal" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("data-view"))).toEqual([
      "editor",
      "pipelines",
      "models",
      "executions",
      "agents",
    ]);
    expect(links.map((l) => l.textContent)).toEqual(["Editor", "Pipelines", "Modelos", "Ejecuciones", "Agentes"]);
  });

  it("marks the active view link with aria-current", () => {
    const { getByRole } = renderApp();
    expect(getByRole("link", { name: "Editor" })).toHaveAttribute("aria-current", "true");
    expect(getByRole("link", { name: "Modelos" }).getAttribute("aria-current")).toBeNull();
  });

  it("shows only the editor view initially", () => {
    const { getByTestId } = renderApp();
    expect(getByTestId("view-editor")).toBeVisible();
    expect(getByTestId("view-pipelines")).not.toBeVisible();
    expect(getByTestId("view-models")).not.toBeVisible();
  });

  it("switches views on hash navigation and moves aria-current", async () => {
    const { getByRole, getByTestId } = renderApp();
    fireEvent.click(getByRole("link", { name: "Modelos" }));
    window.location.hash = "#models";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    // Svelte flushes the hidden-attr update in a microtask after dispatch.
    await waitFor(() => expect(getByTestId("view-models")).toBeVisible());
    expect(getByTestId("view-editor")).not.toBeVisible();
    expect(getByRole("link", { name: "Modelos" })).toHaveAttribute("aria-current", "true");
    expect(getByRole("link", { name: "Editor" }).getAttribute("aria-current")).toBeNull();
  });

  it("boots: refreshAll fired and trace records the boot", async () => {
    const f = renderApp();
    await waitFor(() => expect(f.dashboardApi.calls.pipelines).toBe(1));
    expect(f.dashboardApi.calls.models).toBe(1);
    expect(f.dashboardApi.calls.executions).toBe(1);
    expect(f.dashboardApi.calls.agents).toBe(1);
    expect(f.dashboardApi.calls.config).toBe(1);
    expect(f.stores!.trace.getEntries().some((t) => t.message === "boot")).toBe(true);
  });

  it("starts SSE on mount and stops it on destroy", () => {
    const f = renderApp();
    expect(f.sse!.getState()).toBe("connected");
    f.unmount();
    expect(f.sse!.getState()).toBe("disconnected");
    expect(f.sources.every((s) => s.closed === true)).toBe(true);
  });

  it("surfaces the SSE connection state in a polite status region", async () => {
    const { getByRole } = renderApp();
    const status = getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("En línea"));
  });

  it("funnels SSE events into a single throttled refresh per domain", async () => {
    const f = renderApp();
    await waitFor(() => expect(f.dashboardApi.calls.executions).toBe(1));
    const before = f.dashboardApi.calls.executions;
    f.sources[0]!.emit("execution:started", { executionId: "ex2", pipelineId: "rag" });
    f.sources[0]!.emit("step:completed", { executionId: "ex2", nodeId: "n1" });
    f.sources[0]!.emit("execution:completed", { executionId: "ex2" });
    await waitFor(() => expect(f.dashboardApi.calls.executions).toBe(before + 1));
    expect(f.stores!.trace.getEntries().some((t) => t.kind === "sse")).toBe(true);
  });
});

describe("App trace panel (spec scenario 11)", () => {
  it("renders the trace log with boot entries", async () => {
    const f = renderApp();
    await waitFor(() => expect(f.stores!.trace.getEntries().some((t) => t.message === "boot")).toBe(true));
    const panel = f.getByTestId("trace-panel");
    expect(within(panel).getByTestId("trace-list")).toBeTruthy();
    expect(within(panel).getByText("boot")).toBeTruthy();
  });

  it("toggles the trace panel open and closed from the header control", async () => {
    const f = renderApp();
    await waitFor(() => expect(f.getByTestId("trace-list")).toBeTruthy());
    fireEvent.click(f.getByTestId("trace-toggle"));
    await waitFor(() => expect(f.queryByTestId("trace-list")).toBeNull());
    fireEvent.click(f.getByTestId("trace-toggle"));
    await waitFor(() => expect(f.getByTestId("trace-list")).toBeTruthy());
  });

  it("verbose mode reveals entry details", async () => {
    const f = renderApp();
    await waitFor(() => expect(f.getByTestId("trace-list")).toBeTruthy());
    f.stores!.trace.log("fetch", "models:ok", { status: 200, ms: 12 });
    await waitFor(() => expect(f.getByText("models:ok")).toBeTruthy());
    expect(f.queryByTestId("trace-detail")).toBeNull();
    fireEvent.click(f.getByTestId("trace-verbose"));
    await waitFor(() => expect(f.getByTestId("trace-detail")).toBeTruthy());
    expect(f.getByTestId("trace-detail").textContent).toContain("200");
  });

  it("feeds step:failed into the dashboard store (retry data path)", async () => {
    const f = renderApp();
    f.sources[0]!.emit("step:failed", { executionId: "ex2", nodeId: "n3" });
    await waitFor(() => expect(f.stores!.dashboard.getSnapshot().failedNodes).toEqual({ ex2: "n3" }));
  });
});