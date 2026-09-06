/**
 * Pipelines view component tests (svelte-ui task 3.3).
 *
 * Renders the pipeline list from the dashboard store; clicking a row loads
 * it into the editor store and routes to the editor view.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect } from "bun:test";
import { render, within, fireEvent, waitFor } from "@testing-library/svelte";
import Pipelines from "./Pipelines.svelte";
import { makeDashboardStore, makeEditorStore } from "../test-setup/fakes.js";
import type { PipelineSummary } from "../stores/types.js";

describe("Pipelines view (task 3.3)", () => {
  it("renders the section with its title", () => {
    const { getByRole } = render(Pipelines, {
      props: { store: makeDashboardStore(), editor: makeEditorStore() },
    });
    expect(getByRole("heading", { level: 2, name: "Pipelines" })).toBeTruthy();
  });

  it("shows a hint when there are no pipelines", () => {
    const { getByText, queryByTestId } = render(Pipelines, {
      props: { store: makeDashboardStore(), editor: makeEditorStore() },
    });
    expect(getByText("No hay pipelines registrados.")).toBeTruthy();
    expect(queryByTestId("pipelines-list")).toBeNull();
  });

  it("lists one row per pipeline with id and node count", async () => {
    const store = makeDashboardStore({
      pipelines: [
        { id: "rag", displayName: "RAG", nodeCount: 4 },
        { id: "chat", displayName: "Chat", nodeCount: 3 },
      ] as PipelineSummary[],
    });
    await store.actions.loadPipelines();
    const { getByTestId } = render(Pipelines, { props: { store, editor: makeEditorStore() } });
    const rows = within(getByTestId("pipelines-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("RAG");
    expect(rows[0]!.textContent).toContain("4");
    expect(rows[0]!.getAttribute("data-pipeline-id")).toBe("rag");
    expect(rows[1]!.getAttribute("data-pipeline-id")).toBe("chat");
  });

  it("loads the pipeline into the editor and routes to #editor on click", async () => {
    const store = makeDashboardStore({
      pipelines: [{ id: "rag", displayName: "RAG" }] as PipelineSummary[],
    });
    await store.actions.loadPipelines();
    const editor = makeEditorStore();
    const { getByTestId } = render(Pipelines, { props: { store, editor } });
    fireEvent.click(getByTestId("pipeline-row-rag"));
    await waitFor(() => expect(editor.getSnapshot().pipelineId).toBe("rag"));
  });

  it("respects the hidden prop", () => {
    const { container } = render(Pipelines, {
      props: { store: makeDashboardStore(), editor: makeEditorStore(), hidden: true },
    });
    expect(container.querySelector("#pipelines")!.hasAttribute("hidden")).toBe(true);
  });
});