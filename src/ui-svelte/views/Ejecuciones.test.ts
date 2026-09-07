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
import { render, within, fireEvent, waitFor } from "@testing-library/svelte";
import Ejecuciones from "./Ejecuciones.svelte";
import { createDashboardStore } from "../stores/dashboard-store.js";
import { makeDashboardStore, makeFakeDashboardApi } from "../test-setup/fakes.js";
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

describe("Ejecuciones view (retry wiring, spec scenario 9)", () => {
  function renderWithApi(executions: ExecutionEntry[]) {
    const api = makeFakeDashboardApi({ executions });
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    return { api, store };
  }

  it("shows a retry control only on failed rows with a recorded failed node", async () => {
    const { store } = renderWithApi([
      { id: "ex1", pipelineId: "rag", status: "completed" },
      { id: "ex2", pipelineId: "chat", status: "failed" },
    ] as ExecutionEntry[]);
    store.actions.recordStepFailed("ex2", "n3");
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    const rows = within(getByTestId("executions-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).queryByTestId("retry-step-ex1")).toBeNull();
    expect(within(rows[1]!).getByTestId("retry-step-ex2")).toBeTruthy();
  });

  it("does not render a retry control on a failed row without a recorded node", async () => {
    const { store } = renderWithApi([{ id: "ex2", pipelineId: "chat", status: "failed" }] as ExecutionEntry[]);
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    const rows = within(getByTestId("executions-list")).getAllByRole("listitem");
    expect(within(rows[0]!).queryByTestId("retry-step-ex2")).toBeNull();
  });

  it("retries the failed step through the api and revalidates the list", async () => {
    const { api, store } = renderWithApi([{ id: "ex2", pipelineId: "chat", status: "failed" }] as ExecutionEntry[]);
    store.actions.recordStepFailed("ex2", "n3");
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    fireEvent.click(getByTestId("retry-step-ex2"));
    await waitFor(() => expect(api.calls.retryStep).toBe(1));
    expect(api.lastRetry).toEqual({ executionId: "ex2", nodeId: "n3" });
    await waitFor(() => expect(api.calls.executions).toBe(2));
  });

  it("disables the retry control while the retry is pending", async () => {
    const api = makeFakeDashboardApi({
      executions: [{ id: "ex2", pipelineId: "chat", status: "failed" }] as ExecutionEntry[],
    });
    let release!: () => void;
    api.retryStep = async (_executionId: string, _nodeId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { success: true };
    };
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    store.actions.recordStepFailed("ex2", "n3");
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    const button = getByTestId("retry-step-ex2") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    release();
    await waitFor(() =>
      expect((getByTestId("retry-step-ex2") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("surfaces the retry error next to the failed row", async () => {
    const api = makeFakeDashboardApi({
      executions: [{ id: "ex2", pipelineId: "chat", status: "failed" }] as ExecutionEntry[],
    });
    api.retryStep = async (_executionId: string, _nodeId: string) => {
      throw new Error("boom");
    };
    const store = createDashboardStore({ api, refreshWindowMs: 50 });
    store.actions.recordStepFailed("ex2", "n3");
    await store.actions.loadExecutions();
    const { getByTestId } = render(Ejecuciones, { props: { store } });
    fireEvent.click(getByTestId("retry-step-ex2"));
    await waitFor(() => expect(getByTestId("retry-error-ex2")).toBeTruthy());
    expect(getByTestId("retry-error-ex2").textContent).toMatch(/boom/);
  });
});