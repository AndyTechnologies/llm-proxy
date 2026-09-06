/**
 * Bounded undo/redo history (svelte-ui task 3.5).
 *
 * Framework-free. Each graph mutation pushes the resulting state; undo/redo
 * walk past/future stacks. The history is bounded: only the most recent
 * HISTORY_CAP past states are kept, so long editing sessions cannot grow
 * without limit. The editor store (task 3.4) feeds snapshots on every
 * mutation (add/move/delete/connect/reorder) and restores them on undo/redo.
 */

/** Maximum number of past states retained by default. */
export const HISTORY_CAP = 100;

export interface History<T> {
  /** Current state — the result of the last push or of undo/redo. */
  readonly present: T;
  /** True when at least one undo step is available. */
  readonly canUndo: boolean;
  /** True when at least one redo step is available. */
  readonly canRedo: boolean;
  /** Record `next` as the new present; drops any redo future. */
  push(next: T): void;
  /** Move back one state; returns the previous present, or null at the start. */
  undo(): T | null;
  /** Move forward one state; returns the reapplied present, or null when
   * there is nothing to redo. */
  redo(): T | null;
  /** Reset to `initial` and drop both stacks. */
  clear(): void;
  /** Replace the current present (clearing stacks) so the history
   * re-anchors at the given state (used after loadPipeline/reset). */
  clear(nextPresent: T): void;
}

export function createHistory<T>(initial: T, cap: number = HISTORY_CAP): History<T> {
  const past: T[] = [];
  const future: T[] = [];
  let present = initial;

  function trim(): void {
    if (past.length > cap) past.splice(0, past.length - cap);
  }

  return {
    get present() {
      return present;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    push(next: T): void {
      past.push(present);
      trim();
      present = next;
      future.length = 0;
    },
    undo(): T | null {
      const previous = past.pop();
      if (previous === undefined) return null;
      future.push(present);
      present = previous;
      return present;
    },
    redo(): T | null {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(present);
      trim();
      present = next;
      return present;
    },
    /** Reset history stacks. When `nextPresent` is provided it also replaces
     * the current present (used by load/reset to re-anchor the history). */
    clear(nextPresent?: T): void {
      past.length = 0;
      future.length = 0;
      present = nextPresent !== undefined ? nextPresent : initial;
    },
  };
}