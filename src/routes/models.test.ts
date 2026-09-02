/**
 * Models fetch handler tests (S2a — Bun.serve migration).
 *
 * Verifies GET /v1/models shape after the migration: object "list" with
 * gateway/* virtual chain models (owned_by "gateway") plus real backend
 * models (owned_by "llama-server").
 */
import { describe, expect, test } from "bun:test";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";
import { createModelsHandler } from "./models.js";

function fakeManager(status: Partial<ReturnType<LlamaServeManager["status"]>>): LlamaServeManager {
  const full = {
    state: "running",
    pid: 12345,
    models: ["SmolLM3-3B", "Llama3.2-3B-Instruct"],
    baseUrl: "http://127.0.0.1:8080",
    ...status,
  };
  return { status: () => full } as unknown as LlamaServeManager;
}

function req(): Request {
  return new Request("http://localhost/v1/models");
}

describe("GET /v1/models", () => {
  test("lists gateway virtual models + real llama-server models", async () => {
    const chains = new Map<string, ParsedChain>();
    chains.set("orchestrator", {
      name: "orchestrator",
      displayName: "Orchestrator",
      steps: [],
    } as ParsedChain);
    chains.set("quick", { name: "quick", steps: [] } as ParsedChain);

    const manager = fakeManager({
      models: ["SmolLM3-3B", "Llama3.2-3B-Instruct"],
    });
    const handler = createModelsHandler({ chains, manager });

    const res = handler(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string; description?: string }>;
    };

    expect(body.object).toBe("list");
    // 2 gateway/* + 2 real
    expect(body.data).toHaveLength(4);
    const gateway = body.data.filter((m) => m.id.startsWith("gateway/"));
    const real = body.data.filter((m) => !m.id.startsWith("gateway/"));
    expect(gateway).toHaveLength(2);
    expect(real).toHaveLength(2);
    expect(gateway[0].owned_by).toBe("gateway");
    expect(real[0].owned_by).toBe("llama-server");
    // description available for virtual models when a displayName exists
    const orch = body.data.find((m) => m.id === "gateway/orchestrator");
    expect(orch?.description).toBe("Orchestrator");
  });

  test("empty chains + empty backend yields object list with zero data", async () => {
    const handler = createModelsHandler({
      chains: new Map(),
      manager: fakeManager({ models: [] }),
    });
    const body = (await handler(req()).json()) as { object: string; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.data).toEqual([]);
  });
});
