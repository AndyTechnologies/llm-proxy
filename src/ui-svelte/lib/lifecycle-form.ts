/**
 * Backend lifecycle form helpers (svelte-ui verify scenario 10).
 * Pure TS: draft<->config mapping, merged apply payload, client-side guards.
 * The zod schema (src/config/schema.ts) stays the source of truth for ranges.
 */

import type { LifecycleConfig } from "../stores/types.js";

export type VramMode = "dynamic" | "margin" | "cap";

/** Order mirrors the legacy /ui select (parity, no breaking reorder). */
export const VRAM_MODES: readonly VramMode[] = ["dynamic", "margin", "cap"];

export const VRAM_MODE_LABELS: Record<VramMode, string> = {
  dynamic: "Dinámico — VRAM total − GB libres",
  margin: "Margen libre — VRAM total − margen",
  cap: "Manual — tope de VRAM ocupada",
};

export interface LifecycleDraft {
  ttl: number;
  vramMode: VramMode;
  freeGb: number;
  capGb: number;
}

/** Schema-mirrored fallbacks (lifecycleConfigSchema defaults). */
const DEFAULT_TTL = 600;
const DEFAULT_FREE_GB = 1;
const DEFAULT_CAP_GB = 5;

export function isVramMode(value: unknown): value is VramMode {
  return value === "dynamic" || value === "margin" || value === "cap";
}

/** Build the form draft from the loaded config (fallbacks for absent/partial
 * config; a stale mode, e.g. legacy "auto", degrades to "dynamic"). */
export function toLifecycleDraft(config: LifecycleConfig | null): LifecycleDraft {
  const lifecycle = config?.llama?.lifecycle;
  const mode = lifecycle?.vram?.mode;
  return {
    ttl: lifecycle?.ttl ?? DEFAULT_TTL,
    vramMode: isVramMode(mode) ? mode : "dynamic",
    freeGb: lifecycle?.vram?.freeGb ?? DEFAULT_FREE_GB,
    capGb: lifecycle?.vram?.capGb ?? DEFAULT_CAP_GB,
  };
}

/** Merge the edited draft over the loaded config into the apply payload,
 * preserving every other top-level and llama key of the base config. */
export function mergeLifecycleConfig(base: LifecycleConfig, draft: LifecycleDraft): LifecycleConfig {
  return {
    ...base,
    llama: {
      ...base.llama,
      lifecycle: {
        ...base.llama?.lifecycle,
        ttl: draft.ttl,
        vram: { mode: draft.vramMode, freeGb: draft.freeGb, capGb: draft.capGb },
      },
    },
  };
}

/** Client-side guard; returns the Spanish message, or null when valid. */
export function validateLifecycleDraft(draft: LifecycleDraft): string | null {
  if (!Number.isInteger(draft.ttl) || draft.ttl < 0) {
    return "El TTL debe ser un número entero mayor o igual a 0.";
  }
  if (!Number.isFinite(draft.freeGb) || draft.freeGb < 0) {
    return "La VRAM libre debe ser un número mayor o igual a 0.";
  }
  if (!Number.isFinite(draft.capGb) || draft.capGb < 0.5) {
    return "El tope de VRAM debe ser mayor o igual a 0.5 GiB.";
  }
  return null;
}

export function lifecycleDraftEquals(a: LifecycleDraft, b: LifecycleDraft): boolean {
  return a.ttl === b.ttl && a.vramMode === b.vramMode && a.freeGb === b.freeGb && a.capGb === b.capGb;
}