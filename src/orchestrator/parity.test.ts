/**
 * Graph engine parity approval test (refactor-graph-canonical — Phase 7).
 *
 * The linear engine (`runChain`) has been removed. The golden file
 * `__snapshots__/linear-parity.json` captures the exact call sequences that
 * the linear engine produced for the 6 migrated chains. The graph engine
 * must reproduce them identically — this test is the approval gate.
 *
 * Any future change to `buildStepMessages`, `payloadFor`, or the graph
 * walk loop that alters call sequences will break this golden snapshot,
 * forcing an explicit review of the behavioral change.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runGraphEngine, type GraphEngineDeps } from "./graph-engine.js";
import { parityChains, PARITY_IDS, type RecordedCall } from "./parity-fixtures.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./__snapshots__/linear-parity.json", import.meta.url), "utf8"),
) as Record<string, Array<Record<string, unknown>>>;

const originalPayload = {
  stream: false,
  messages: [{ role: "user", content: "hi" }],
};

/** Normalize a recorded call to the golden-file shape. */
function toShape(calls: RecordedCall[]): Array<Record<string, unknown>> {
  return calls.map((c) => ({
    provider: c.provider,
    model: c.model,
    messages: c.messages,
  }));
}

describe("graph parity gate (approval test — golden snapshot)", () => {
  const chains = parityChains();

  for (const id of PARITY_IDS) {
    test(`${id} matches the committed golden snapshot`, async () => {
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
