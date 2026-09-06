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
import { render, within } from "@testing-library/svelte";
import Agentes from "./Agentes.svelte";
import { makeDashboardStore } from "../test-setup/fakes.js";
import type { AgentEntry } from "../stores/types.js";

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