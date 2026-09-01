/**
 * Provider abstraction.
 *
 * A Provider encapsulates all network interaction with a single model backend,
 * exposing two operations: a one-shot non-streaming chat call and a streaming
 * chat call that yields raw SSE `data:` payload strings.
 *
 * The interface exists to isolate the llama-server API surface (which the
 * design flags as the top risk) so future providers — OpenAI, Anthropic, etc. —
 * can plug in behind one contract without touching the orchestrator or routes.
 */
export interface Provider {
  readonly name: string;

  /**
   * Perform a single non-streaming chat completion.
   * @param request  The (already normalized) chat payload, including `stream:false`.
   * @param chainName Optional chain name for error/model identification.
   */
  chat(
    request: Record<string, unknown>,
    chainName?: string,
  ): Promise<Record<string, unknown>>;

  /**
   * Stream a chat completion, yielding raw SSE data payloads (the parsed JSON
   * strings between `data: ` frames). The stream SHALL be unbuffered.
   * @param request  The chat payload with `stream:true`.
   * @param signal   Abort signal forwarding client disconnect upstream.
   */
  chatStream(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<string>;
}
