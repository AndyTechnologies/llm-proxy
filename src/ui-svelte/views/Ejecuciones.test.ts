/**
 * Ejecuciones (executions) view component tests (svelte-ui task 3.3).
 *
 * Renders the execution history rows; the failed-execution retry action
 * lands with task 3.6.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect } from "bun:test";
import { render, within } from "@testing-library/svelte";
import Ejecuciones from "./Ejecuciones.svelte";
import { makeDashboardStore } from "../test-setup/fakes.js";
import type { ExecutionEntry } from "../stores/types.js";

describe("Ejecuciones view (task 3.3)", () => {
  it("renders the section with its title", () => {
    const { getByRole } = render(Ejecuciones, { props: { store: makeDashboardStore() } });
    expect(getByRole("heading", { level: 2, name: "Ejecuciones" })).toBeTruthy();
  });

  it("shows a hint when there are no executions", () => {
    const { getByText } = render(Ejecuciones, { props: { store: makeDashboardStore() } });
    expect(getByText(/No hay ejecuciones/i)).toBeTruthy();
  });

  it("lists one row per execution with pipeline, status and latency", async () => {
    const store = makeDashboardStore({
      executions: [
        { id: "ex1", pipelineId: "rag", status: "completed", totalLatencyMs: 1234 },
        { id: "ex2", pipelineId: "chat", status: "failed", totalLatencyMs: 987 },
      ] as ExecutionEntry[],
    });
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    const rows = within(getByTestId("executions-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("rag");
    expect(rows[0]!.textContent).toContain("completed");
    expect(rows[0]!.textContent).toContain("1234 ms");
    expect(rows[1]!.textContent).toContain("failed");
  });

  it("respects the hidden prop", () => {
    const { container } = render(Ejecuciones, {
      props: { store: makeDashboardStore(), hidden: true },
    });
    expect(container.querySelector("#executions")!.hasAttribute("hidden")).toBe(true);
  });
});