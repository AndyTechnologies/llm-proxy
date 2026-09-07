/**
 * Agentes view component tests (svelte-ui task 3.3).
 *
 * Renders the agent status rows (OpenCode, Pi) from the dashboard store.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect } from "bun:test";
import { render, within, fireEvent, waitFor } from "@testing-library/svelte";
import Agentes from "./Agentes.svelte";
import { makeDashboardStore, makeFakeDashboardApi } from "../test-setup/fakes.js";
import { createDashboardStore } from "../stores/dashboard-store.js";
import type { AgentEntry } from "../stores/types.js";

const opencode: AgentEntry = {
  id: "opencode",
  label: "OpenCode",
  configPath: "~/.config/opencode/opencode.json",
  providerPresent: false,
  modelCount: 0,
};

describe("Agentes view (task 3.3)", () => {
  it("renders the section with its title", () => {
    const { getByRole } = render(Agentes, { props: { store: makeDashboardStore() } });
    expect(getByRole("heading", { level: 2, name: "Agentes" })).toBeTruthy();
  });

  it("explains how agents are configured when none are present", () => {
    const { getByText } = render(Agentes, { props: { store: makeDashboardStore() } });
    expect(getByText(/Configurá tus agentes/i)).toBeTruthy();
  });

  it("lists one row per agent with provider and model count", async () => {
    const store = makeDashboardStore({
      agents: [
        {
          id: "opencode",
          label: "OpenCode",
          configPath: "~/.config/opencode/opencode.json",
          providerPresent: true,
          modelCount: 2,
        },
        {
          id: "pi",
          label: "Pi",
          configPath: "pi/config.json",
          providerPresent: false,
          modelCount: 0,
        },
      ] as AgentEntry[],
    });
    await store.actions.loadAgents();
    const { getByTestId } = render(Agentes, { props: { store } });
    const rows = within(getByTestId("agents-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("OpenCode");
    expect(rows[0]!.textContent).toContain("2");
    expect(rows[0]!.textContent).toContain("proveedor presente");
    expect(rows[1]!.textContent).toContain("Pi");
    expect(rows[1]!.textContent).not.toContain("proveedor presente");
  });

  it("respects the hidden prop", () => {
    const { container } = render(Agentes, {
      props: { store: makeDashboardStore(), hidden: true },
    });
    expect(container.querySelector("#agents")!.hasAttribute("hidden")).toBe(true);
  });
});

describe("Agentes view (configure action, task 3.6)", () => {
  it("renders a Configurar button per agent row", async () => {
    const store = makeDashboardStore({
      agents: [
        opencode,
        { id: "pi", label: "Pi", configPath: "pi/config.json", providerPresent: false, modelCount: 0 },
      ] as AgentEntry[],
    });
    await store.actions.loadAgents();
    const { getAllByTestId } = render(Agentes, { props: { store } });
    const buttons = getAllByTestId("agent-configure");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute("data-agent-id")).toBe("opencode");
    expect(buttons[0]!.textContent).toBe("Configurar");
  });

  it("calls the configure api with the agent id and disables the button while pending", async () => {
    const api = makeFakeDashboardApi({ agents: [opencode] });
    let release!: () => void;
    api.configureAgent = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, requiresRestart: true });
      });
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    await store.actions.loadAgents();
    const { getByTestId, getByText } = render(Agentes, { props: { store } });
    const button = getByTestId("agent-configure") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(getByText("configurando…")).toBeTruthy();
    release();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe("Configurar");
  });

  it("reloads the agent rows after a successful configure", async () => {
    const data = { agents: [opencode] };
    const api = makeFakeDashboardApi(data);
    api.configureAgent = async () => {
      data.agents = [{ ...opencode, providerPresent: true, modelCount: 3 }];
      return { ok: true, requiresRestart: true };
    };
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    await store.actions.loadAgents();
    expect(api.calls.agents).toBe(1);
    const { getByTestId } = render(Agentes, { props: { store } });
    fireEvent.click(getByTestId("agent-configure"));
    await waitFor(() => expect(api.calls.agents).toBe(2));
    const row = getByTestId("agents-list").querySelector('[data-agent-id="opencode"]')!;
    await waitFor(() => expect(row.textContent).toContain("3"));
    expect(row.textContent).toContain("proveedor presente");
  });

  it("shows the inline error when configure fails", async () => {
    const api = makeFakeDashboardApi({ agents: [opencode] });
    api.configureAgent = async () => {
      throw new Error("El token Bearer no es válido.");
    };
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    await store.actions.loadAgents();
    const { getByTestId } = render(Agentes, { props: { store } });
    fireEvent.click(getByTestId("agent-configure"));
    await waitFor(() => expect(getByTestId("agent-configure-error")).toBeTruthy());
    expect(getByTestId("agent-configure-error").textContent).toMatch(/token Bearer/);
    const button = getByTestId("agent-configure") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});