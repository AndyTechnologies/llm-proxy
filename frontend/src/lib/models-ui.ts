/**
 * Pure display helpers for the models registry surface (U08).
 *
 * Deterministic and unit-tested in models-ui.test.ts. No IO, no Svelte
 * imports: importable under bun:test. Every value derives from the
 * ModelStatus[] rows the backend actually serves (src/backend/hub.ts —
 * state is exactly "active" | "disabled" | "error", plus optional
 * pid/port/error). Nothing here invents telemetry: there is no GPU/VRAM/
 * throughput data anywhere in the real surface, so none is rendered.
 */

import type { ModelStatus } from "./api/types.js";

/** Registry state means exactly the three real hub states. */
export type ModelState = ModelStatus["state"];

/** Counts over a registry snapshot — total and per-state buckets. */
export interface ModelCounts {
  total: number;
  active: number;
  disabled: number;
  error: number;
}

/**
 * Count the registry by state. Every bucket derives from the rows verbatim;
 * an empty registry maps to all-zero counts (the honest "No models" case).
 */
export function summarizeModels(models: readonly ModelStatus[]): ModelCounts {
  const counts: ModelCounts = { total: models.length, active: 0, disabled: 0, error: 0 };
  for (const model of models) {
    if (model.state === "active") {
      counts.active += 1;
    } else if (model.state === "disabled") {
      counts.disabled += 1;
    } else {
      counts.error += 1;
    }
  }
  return counts;
}

/**
 * Chip mapping per state. `tone` is a StatusDot tone; `label` the chip text.
 * The literal values are the stable contract tests assert against.
 */
export const MODEL_STATE_CHIPS = {
  active: { tone: "ok", label: "Active" },
  disabled: { tone: "idle", label: "Disabled" },
  error: { tone: "error", label: "Error" },
} as const;

export type ModelStateChip = (typeof MODEL_STATE_CHIPS)[ModelState];

/** Resolve the chip mapping for one state. */
export function stateChip(state: ModelState): ModelStateChip {
  return MODEL_STATE_CHIPS[state];
}

/**
 * Display order for the registry table: hint ids first (pinned, in the given
 * order, deduped, only those actually present in the registry), then every
 * remaining model sorted by id ascending. Deterministic, so tests and
 * renders always agree.
 */
export function modelRows(
  registry: readonly ModelStatus[],
  hintIds: readonly string[] = [],
): ModelStatus[] {
  const pinnedIds = new Set<string>();
  const pinned: ModelStatus[] = [];
  for (const id of hintIds) {
    if (pinnedIds.has(id)) continue;
    const match = registry.find((model) => model.id === id);
    if (match === undefined) continue;
    pinnedIds.add(id);
    pinned.push(match);
  }
  const rest = registry
    .filter((model) => !pinnedIds.has(model.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...pinned, ...rest];
}

/** pid display: the number verbatim, "—" when the backend sends none. */
export function formatPid(pid: number | undefined): string {
  return typeof pid === "number" && Number.isFinite(pid) ? String(pid) : "—";
}

/** port display: the number verbatim, "—" when the backend sends none. */
export function formatPort(port: number | undefined): string {
  return typeof port === "number" && Number.isFinite(port) ? String(port) : "—";
}

/** error display: the backend message verbatim, "—" when there is none. */
export function formatError(error: string | undefined): string {
  return typeof error === "string" && error.length > 0 ? error : "—";
}

/**
 * Error cell copy: the full message when it fits, ellipsis-truncated beyond
 * `max`. The row keeps the full text in its title attribute, so truncation
 * never loses information.
 */
export function errorCell(error: string | undefined, max = 96): string {
  const text = formatError(error);
  if (text === "—" || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}