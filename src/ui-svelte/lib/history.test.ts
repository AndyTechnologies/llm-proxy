/**
 * Bounded undo/redo history tests (svelte-ui task 3.5, RED).
 *
 * The spec scenario "Undo restores, redo reapplies" is exercised with real
 * graph-model shapes: deleting a node pushes the post-delete state, undo
 * restores the node + its edges, redo reapplies the deletion.
 */
import { describe, it, expect } from "bun:test";
import { createHistory, HISTORY_CAP } from "./history.js";
import type { GraphNode, GraphEdge } from "./graph-model.js";

// Real graph-model shapes for the spec scenario.
const NODE_A: GraphNode = { id: "a", type: "start" };
const NODE_B: GraphNode = { id: "b", type: "llm_call" };
const EDGE: GraphEdge = { from: "a", to: "b" };

interface GraphFixture {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

describe("history (task 3.5)", () => {
  it("undo walks back through pushed states in LIFO order", () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.canUndo).toBe(true);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  it("redo re-applies states that were undone, in order", () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    expect(h.undo()).toBe(1);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(2);
    expect(h.redo()).toBeNull();
    expect(h.canRedo).toBe(false);
  });

  it("pushing after an undo clears the redo future", () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    h.undo();
    h.push(9);
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe(1);
  });

  it("bounded: only HISTORY_CAP past states survive, oldest dropped", () => {
    const h = createHistory(0);
    for (let i = 1; i <= HISTORY_CAP + 5; i++) h.push(i);
    expect(h.canUndo).toBe(true);
    // Only the last HISTORY_CAP pushes are recoverable: undoing walks
    // present back through 104..5; the four oldest states are dropped.
    const recovered: number[] = [];
    let next: number | null;
    while ((next = h.undo()) !== null) recovered.push(next);
    expect(recovered).toHaveLength(HISTORY_CAP);
    expect(recovered[0]).toBe(104);
    expect(recovered[recovered.length - 1]).toBe(5);
  });

  it("spec: undo restores a deleted node and its edges, redo reapplies the deletion", () => {
    const h = createHistory<GraphFixture>({ nodes: [], edges: [] });
    const withNode: GraphFixture = { nodes: [NODE_A, NODE_B], edges: [EDGE] };
    const afterDelete: GraphFixture = { nodes: [NODE_A], edges: [] };
    h.push(withNode);
    h.push(afterDelete);

    const restored = h.undo();
    expect(restored?.nodes).toEqual([NODE_A, NODE_B]);
    expect(restored?.edges).toEqual([EDGE]);

    const reapplied = h.redo();
    expect(reapplied?.nodes).toEqual([NODE_A]);
    expect(reapplied?.edges).toEqual([]);
  });

  it("clear resets present state and drops both stacks", () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    h.undo();
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });
});