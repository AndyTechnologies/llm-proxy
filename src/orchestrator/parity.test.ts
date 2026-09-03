/**
 * Linear ⇄ graph parity gate (refactor-graph-canonical — Phases 2 & 4).
 *
 * Phase 2 — baseline: record what the LINEAR engine (`runChain`) produces for
 * each of the 6 migrated chains and assert it equals the committed golden
 * file `__snapshots__/linear-parity.json`. This pins the linear behavior
 * BEFORE the linear engine is deleted, so the graph engine must reproduce it.
 *
 * Phase 4 — parity gate: run the SAME 6 chains through the GRAPH engine
 * (`runGraphEngine`) and assert they produce IDENTICAL call sequences (same
 * providers, models, and message arrays) to the linear baseline. Only when
 * this passes may the linear engine be removed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runChain } from "./engine.js";
import { runGraphEngine, type GraphEngineDeps } from "./graph-engine.js";
import { parityChains, PARITY_IDS, type RecordedCall } from "./parity-fixtures.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./__snapshots__/linear-parity.json", import.meta.url), "utf8"),
) as Record<string, Array<Record<string, unknown>>>;

const signal = new AbortController().signal;
const originalPayload = {
  stream: false,
  messages: [{ role: "user", content: "hi" }],
};

/** Normalize a recorded call to the golden-file shape (strips nothing). */
function toShape(calls: RecordedCall[]): Array<Record<string, unknown>> {
  return calls.map((c) => ({
    provider: c.provider,
    model: c.model,
    messages: c.messages,
  }));
}

describe("linear parity baseline (Phase 2)", () => {
  const chains = parityChains();

  for (const id of PARITY_IDS) {
    test(`${id} matches the committed golden snapshot`, async () => {
      const chain = chains.find((c) => c.id === id)!;
      const res = await runChain(
        chain.chain,
        chain.providers,
        { ...originalPayload },
        signal,
      );
      expect(res.status).toBe(200);
      expect(toShape(chain.calls)).toEqual(GOLDEN[id]);
    });
  }
});

describe("graph parity gate (Phase 4)", () => {
  const chains = parityChains();

  for (const id of PARITY_IDS) {
    test(`${id} produces the same call sequence as the linear baseline`, async () => {
      const chain = chains.find((c) => c.id === id)!;
      const deps: GraphEngineDeps = {
        providers: chain.providers,
        getPipeline: () => undefined,
      };
      const res = await runGraphEngine(
        chain.graph,
        deps,
        { streamRequested: false, payload: { ...originalPayload } },
      );
      expect(res.lastStatus).toBe(200);
      expect(toShape(chain.calls)).toEqual(GOLDEN[id]);
    });
  }
});
