/**
 * Editor view component tests (svelte-ui task 3.3).
 *
 * Locks the editor shell contract: 6-node palette, focusable canvas,
 * toolbar (undo/redo/validate/apply) and the native validate/apply dialogs.
 * Palette clicks add nodes through the editor store; interactions (drag,
 * keys, connect, zoom) build on this in task 3.4 and history in 3.5.
 *
 * Queries come from `render(...)` (container-bound) rather than the global
 * `screen` — bun test evaluates helper modules in a shared cache, so
 * screen's module-eval-time binding can race the jsdom preload.
 */
import { describe, it, expect } from "bun:test";
import { render, within, fireEvent, waitFor } from "@testing-library/svelte";
import Editor from "./Editor.svelte";
import { makeEditorStore } from "../test-setup/fakes.js";

const PALETTE_TYPES = ["start", "llm_call", "condition", "loop", "pipeline", "end"];

describe("Editor view (task 3.3)", () => {
  it("renders the section with its title", () => {
    const { getByRole } = render(Editor, { props: { store: makeEditorStore() } });
    // Legacy layout: the editor section is a labelled region; the only
    // heading inside is the palette's secondary "Paleta de nodos".
    expect(getByRole("region", { name: "Editor de pipelines" })).toBeTruthy();
    expect(getByRole("heading", { level: 2, name: "Paleta de nodos" })).toBeTruthy();
  });

  it("exposes the six node types with keys 1-6 in the palette", () => {
    const { getByTestId } = render(Editor, { props: { store: makeEditorStore() } });
    const items = within(getByTestId("palette-list")).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    items.forEach((item, i) => {
      const button = item.querySelector("button");
      expect(button!.getAttribute("data-node-type")).toBe(PALETTE_TYPES[i]);
      expect(button!.getAttribute("data-key")).toBe(String(i + 1));
    });
  });

  it("renders a focusable graph canvas", () => {
    const { getByTestId } = render(Editor, { props: { store: makeEditorStore() } });
    const canvas = getByTestId("graph-canvas");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("aria-label")).toBeTruthy();
  });

  it("renders the toolbar with undo/redo disabled and validate/apply enabled", () => {
    const { getByTestId } = render(Editor, { props: { store: makeEditorStore() } });
    expect(getByTestId("btn-undo")).toBeDisabled();
    expect(getByTestId("btn-redo")).toBeDisabled();
    expect(getByTestId("btn-validate")).toHaveTextContent("Validar");
    expect(getByTestId("btn-apply")).toBeTruthy();
  });

  it("adds a node through the editor store when a palette item is clicked", () => {
    const store = makeEditorStore();
    const { getAllByTestId } = render(Editor, { props: { store } });
    const items = getAllByTestId("palette-item");
    const condition = items.find((item) => item.getAttribute("data-node-type") === "condition");
    fireEvent.click(condition!);
    const state = store.getSnapshot();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]!.type).toBe("condition");
    expect(state.dirty).toBe(true);
  });

  it("opens the validate dialog and reports a valid graph", async () => {
    const store = makeEditorStore({ validate: { valid: true } });
    const { getByTestId, findByTestId } = render(Editor, { props: { store } });
    fireEvent.click(getByTestId("btn-validate"));
    // The dialog element is always in the DOM; validation is async, so wait
    // for it to actually open (runValidate awaits the store's validate before
    // showModal). Without this, the assertions race the resolved validation.
    const dialog = await findByTestId("validate-dialog");
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    expect(within(dialog).getByText(/El pipeline es válido/)).toBeTruthy();
    expect(within(dialog).queryAllByTestId("validation-error")).toHaveLength(0);
  });

  it("lists each error on an invalid graph", async () => {
    const store = makeEditorStore({
      validate: { valid: false, errors: ["Falta el nodo de inicio", "Conexión inválida"] },
    });
    const { getByTestId, findByTestId } = render(Editor, { props: { store } });
    fireEvent.click(getByTestId("btn-validate"));
    const dialog = await findByTestId("validate-dialog");
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    const errors = within(dialog).getAllByTestId("validation-error");
    expect(errors).toHaveLength(2);
    expect(errors[0]!.textContent).toContain("Falta el nodo de inicio");
  });

  it("applies the pipeline from the apply dialog and closes it", async () => {
    const store = makeEditorStore();
    const { getByTestId, findByTestId } = render(Editor, { props: { store } });
    fireEvent.click(getByTestId("btn-apply"));
    const dialog = await findByTestId("apply-dialog");
    expect(dialog.hasAttribute("open")).toBe(true);
    fireEvent.click(within(dialog).getByTestId("btn-confirm-apply"));
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
    expect(store.getSnapshot().applyError).toBeNull();
  });

  it("respects the hidden prop", () => {
    const { container } = render(Editor, {
      props: { store: makeEditorStore(), hidden: true },
    });
    expect(container.querySelector("#editor")!.hasAttribute("hidden")).toBe(true);
  });
});