/**
 * RED→GREEN component tests for the editor interaction set (svelte-ui task
 * 3.4): declarative SVG graph, palette drag/click, keys 1–6, Delete, select,
 * node drag with a single history entry, 24 px socket connect with self-edge
 * rejection, loop containers (bucket, add-block, member reorder), carousel
 * and the Ver flujo flow animation.
 *
 * jsdom gives every element a zero getBoundingClientRect, so with the default
 * view (zoom 1, pan 0) client coordinates equal graph coordinates — synthetic
 * pointer/wheel events can target known socket positions directly. Pointer
 * events are provided by the test-setup polyfill (dom.ts).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import Editor from "./Editor.svelte";
import { makeEditorStore } from "../test-setup/fakes.js";
import type { GraphNode } from "../lib/graph-model.js";

/** DataTransfer stand-in: jsdom does not implement the HTML5 DnD API. */
class MemDataTransfer {
  private data = new Map<string, string>();
  setData(k: string, v: string): void {
    this.data.set(k, v);
  }
  getData(k: string): string {
    return this.data.get(k) ?? "";
  }
}

/**
 * jsdom's fireEvent drops the coordinate init for pointer events (the browser
 * API it maps to ignores unknown fields), so pointer interactions dispatch
 * native events through the test-setup PointerEvent polyfill instead.
 */
function pointer(el: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, id = 1): void {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: id,
    buttons: type === "pointerup" ? 0 : 1,
  });
  el.dispatchEvent(ev);
}

/** Render the editor with a pre-loaded pipeline (await load BEFORE render
 *  keeps the first paint deterministic). */
async function renderWith(nodes: GraphNode[], edges: { from: string; to: string; guard?: string }[] = []) {
  const store = makeEditorStore({
    pipeline: { id: "p1", name: "Demo", nodes, edges } as never,
  });
  await store.actions.loadPipeline("p1");
  const view = render(Editor, { props: { store } });
  return { store, ...view };
}

const start = { id: "start", type: "start" as const, pos: { x: 40, y: 40 } };
const call = { id: "call", type: "llm_call" as const, pos: { x: 400, y: 40 }, model: "qwen:7b", prompt: "" };
const endUsed = { id: "end", type: "end" as const, pos: { x: 760, y: 40 } };

describe("Editor interactions (task 3.4)", () => {
  afterEach(() => {
    // the reduced-motion test stubs matchMedia; restore the original
    (window as { matchMedia?: unknown }).matchMedia = globalThis.matchMedia as unknown as typeof window.matchMedia;
  });

  it("renders loaded nodes as SVG graph nodes with ports", async () => {
    const { container } = await renderWith([start, call]);
    const svg = container.querySelector("#graph-svg");
    expect(svg).toBeTruthy();
    expect(svg!.querySelectorAll('.graph-node[data-type="start"]')).toHaveLength(1);
    expect(svg!.querySelectorAll('.graph-node[data-type="llm_call"]')).toHaveLength(1);
    const node = svg!.querySelector('.graph-node[data-type="start"]')!;
    expect(node.querySelector(".port--output")).toBeTruthy();
    expect(node.querySelector(".port--input")).toBeTruthy();
  });

  it("renders conditional outputs with their guards", async () => {
    const cond = { id: "c", type: "condition" as const, pos: { x: 40, y: 200 } };
    const { container } = await renderWith([cond]);
    const outputs = container.querySelectorAll('.graph-node[data-type="condition"] .port--output');
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.getAttribute("data-guard")).toBe("true");
    expect(outputs[1]!.getAttribute("data-guard")).toBe("false");
  });

  it("renders edges as bezier paths", async () => {
    const { container } = await renderWith([start, call], [{ from: "start", to: "call" }]);
    const edges = container.querySelectorAll("#graph-svg .graph-edge");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.getAttribute("d")).toContain("C");
  });

  it("adds nodes with the numeric keys 1-6", async () => {
    const store = makeEditorStore();
    const { getByTestId } = render(Editor, { props: { store } });
    const canvas = getByTestId("graph-canvas");
    fireEvent.keyDown(canvas, { key: "2" });
    fireEvent.keyDown(canvas, { key: "4" });
    await waitFor(() => expect(store.getSnapshot().nodes.map((n) => n.type)).toEqual(["llm_call", "loop"]));
  });

  it("deletes the selected node on Delete", async () => {
    const { store, getByTestId, container } = await renderWith([start]);
    const canvas = getByTestId("graph-canvas");
    expect(store.getSnapshot().nodes).toHaveLength(1);
    const node = container.querySelector('.graph-node[data-type="start"]')!;
    pointer(node, "pointerdown", 100, 80);
    pointer(window, "pointerup", 100, 80);
    await waitFor(() => expect(store.getSnapshot().selection).toEqual(["start"]));
    fireEvent.keyDown(canvas, { key: "Delete" });
    await waitFor(() => expect(store.getSnapshot().nodes).toHaveLength(0));
  });

  it("selects a node when clicked and clears on background", async () => {
    const { store, container } = await renderWith([start, call]);
    const node = container.querySelector('.graph-node[data-type="start"]')!;
    pointer(node, "pointerdown", 100, 80);
    pointer(window, "pointerup", 100, 80);
    await waitFor(() => expect(store.getSnapshot().selection).toEqual(["start"]));

    const bg = container.querySelector('[data-testid="canvas-background"]')!;
    pointer(bg, "pointerdown", 5, 5, 2);
    pointer(window, "pointerup", 5, 5, 2);
    await waitFor(() => expect(store.getSnapshot().selection).toEqual([]));
  });

  it("drops a palette item onto the canvas to insert a node at that position", async () => {
    const { store, getAllByTestId, getByTestId } = await renderWith([]);
    const dt = new MemDataTransfer();
    const item = getAllByTestId("palette-item").find(
      (el) => el.getAttribute("data-node-type") === "llm_call",
    )!;
    fireEvent.dragStart(item, { dataTransfer: dt });
    // jsdom zeroes the drop's clientX/clientY; the component falls back to
    // the last pointer position, so move the pointer to the drop target first
    // (a browser always delivers drag moves before the drop).
    pointer(window, "pointermove", 300, 200);
    fireEvent.drop(getByTestId("graph-canvas"), { dataTransfer: dt, clientX: 300, clientY: 200 });
    await waitFor(() => expect(store.getSnapshot().nodes).toHaveLength(1));
    expect(store.getSnapshot().nodes[0]!.type).toBe("llm_call");
    expect(store.getSnapshot().nodes[0]!.pos).toEqual({ x: 300, y: 200 });
  });

  it("connects output→input ports within the 24 px hit radius", async () => {
    const { store, container } = await renderWith([start, call]);
    const out = container.querySelector('.graph-node[data-type="start"] .port--output')!;
    // start out socket = (200, 68); move to call in socket (400, 68)
    pointer(out, "pointerdown", 200, 68);
    pointer(window, "pointermove", 300, 68);
    pointer(window, "pointerup", 400, 68);
    await waitFor(() => expect(store.getSnapshot().edges).toHaveLength(1));
    expect(store.getSnapshot().edges[0]).toMatchObject({ from: "start", to: "call" });
  });

  it("rejects a self-loop connection without invalid styling", async () => {
    const { store, container } = await renderWith([start, call]);
    const out = container.querySelector('.graph-node[data-type="start"] .port--output')!;
    const input = container.querySelector('.graph-node[data-type="start"] .port--input')!;
    pointer(out, "pointerdown", 200, 68);
    pointer(window, "pointermove", 100, 68);
    expect(input).toBeTruthy(); // own input socket exists
    pointer(window, "pointerup", 40, 68); // own input (40, 68)
    await waitFor(() => expect(store.getSnapshot().edges).toHaveLength(0));
    expect(container.querySelectorAll("#graph-svg .graph-edge")).toHaveLength(0);
    expect(container.querySelectorAll(".graph-node.edge-invalid")).toHaveLength(0);
  });

  it("connects a condition's false branch with its guard", async () => {
    const cond = { id: "c", type: "condition" as const, pos: { x: 40, y: 200 } };
    const { store, container } = await renderWith([cond, call]);
    const outFalse = container.querySelector('.port--output[data-guard="false"]')!;
    pointer(outFalse, "pointerdown", 200, 228);
    pointer(window, "pointerup", 400, 68);
    await waitFor(() => expect(store.getSnapshot().edges).toHaveLength(1));
    expect(store.getSnapshot().edges[0]).toMatchObject({ from: "c", to: "call", guard: "false" });
  });

  it("drags a node as ONE undoable history entry", async () => {
    const { store, container, getByTestId } = await renderWith([start]);
    const node = container.querySelector('.graph-node[data-type="start"]')!;
    pointer(node, "pointerdown", 100, 80);
    pointer(window, "pointermove", 140, 110);
    pointer(window, "pointerup", 140, 110);
    await waitFor(() => expect(store.getSnapshot().nodes[0]!.pos).toEqual({ x: 80, y: 70 }));
    expect(getByTestId("btn-undo")).toBeEnabled();

    fireEvent.click(getByTestId("btn-undo"));
    // undo restores the exact pre-drag position (history pops to prior state)
    await waitFor(() => expect(store.getSnapshot().nodes[0]!.pos).toEqual({ x: 40, y: 40 }));
    expect(store.getSnapshot().canRedo).toBe(true);
  });

  it("unmounts cleanly with a frame pending (rAF or timer fallback)", async () => {
    const { store, container, unmount } = await renderWith([start]);
    const node = container.querySelector('.graph-node[data-type="start"]')!;
    pointer(node, "pointerdown", 100, 80);
    pointer(window, "pointermove", 140, 110);
    await waitFor(() => expect(store.getSnapshot().nodes[0]!.pos).toEqual({ x: 80, y: 70 }));
    expect(() => unmount()).not.toThrow();
  });

  it("pans the viewport when dragging the background", async () => {
    const { container } = await renderWith([start]);
    const bg = container.querySelector('[data-testid="canvas-background"]')!;
    const viewport = container.querySelector('[data-testid="viewport"]')!;
    expect(viewport.getAttribute("transform")).toContain("translate(0 0)");
    pointer(bg, "pointerdown", 10, 10);
    pointer(window, "pointermove", 40, 30);
    pointer(window, "pointerup", 40, 30);
    await waitFor(() =>
      expect(viewport.getAttribute("transform")).toContain("translate(30 20)"),
    );
  });

  it("zooms at the cursor and clamps between 0.2 and 3", async () => {
    const { container, getByTestId } = await renderWith([start]);
    const canvas = getByTestId("graph-canvas");
    const viewport = container.querySelector('[data-testid="viewport"]')!;
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    await waitFor(() => expect(viewport.getAttribute("transform")).toContain("scale(1.1)"));
    // zoom-out clamp
    for (let i = 0; i < 40; i++) {
      fireEvent.wheel(canvas, { deltaY: 100, clientX: 300, clientY: 200 });
    }
    await waitFor(() => expect(viewport.getAttribute("transform")).toContain("scale(0.2)"));
    // zoom-in clamp
    for (let i = 0; i < 60; i++) {
      fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
    }
    await waitFor(() => expect(viewport.getAttribute("transform")).toContain("scale(3)"));
  });

  it("renders a loop container with its add-block button", async () => {
    const loop = { id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: ["m1", "m2"] };
    const m1 = { id: "m1", type: "llm_call" as const, pos: { x: 0, y: 70 }, model: "a", prompt: "" };
    const m2 = { id: "m2", type: "llm_call" as const, pos: { x: 0, y: 140 }, model: "b", prompt: "" };
    const { container } = await renderWith([loop, m1, m2]);
    const group = container.querySelector('.loop-container-group[data-id="loop"]');
    expect(group).toBeTruthy();
    expect(group!.textContent).toContain("2 bloque");
    expect(group!.querySelector(".loop-add")).toBeTruthy();
    // members stay in the SVG as graph nodes (stacked under the header)
    expect(container.querySelectorAll('#graph-svg .graph-node[data-type="llm_call"]')).toHaveLength(2);
  });

  it("adds a block from the loop's button as a bucketed member", async () => {
    const loop = { id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: [] as string[] };
    const { store, container } = await renderWith([loop]);
    const add = container.querySelector(".loop-add") as HTMLElement;
    fireEvent.click(add);
    await waitFor(() =>
      expect(store.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toHaveLength(1),
    );
  });

  it("reorders a loop member with its in-canvas arrows", async () => {
    const loop = { id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: ["m1", "m2"] };
    const m1 = { id: "m1", type: "llm_call" as const, pos: { x: 0, y: 70 }, model: "a", prompt: "" };
    const m2 = { id: "m2", type: "llm_call" as const, pos: { x: 0, y: 140 }, model: "b", prompt: "" };
    const { store, container } = await renderWith([loop, m1, m2]);
    const up = container.querySelector('[data-testid="member-move-up"][data-node-id="m2"]')!;
    fireEvent.click(up);
    await waitFor(() =>
      expect(store.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toEqual(["m2", "m1"]),
    );
  });

  it("lists nodes in the carousel and selects from a chip", async () => {
    const { store, container } = await renderWith([start, call]);
    const switcher = container.querySelector("#node-switcher");
    expect(switcher).toBeTruthy();
    const chips = switcher!.querySelectorAll(".node-chip");
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]!);
    await waitFor(() => expect(store.getSnapshot().selection).toEqual(["call"]));
  });

  it("highlights flow steps in order on Ver flujo", async () => {
    const { container, getByTestId } = await renderWith(
      [start, call, endUsed],
      [{ from: "start", to: "call" }, { from: "call", to: "end" }],
    );
    fireEvent.click(getByTestId("btn-flow"));
    const startNode = container.querySelector('.graph-node[data-type="start"]')!;
    await waitFor(() => expect(startNode.classList.contains("flow-active")).toBe(true), {
      timeout: 1200,
    });
  });

  it("reveals the flow statically when reduced motion is preferred", async () => {
    const reduced = {
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    };
    (window as { matchMedia?: unknown }).matchMedia = (() => reduced) as unknown as typeof window.matchMedia;
    const { container, getByTestId } = await renderWith(
      [start, call],
      [{ from: "start", to: "call" }],
    );
    fireEvent.click(getByTestId("btn-flow"));
    const startNode = container.querySelector('.graph-node[data-type="start"]')!;
    const callNode = container.querySelector('.graph-node[data-type="llm_call"]')!;
    // no animation: every step is revealed immediately as flow-past
    await waitFor(() => expect(startNode.classList.contains("flow-past")).toBe(true));
    expect(callNode.classList.contains("flow-past")).toBe(true);
  });

  it("exposes the legacy toolbar buttons Nuevo, Ver flujo and Limpiar", async () => {
    const { getByTestId, getByLabelText } = await renderWith([]);
    expect(getByTestId("btn-new")).toBeTruthy();
    expect(getByTestId("btn-flow")).toBeTruthy();
    expect(getByTestId("btn-clear")).toBeTruthy();
    expect(getByLabelText("Nombre del pipeline")).toBeTruthy();
  });
});