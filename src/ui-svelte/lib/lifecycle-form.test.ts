import { describe, it, expect } from "bun:test";
import {
  toLifecycleDraft,
  mergeLifecycleConfig,
  validateLifecycleDraft,
  lifecycleDraftEquals,
  isVramMode,
  VRAM_MODES,
  VRAM_MODE_LABELS,
} from "./lifecycle-form.js";
import type { LifecycleConfig } from "../stores/types.js";

describe("lifecycle-form helpers", () => {
  it("seeds the draft from config with schema-mirrored fallbacks", () => {
    expect(toLifecycleDraft(null)).toEqual({ ttl: 600, vramMode: "dynamic", freeGb: 1, capGb: 5 });
    expect(
      toLifecycleDraft({
        llama: { lifecycle: { ttl: 30, vram: { mode: "margin", freeGb: 4, capGb: 12 } } },
      } as LifecycleConfig),
    ).toEqual({ ttl: 30, vramMode: "margin", freeGb: 4, capGb: 12 });
  });

  it("coerces an unknown VRAM mode to dynamic", () => {
    expect(
      toLifecycleDraft({ llama: { lifecycle: { ttl: 30, vram: { mode: "auto" } } } } as LifecycleConfig)
        .vramMode,
    ).toBe("dynamic");
  });

  it("merges the draft over the loaded config preserving unknown keys", () => {
    const merged = mergeLifecycleConfig(
      {
        server: { port: 4567 },
        llama: { lifecycle: { ttl: 30, vram: { mode: "dynamic", freeGb: 2, capGb: 8 } } },
      } as LifecycleConfig,
      { ttl: 60, vramMode: "cap", freeGb: 2, capGb: 10 },
    );
    expect(merged).toEqual({
      server: { port: 4567 },
      llama: { lifecycle: { ttl: 60, vram: { mode: "cap", freeGb: 2, capGb: 10 } } },
    });
  });

  it("validates ranges client-side", () => {
    const valid = { ttl: 30, vramMode: "dynamic" as const, freeGb: 2, capGb: 8 };
    expect(validateLifecycleDraft(valid)).toBeNull();
    expect(validateLifecycleDraft({ ...valid, ttl: -1 })).toContain("TTL");
    expect(validateLifecycleDraft({ ...valid, freeGb: -1 })).toContain("VRAM libre");
    expect(validateLifecycleDraft({ ...valid, capGb: 0.1 })).toContain("0.5");
  });

  it("detects drafts equal to the loaded config", () => {
    const a = { ttl: 30, vramMode: "dynamic" as const, freeGb: 2, capGb: 8 };
    expect(lifecycleDraftEquals(a, { ...a })).toBe(true);
    expect(lifecycleDraftEquals(a, { ...a, ttl: 60 })).toBe(false);
  });

  it("exposes every schema VRAM mode with a label", () => {
    expect(VRAM_MODES).toEqual(["dynamic", "margin", "cap"]);
    expect(Object.keys(VRAM_MODE_LABELS).sort()).toEqual(["cap", "dynamic", "margin"]);
    expect(isVramMode("margin")).toBe(true);
    expect(isVramMode("auto")).toBe(false);
  });
});