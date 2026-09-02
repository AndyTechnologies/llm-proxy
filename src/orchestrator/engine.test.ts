/**
 * Engine streaming tests (strict TDD, S2.2 — res.write → ReadableStream.enqueue).
 *
 * The streaming core is a pure builder `buildStreamBody` that returns a
 * `ReadableStream<Uint8Array>` of SSE frames. It must:
 *  - enqueue each token chunk as `data: {...}\n\n`
 *  - emit exactly ONE terminal chunk (finish_reason:"stop") when the upstream
 *    never sends a finish reason, before `data: [DONE]`
 *  - emit exactly ONE `data: [DONE]\n\n` at the very end
 *  - on abort (signal), cancel the upstream generator (via provider.chatStream
 *    iteration) — verified by the provider stopping iterating
 */
import { describe, expect, test } from "bun:test";
import type { Provider } from "../providers/types.js";
import { buildStreamBody } from "./engine.js";

const dec = new TextDecoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

interface FakeProviderOpts {
  frames?: string[];           // raw SSE data payloads (JSON strings) to yield
  error?: Error;               // if set, chatStream throws after yielding frames
  onAbort?: () => void;        // called when the caller's signal aborts
  onIterateDone?: () => void;  // called when the generator fully completes
}

/** Fake provider shaped like the real llama-server adapter. */
function fakeProvider(opts: FakeProviderOpts = {}): Provider {
  return {
    name: "fake",
    async chat() {
      return {};
    },
    async *chatStream(_payload: Record<string, unknown>, signal: AbortSignal) {
      try {
        for (const frame of opts.frames ?? []) {
          if (signal?.aborted) {
            opts.onAbort?.();
            return;
          }
          yield frame;
        }
        if (opts.error) {
          throw opts.error;
        }
      } finally {
        opts.onAbort?.();
      }
      opts.onIterateDone?.();
    },
  };
}

function doneSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("buildStreamBody — happy path (upstream sends finish_reason)", () => {
  test("enqueues each chunk as a data: frame and emits exactly one [DONE]", async () => {
    const provider = fakeProvider({
      frames: [
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
        }),
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }],
        }),
      ],
    });

    const stream = buildStreamBody(provider, {}, doneSignal(), "id-1", 1, "chain-a");
    const out = await collect(stream);

    // Two data frames + exactly one [DONE]
    expect(out.match(/^data: /gm)).toHaveLength(3);
    expect((out.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out).toContain('"Hi');
    expect(out).toContain('" there');
  });

  test("rewrites id, model, created to reflect the chain", async () => {
    const provider = fakeProvider({
      frames: [
        JSON.stringify({
          id: "backend-id",
          object: "chat.completion.chunk",
          created: 999,
          model: "backend-model",
          choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
        }),
      ],
    });

    const stream = buildStreamBody(provider, {}, doneSignal(), "chain-id-abc", 555, "display-chain");
    const out = await collect(stream);

    const frames = out.split("data: ").filter(Boolean).map((s) => s.trim()).filter((s) => s !== "[DONE]");
    const parsed = JSON.parse(frames[0]) as Record<string, unknown>;
    expect(parsed.id).toBe("chain-id-abc");
    expect(parsed.model).toBe("display-chain");
    expect(parsed.created).toBe(555);
  });
});

describe("buildStreamBody — terminal chunk synthesis", () => {
  test("upstream without finish_reason gets exactly one synthesized stop chunk before [DONE]", async () => {
    const provider = fakeProvider({
      frames: [
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        }),
      ],
    });

    const stream = buildStreamBody(provider, {}, doneSignal(), "id-2", 1, "chain-a");
    const out = await collect(stream);

    // Only the one upstream chunk + one synthesized terminal chunk + [DONE]
    const frames = out.split("data: ").filter(Boolean).map((s) => s.trim()).filter((s) => s !== "[DONE]");
    expect(frames).toHaveLength(2);
    const terminal = JSON.parse(frames[1]) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(terminal.choices[0].finish_reason).toBe("stop");
    expect((out.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  });
});

describe("buildStreamBody — error path", () => {
  test("stream error emits one error chunk (finish_reason null) + one [DONE]", async () => {
    const provider = fakeProvider({
      frames: [
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: "boom" }, finish_reason: null }],
        }),
      ],
      error: new Error("upstream exploded"),
    });

    const stream = buildStreamBody(provider, {}, doneSignal(), "id-3", 1, "chain-a");
    const out = await collect(stream);

    const chunks = out.split("data: ").filter(Boolean).map((s) => s.trim()).filter((s) => s !== "[DONE]");
    // Error after no finish seen → one error terminal chunk. Chunks: boom + error = 2.
    const last = JSON.parse(chunks[chunks.length - 1]) as {
      choices: Array<{ finish_reason: string | null; error?: { message: string } }>;
    };
    expect(last.choices[0].finish_reason).toBeNull();
    expect((out.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  });
});

describe("buildStreamBody — abort", () => {
  test("client abort cancels upstream iteration", () => {
    let aborted = false;
    const controller = new AbortController();
    const provider = fakeProvider({
      frames: [
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }],
        }),
      ],
      onAbort: () => {
        aborted = true;
      },
    });

    const stream = buildStreamBody(provider, {}, controller.signal, "id-4", 1, "chain-a");
    const reader = stream.getReader();
    // Read first chunk, then abort the client signal.
    void reader.read().then(() => {
      controller.abort();
    });

    // The abort must propagate to the provider's generator (onAbort fires).
    return new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (aborted) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    }).then(() => {
      expect(aborted).toBe(true);
    });
  });
});
