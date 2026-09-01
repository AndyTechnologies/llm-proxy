/**
 * Chain execution engine.
 *
 * Runs chain steps sequentially with:
 *  - Context refeed: each step receives the previous step's full response
 *  - 429 fallback: when a step raises HTTP 429 (the provider adapter throws
 *    with err.status=429), the engine reroutes to the step named by `on_429`
 *  - tool_calls routing: when a response contains tool_calls, the engine
 *    reroutes to the step named by `tool_calls_route`
 *  - Streaming: only the LAST step streams to the client via `res.pipe()`
 *    unbuffered; all prior steps run non-streaming
 *  - Abort: client disconnect (`res.on('close')`) aborts upstream requests
 *
 * DESIGN DECISION (from design.md): the engine is bespoke (~40 lines of
 * core loop) rather than using LangChain/Mastra — the current needs are
 * exactly sequential steps + 2 conditionals. Framework overhead is
 * unjustified.
 */
import type { Response } from "express";
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
 * Execute the final step streaming, piping raw SSE data directly to the
 * client response via `res.pipe()`-style forwarding (unbuffered).
 *
 * CRITICAL: we iterate the async generator and write each chunk individually
 * rather than using Node stream.pipe() because the provider yields parsed
 * SSE data strings, not raw Node streams. The effect is the same: unbuffered,
 * real-time forwarding.
 */
async function runStepStream(
  provider: Provider,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  res: Response,
  completionId: string,
  created: number,
  modelName: string,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let receivedFinishReason = false;

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

      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    }

    // Spec invariant: exactly ONE terminal chunk. If the upstream never sent
    // a finish_reason, we synthesize the stop chunk before [DONE].
    if (!receivedFinishReason && !res.writableEnded) {
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
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    }

    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    // Proxy-pipeline spec: exactly ONE terminal chunk on error, no duplicate
    // error payload after a successful finish.
    if (!res.writableEnded) {
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
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/**
 * Run a full chain: sequential steps, context refeed, conditional routing,
 * streaming only on the final step.
 */
export async function runChain(
  chain: ParsedChain,
  providers: ProviderMap,
  originalPayload: Record<string, unknown>,
  res: Response,
  signal: AbortSignal,
  query?: string,
): Promise<void> {
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
      if (isLast && originalPayload.stream) {
        // Final streaming step — pipe directly to the client response.
        await runStepStream(
          provider,
          payload,
          signal,
          res,
          `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          Math.floor(Date.now() / 1000),
          displayName,
        );
        return; // Stream completed, chain done.
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

  // Non-streaming chain: send the final response as JSON.
  if (!res.writableEnded) {
    const finalResponse = context.lastResponse as Record<string, unknown>;
    if (finalResponse) {
      finalResponse.model = displayName;
      res.json(finalResponse);
    } else {
      res.status(500).json({
        error: {
          message: "Chain produced no response",
          type: "server_error",
          param: null,
          code: null,
        },
      });
    }
  }
}

// ── Helpers ──

/**
 * Build the messages array for a step based on its type and context.
 *
 * - generate: use original user messages (prepend system prompt if set).
 * - refine:   refeed previous step's content as a user message.
 * - passthrough: use original messages unchanged.
 */
function buildStepMessages(
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
function hasToolCalls(response: Record<string, unknown>): boolean {
  const choices = response.choices as
    | Array<{ message?: { tool_calls?: unknown[] } }>
    | undefined;
  if (!choices?.[0]?.message?.tool_calls) return false;
  return choices[0].message.tool_calls.length > 0;
}
