import { describe, expect, test } from "bun:test";
import { sseResponse } from "./relay.js";

describe("sseResponse — OpenAI-wire SSE relay framing", () => {
  test("frames each payload as a data: line and ends with exactly one [DONE]", async () => {
    const source = (async function* () {
      yield '{"id":"a"}';
      yield '{"id":"b"}';
    })();
    const res = await sseResponse(source);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toBe('data: {"id":"a"}\n\ndata: {"id":"b"}\n\ndata: [DONE]\n\n');
  });

  test("a raw [DONE] payload from the upstream is not duplicated", async () => {
    const source = (async function* () {
      yield "data-1";
      yield "[DONE]"; // paranoid upstream already terminating
    })();
    const res = await sseResponse(source);
    const body = await res.text();
    expect(body).toBe("data: data-1\n\ndata: [DONE]\n\n");
  });

  test("an empty stream still ends with exactly one [DONE]", async () => {
    const source = (async function* () {})();
    const res = await sseResponse(source);
    expect(await res.text()).toBe("data: [DONE]\n\n");
  });

  test("client disconnect aborts the upstream generator", async () => {
    const ac = new AbortController();
    let upstreamAborted = false;
    const source = (async function* () {
      try {
        yield '{"choices":[{"delta":{"content":"x"}}]}';
        // Mirrors an upstream fetch read: it rejects when the client
        // signal aborts, letting the generator's finally run.
        await new Promise<void>((resolve) => {
          ac.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield '{"choices":[{"delta":{"content":"never"}}]}';
      } finally {
        upstreamAborted = true;
      }
    })();

    const res = await sseResponse(source, ac.signal);
    const reader = res.body?.getReader();
    expect(reader).not.toBeNull();
    await reader!.read(); // consume the first chunk, then the client hangs up
    ac.abort();
    try {
      await reader!.read();
    } catch {
      // cancelled read may reject — the abort is what matters
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(upstreamAborted).toBe(true);
  });
});