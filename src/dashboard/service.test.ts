import { describe, it, expect } from "bun:test";
import { createApplyService } from "./service.js";
import type { ApplyDeps } from "./service.js";

function makeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & {
  getPersisted: () => boolean;
} {
  let written: boolean = false;
  let currentChains: string[] = [];
  return {
    configPath: "/tmp/llm-proxy.config.yaml",
    persist: async (_cfg, _path) => {
      written = true;
      // Simulate a possible failure when `shouldPersistFail` is set.
      if ((overrides as Record<string, unknown>).persistFails) {
        throw new Error("persist failed");
      }
      return "yaml";
    },
    reload: async (chains) => {
      currentChains = chains;
    },
    getCurrentChains: () => [...currentChains],
    getPersisted(): boolean {
      return written;
    },
    ...overrides,
  };
}

describe("apply service", () => {
  it("valid apply persists, reloads, returns applied status with reloaded chains", async () => {
    const deps = makeDeps();
    const service = createApplyService(deps);

    const result = await service.apply({
      config: {
        server: {},
        llama: { models: { m: { file: "m.gguf" } } },
        chains: {
          c1: {
            nodes: [
              { id: "start", type: "start" },
              { id: "a", type: "llm_call", model: "m", mode: "generate" },
              { id: "end", type: "end" },
            ],
            edges: [
              { from: "start", to: "a" },
              { from: "a", to: "end" },
            ],
          },
        },
      },
    });

    expect(result.status).toBe("applied");
    expect(result.reloadedChains).toEqual(["c1"]);
  });

  it("invalid apply writes nothing and throws a typed error with envelope", async () => {
    const deps = makeDeps();
    const service = createApplyService(deps);

    await expect(
      service.apply({
        config: {
          chains: {
            c1: {
              nodes: [
                { id: "start", type: "start" },
                { id: "a", type: "llm_call", model: 123, mode: "generate" }, // model must be a string
                { id: "end", type: "end" },
              ],
              edges: [
                { from: "start", to: "a" },
                { from: "a", to: "end" },
              ],
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("model"),
      type: "invalid_request_error",
    });

    // No file was written on failure.
    expect(deps.getPersisted()).toBe(false);
  });

  it("rolls back the registry when reload fails after persist", async () => {
    const deps = makeDeps({
      reload: async () => {
        throw new Error("reload failed");
      },
    });
    const service = createApplyService(deps);

    await expect(
      service.apply({
        config: {
          chains: {
            c1: {
              nodes: [
                { id: "start", type: "start" },
                { id: "a", type: "llm_call", model: "m", mode: "generate" },
                { id: "end", type: "end" },
              ],
              edges: [
                { from: "start", to: "a" },
                { from: "a", to: "end" },
              ],
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("reload failed"),
      type: "server_error",
    });
  });

  it("returns error envelope object with message/type/param/code", async () => {
    const deps = makeDeps();
    const service = createApplyService(deps);

    let err: unknown;
    try {
      await service.apply({
        config: {
          chains: {
            bad: {
              nodes: [
                { id: "start", type: "start" },
                { id: "a", type: "llm_call", model: 123 }, // invalid model type
                { id: "end", type: "end" },
              ],
              edges: [
                { from: "start", to: "a" },
                { from: "a", to: "end" },
              ],
            },
          },
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { message: string }).message).toBeTruthy();
    expect((err as { type: string }).type).toBeTruthy();
    expect((err as { param: unknown }).param).not.toBeUndefined();
    expect((err as { code: unknown }).code).not.toBeUndefined();
  });
});
