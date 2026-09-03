/**
 * Chain execution engine.
 *
 * Runs chain steps sequentially with:
 *  - Context refeed: each step receives the previous step's full response
 *  - 429 fallback: when a step raises HTTP 429 (the provider adapter throws
 *    with err.status=429), the engine reroutes to the step named by `on_429`
 *  - tool_calls routing: when a response contains tool_calls, the engine
 *    reroutes to the step named by `tool_calls_route`
 *  - Streaming: only the LAST step streams to the client. The streaming core
 *    (`buildStreamBody`) returns a `ReadableStream<Uint8Array>` whose frames
 *    are `data: {...}\n\n` SSE messages; `runChain` wraps that stream in a
 *    `Response` (S2b) so the Bun.serve fetch handler returns it directly.
 *  - Abort: client disconnect cancels the upstream request via the stream's
 *    cancellation propagating to the provider's async generator.
 *
 * DESIGN DECISION (from design.md): the engine is bespoke (~40 lines of
 * core loop) rather than using LangChain/Mastra — the current needs are
 * exactly sequential steps + 2 conditionals. Framework overhead is
 * unjustified.
 */
import type { ParsedChain } from "./parser.js";
import type { Provider } from "../providers/types.js";
import type { StepContext } from "../types/chain.js";
import { extractContent } from "../utils/extract.js";

/** Map of provider name → Provider instance (injected by the server). */
export type ProviderMap = Map<string, Provider>;

/** Map of chain name → ParsedChain (from parser). */
export type ChainMap = Map<string, ParsedChain>;

/**
 * Execute a single step non-streaming and return the parsed response.
 */
async function runStepNonStream(
  provider: Provider,
  payload: Record<string, unknown>,
  chainName: string,
): Promise<Record<string, unknown>> {
  return provider.chat(payload, chainName);
}

/**
 * Build a `ReadableStream<Uint8Array>` of SSE frames for the final streaming
 * step. Replaces the old `res.write` path (S2.2).
 *
 * Invariants (gateway-api "SSE streaming integrity" spec):
 *  1. each token arrives as a `data: {json}\n\n` frame, unbuffered;
 *  2. exactly ONE terminal chunk: if the upstream never sends a finish_reason,
 *     a synthesized chunk with `finish_reason: "stop"` is emitted once;
 *  3. the stream ends with exactly ONE `data: [DONE]\n\n`;
 *  4. on error, exactly one error chunk (finish_reason null) then `[DONE]`;
 *  5. client disconnect (stream cancellation) aborts the upstream generator.
 */
export function buildStreamBody(
  provider: Provider,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  completionId: string,
  created: number,
  modelName: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  let receivedFinishReason = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const data of provider.chatStream(payload, signal)) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Rewrite IDs and model to reflect the chain, not the backend model.
          parsed.id = completionId;
          parsed.model = modelName;
          parsed.created = created;
          if (parsed.object !== "chat.completion.chunk") {
            parsed.object = "chat.completion.chunk";
          }

          const choices = parsed.choices as
            | Array<{ finish_reason?: string | null }>
            | undefined;
          if (choices?.[0]?.finish_reason) {
            receivedFinishReason = true;
          }

          controller.enqueue(enc.encode(`data: ${JSON.stringify(parsed)}\n\n`));
        }

        // Spec invariant: exactly ONE terminal chunk. If the upstream never
        // sent a finish_reason, synthesize the stop chunk before [DONE].
        if (!receivedFinishReason) {
          const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        }

        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        // Proxy-pipeline spec: exactly ONE terminal chunk on error, no
        // duplicate error payload after a successful finish.
        const errorChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: null,
              error: { message: String(err) },
            },
          ],
        };
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // Stream already closed/cancelled — nothing more to write.
        }
      }
    },
    cancel() {
      // Client disconnect: aborting the reader cancels the upstream generator
      // (the provider's `finally` observes it), releasing resources.
    },
  });
}

/**
 * Execute the final step streaming into the given ReadableStream, returning
 * it so the caller (route / server) can serve it as an SSE Response.
 */
function runStepStream(
  provider: Provider,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  completionId: string,
  created: number,
  modelName: string,
): ReadableStream<Uint8Array> {
  return buildStreamBody(provider, payload, signal, completionId, created, modelName);
}

/** SSE response headers for streaming chain steps (Bun.serve). */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** JSON response headers for non-streaming chain results. */
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Generate a stable-but-unique OpenAI chat completion id for a chain. */
function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Whether the payload requests a streaming response. */
function isStreamRequest(payload: Record<string, unknown>): boolean {
  return payload.stream === true;
}

/**
 * Run a full chain: sequential steps, context refeed, conditional routing,
 * streaming only on the final step. Returns the final `Response` (SSE stream
 * for streaming chains, JSON body otherwise) ready for the Bun.serve fetch
 * handler to return directly.
 */
export async function runChain(
  chain: ParsedChain,
  providers: ProviderMap,
  originalPayload: Record<string, unknown>,
  signal: AbortSignal,
  query?: string,
): Promise<Response> {
  const steps = chain.steps;
  const displayName = chain.displayName ?? chain.name;

  let context: StepContext = {
    lastResponse: null,
    lastContent: "",
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;

    // Resolve provider — fallback to first available if name not found.
    const provider =
      providers.get(step.provider) ?? providers.values().next().value;
    if (!provider) {
      throw new Error(
        `[engine] no provider "${step.provider}" available for chain "${chain.name}" step ${i}`,
      );
    }

    // Build messages for this step based on its type.
    const messages = buildStepMessages(step, originalPayload, context);

    const payload: Record<string, unknown> = {
      ...originalPayload,
      model: step.model,
      messages,
      stream: isLast ? originalPayload.stream : false,
    };

    // Preserve the original request query (e.g. `?autoload=false`) so the
    // provider appends it to the upstream URL on every chain step.
    if (query) {
      payload.__gatewayQuery = query;
    }

    console.log(
      `[engine] chain "${displayName}" step ${i + 1}/${steps.length}: ` +
        `${step.type} → ${step.model} (${provider.name})` +
        (isLast ? " [STREAM]" : ""),
    );

    try {
      if (isLast && isStreamRequest(originalPayload)) {
        // Final streaming step — wrap the SSE ReadableStream in a Response.
        const stream = runStepStream(
          provider,
          payload,
          signal,
          newCompletionId(),
          Math.floor(Date.now() / 1000),
          displayName,
        );
        return new Response(stream as ReadableStream, {
          status: 200,
          headers: SSE_HEADERS,
        });
      }

      // Non-streaming step: get the full response and refeed.
      const response = await runStepNonStream(provider, payload, chain.name);

      context = {
        lastResponse: response,
        lastContent: extractContent(response),
      };

      // ── tool_calls routing ──
      if (step.tool_calls_route && hasToolCalls(response)) {
        const routeIdx = steps.findIndex(
          (s) =>
            (s.name ?? `step-${steps.indexOf(s)}`) === step.tool_calls_route,
        );
        if (routeIdx >= 0) {
          console.log(
            `[engine] tool_calls detected on step ${i}, routing to "${step.tool_calls_route}"`,
          );
          i = routeIdx - 1; // -1 because the for-loop will i++ next.
          continue;
        }
      }
    } catch (err) {
      // If the error carries a status (e.g. 429 from provider adapter),
      // check on_429 before re-throwing.
      const errStatus = (err as Error & { status?: number }).status;
      if (errStatus === 429 && step.on_429) {
        const fallbackIdx = steps.findIndex(
          (s) => (s.name ?? `step-${steps.indexOf(s)}`) === step.on_429,
        );
        if (fallbackIdx >= 0) {
          console.log(
            `[engine] 429 error on step ${i}, falling back to "${step.on_429}"`,
          );
          i = fallbackIdx - 1;
          continue;
        }
      }
      throw err;
    }
  }

  // Non-streaming chain: return the final response as JSON.
  const finalResponse = context.lastResponse as Record<string, unknown>;
  if (finalResponse) {
    finalResponse.model = displayName;
    return new Response(JSON.stringify(finalResponse), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }

  return new Response(
    JSON.stringify({
      error: {
        message: "Chain produced no response",
        type: "server_error",
        param: null,
        code: null,
      },
    }),
    { status: 500, headers: JSON_HEADERS },
  );
}

// ── Helpers ──

/**
 * Build the messages array for a step based on its type and context.
 *
 * - generate: use original user messages (prepend system prompt if set).
 * - refine:   refeed previous step's content as a user message.
 * - passthrough: use original messages unchanged.
 */
export function buildStepMessages(
  step: { type: string; system?: string; assistant?: string; user?: string },
  originalPayload: Record<string, unknown>,
  context: StepContext,
): Array<Record<string, unknown>> {
  const originalMessages = (originalPayload.messages ??
    []) as Array<Record<string, unknown>>;

  switch (step.type) {
    case "generate": {
      const msgs: Array<Record<string, unknown>> = [];
      if (step.system) {
        msgs.push({ role: "system", content: step.system });
      }
      if (step.assistant) {
        msgs.push({ role: "assistant", content: step.assistant });
      }
      msgs.push(...originalMessages);
      return msgs;
    }

    case "refine": {
      const msgs: Array<Record<string, unknown>> = [];
      if (step.system) {
        msgs.push({ role: "system", content: step.system });
      }
      if (step.assistant) {
        msgs.push({ role: "assistant", content: step.assistant });
      }
      // Include original user messages for context.
      msgs.push(...originalMessages);
      // Re-feed previous step's output for refinement.
      if (context.lastContent) {
        msgs.push({ role: "user", content: context.lastContent });
      }
      return msgs;
    }

    case "passthrough":
      return originalMessages;

    default:
      return originalMessages;
  }
}

/**
 * Check whether a response body contains non-empty tool_calls.
 */
export function hasToolCalls(response: Record<string, unknown>): boolean {
  const choices = response.choices as
    | Array<{ message?: { tool_calls?: unknown[] } }>
    | undefined;
  if (!choices?.[0]?.message?.tool_calls) return false;
  return choices[0].message.tool_calls.length > 0;
}
