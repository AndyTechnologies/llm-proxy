/**
 * OpenAI-wire SSE relay (external-proxy spec): wraps an upstream async
 * iterable of chunk payloads into an SSE Response. Each payload becomes one
 * `data: <json>` frame; the stream ends with EXACTLY one `data: [DONE]`
 * (raw "[DONE]" payloads from the upstream are consumed, never re-emitted).
 * When the client disconnects (signal abort, or the response body is
 * cancelled), the upstream generator is unwound via return() — running its
 * finally and aborting the outbound fetch.
 */

/** Empty payloads and a premature [DONE] are consumed by the relay. */
function isTerminalPayload(payload: string): boolean {
  return payload === "[DONE]";
}

/**
 * Build an SSE Response streaming `source` payloads, terminated by exactly
 * one `data: [DONE]`. `clientSignal` carries client-disconnect: aborting it
 * errors the response stream and unwinds the upstream generator.
 */
export async function sseResponse(
  source: AsyncIterable<string>,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<string> | null = null;
  let settled = false;

  const unwindUpstream = (): void => {
    if (settled || iterator === null) return;
    settled = true;
    void iterator.return?.().catch(() => {});
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      iterator = source[Symbol.asyncIterator]();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await iterator!.next();
            if (done) break;
            if (isTerminalPayload(value)) continue;
            controller.enqueue(encoder.encode(`data: ${value}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          settled = true;
        }
      })();

      if (clientSignal !== undefined && !clientSignal.aborted) {
        clientSignal.addEventListener("abort", () => {
          controller.error(new Error("client disconnected"));
          unwindUpstream();
        }, { once: true });
      }
    },
    cancel() {
      // Response body cancelled (Bun-side client hangup): unwind upstream.
      unwindUpstream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}