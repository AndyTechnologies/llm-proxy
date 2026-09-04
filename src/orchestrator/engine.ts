/**
 * Shared engine utilities for graph pipeline execution.
 *
 * The linear engine (`runChain`) has been removed — all pipeline execution
 * now goes through the graph engine (`runGraphEngine`). This module retains
 * the shared helpers that the graph engine imports:
 *  - `buildStepMessages` — message construction for generate/refine/passthrough
 *  - `buildStreamBody` — SSE streaming core
 *  - `hasToolCalls` — tool_calls response detection
 */
import type { Provider } from "../providers/types.js";

/** Map of provider name → Provider instance (injected by the server). */
export type ProviderMap = Map<string, Provider>;

/** Resolved per-execution context flowing between steps. */
export interface StepContext {
  /** Full response body of the most recent executed step. */
  lastResponse: unknown;
  /** Extracted textual content from the last response (context refeed). */
  lastContent: string;
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
