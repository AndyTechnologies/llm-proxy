/**
 * Graph engine (Slice B — task 2.4).
 *
 * Immutable runtime for complex pipelines: graphs with conditionals, loops,
 * and opt-in parallel subgraphs. Linear-compatible graphs run on the existing
 * `runChain` (hybrid selector); this engine handles everything else.
 *
 * Semantics (graph-engine spec):
 *  - Node types: start / end / llm_call / condition / loop / fan(parallel) / join
 *  - Sequential-guarded: a condition branches on its SAFE AST result; only the
 *    matching branch runs and its output propagates forward as lastResponse.
 *  - Parallel opt-in: a `fan` with `parallel:true` runs its subgraph branches
 *    concurrently and recombines them at the first reachable `join`.
 *  - Loop: a `loop` node runs its `body` sequentially up to a bound
 *    (`maxLoopIterations`, default 3) then exits along its exit edge.
 *  - Single-terminal streaming: only the LAST executed-path `llm_call` streams
 *    (via `buildStreamBody`, one terminal chunk); intermediate steps run
 *    non-streaming and emit `step` progress events.
 *
 * The runtime threads an immutable `GraphState` through execution so parallel
 * branches hold independent copies and merge at the join (no shared mutable
 * state across branches).
 */
import type { ProviderMap } from "./engine.js";
import { buildStepMessages, buildStreamBody, hasToolCalls } from "./engine.js";
import type { StepContext } from "../types/chain.js";
import { extractContent } from "../utils/extract.js";
import { evaluateAst } from "./graph.js";
import type { GraphPipeline, GraphNode, GraphEdge, AstExpr } from "./graph.js";

/** Execution state threaded through the graph (immutably replaced). */
interface GraphState {
  lastResponse: unknown;
  lastContent: string;
  lastStatus: number;
  error: string | null;
  variables: Record<string, unknown>;
}

/** A progress event emitted during execution. */
export type GraphEvent =
  | { type: "step"; nodeId: string; index: number; content: string; status: number }
  | { type: "terminal"; nodeId: string };

/** Injected dependencies for the graph engine. */
export interface GraphEngineDeps {
  providers: ProviderMap;
  /** Resolve a pre-defined pipeline by name for `pipeline` nodes. */
  getPipeline: (name: string) => GraphPipeline | undefined;
  /** Bound for loop execution (default 3). */
  maxLoopIterations?: number;
}

/** Options controlling a single engine run. */
export interface GraphEngineOpts {
  /** When true the last executed-path step streams; intermediates step:* only. */
  streamRequested?: boolean;
  /** The original chat payload (forwarded to llm_call steps). */
  payload?: Record<string, unknown>;
  signal?: AbortSignal;
  variables?: Record<string, unknown>;
}

/** Result of a graph engine run. */
export interface GraphRunResult {
  /** Ordered ids of the `llm_call` nodes that executed. */
  executedLlmNodes: string[];
  /** Ordered progress events (step + terminal). */
  events: GraphEvent[];
  lastResponse: unknown;
  lastContent: string;
  lastStatus: number;
  /** Final Response (SSE when streaming, JSON otherwise). */
  response: Response;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
const DEFAULT_LOOP_BOUND = 3;

/** Execute a graph and return the final Response plus execution metadata. */
export async function runGraphEngine(
  graph: GraphPipeline,
  deps: GraphEngineDeps,
  opts: GraphEngineOpts = {},
): Promise<GraphRunResult> {
  const providers = deps.providers;
  const streamRequested = opts.streamRequested === true;
  const signal = opts.signal ?? new AbortController().signal;
  const maxLoops = deps.maxLoopIterations ?? DEFAULT_LOOP_BOUND;

  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const typeOf = new Map<string, GraphNode["type"]>();
  for (const n of graph.nodes) typeOf.set(n.id, n.type);
  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  const start = graph.nodes.find((n) => n.type === "start");
  if (!start) {
    throw new Error(`[graph-engine] graph "${graph.id}" has no start node`);
  }

  // ── forward helpers ──
  const onlySuccessor = (id: string): string | null => {
    const list = outgoing.get(id);
    if (!list || list.length !== 1) return null;
    return list[0].to;
  };

  const astCtx = (st: GraphState) => ({
    lastResponse: { status: st.lastStatus, content: st.lastContent },
    error: st.error,
    variables: st.variables,
  });

  const safeEval = (expr: AstExpr, st: GraphState): boolean => {
    try {
      return evaluateAst(expr, astCtx(st));
    } catch {
      return false;
    }
  };

  const pickConditionBranch = (n: GraphNode, st: GraphState): string | null => {
    const result = n.condition ? safeEval(n.condition, st) : false;
    const edges = outgoing.get(n.id) ?? [];
    const wanted = result ? "true" : "false";
    const match = edges.find((e) => e.guard === wanted);
    return (match ?? edges[0] ?? { to: null }).to ?? null;
  };

  /**
   * Whether an `llm_call` at or reachable from `fromId` (via a deterministic
   * single-successor chain) still lies ahead. Used to decide if the current
   * step is the LAST executed-path step (the one that streams). Branching
   * nodes (condition/loop/fan) make the path uncertain, so we conservatively
   * report "more ahead".
   */
  const hasFurtherLlm = (fromId: string): boolean => {
    const visited = new Set<string>();
    const stack: string[] = [fromId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const tt = typeOf.get(cur);
      if (tt === "llm_call") return true;
      if (tt === "condition" || tt === "loop" || tt === "fan") return true;
      const edges = outgoing.get(cur);
      if (!edges || edges.length === 0) continue;
      if (edges.length !== 1) return true;
      stack.push(edges[0].to);
    }
    return false;
  };

  /**
   * The `join` node ids reachable from a `fan`'s branches — the stop boundary
   * for concurrent branch walks (branches run their content, then stop at the
   * join where their outputs recombine).
   */
  const collectJoinSet = (fanId: string): Set<string> => {
    const joins = new Set<string>();
    const visited = new Set<string>();
    const dfs = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      if (typeOf.get(id) === "join") {
        joins.add(id);
        return;
      }
      for (const e of outgoing.get(id) ?? []) dfs(e.to);
    };
    for (const e of outgoing.get(fanId) ?? []) dfs(e.to);
    return joins;
  };

  // ── execution state ──
  let state: GraphState = {
    lastResponse: null,
    lastContent: "",
    lastStatus: 0,
    error: null,
    variables: { ...(opts.variables ?? {}) },
  };
  const executed: string[] = [];
  const events: GraphEvent[] = [];
  let terminalStream: ReadableStream<Uint8Array> | null = null;

  const pushStep = (nodeId: string, st: GraphState): void => {
    events.push({
      type: "step",
      nodeId,
      index: events.filter((e) => e.type === "step").length,
      content: st.lastContent,
      status: st.lastStatus,
    });
  };

  const loopExit = (n: GraphNode): string | null => {
    const bodySet = new Set(n.body ?? []);
    const exit = (outgoing.get(n.id) ?? []).find((e) => !bodySet.has(e.to));
    return exit?.to ?? onlySuccessor(n.id);
  };

  const walk = async (
    nodeId: string,
    stopAt: Set<string>,
    st: GraphState,
  ): Promise<{ state: GraphState; current: string | null; executed: string[] }> => {
    let cur: string | null = nodeId;
    let curState = st;
    const exec: string[] = [];

    while (cur && !stopAt.has(cur)) {
      const n = byId.get(cur);
      if (!n) return { state: curState, current: null, executed: exec };
      if (n.type === "end") return { state: curState, current: null, executed: exec };

      switch (n.type) {
        case "start":
          cur = onlySuccessor(n.id);
          break;

        case "llm_call": {
          const provider =
            providers.get(n.provider ?? "") ?? providers.values().next().value;
          if (!provider) {
            curState = {
              ...curState,
              error: `[graph-engine] no provider for llm_call "${n.id}"`,
            };
            cur = null;
            break;
          }
          const nextId = onlySuccessor(n.id);
          const terminal = streamRequested && nextId !== null && !hasFurtherLlm(nextId);

          if (terminal) {
            // Last executed-path step: stream via buildStreamBody (one chunk).
            terminalStream = buildStreamBody(
              provider,
              payloadFor(n, opts.payload ?? {}, curState),
              signal,
              newCompletionId(),
              Math.floor(Date.now() / 1000),
              graph.name ?? graph.id,
            );
            exec.push(n.id);
            events.push({ type: "terminal", nodeId: n.id });
            return { state: curState, current: null, executed: exec };
          }

          let result: Record<string, unknown>;
          try {
            result = await provider.chat(payloadFor(n, opts.payload ?? {}, curState), graph.name);
          } catch (err) {
            // 429 fallback: reroute to the node named by `on_429` when present.
            const status = (err as Error & { status?: number }).status;
            if (status === 429 && n.on_429) {
              const target = byId.get(n.on_429);
              if (target) {
                curState = { ...curState, lastStatus: 429 };
                pushStep(n.id, curState);
                exec.push(n.id);
                cur = n.on_429;
                break;
              }
            }
            curState = {
              ...curState,
              error: String(err),
            };
            cur = null;
            break;
          }
          curState = applyLlmResult(curState, result);
          exec.push(n.id);
          pushStep(n.id, curState);

          // tool_calls routing: reroute to `tool_calls_route` when present.
          if (n.tool_calls_route && hasToolCalls(result)) {
            const target = byId.get(n.tool_calls_route);
            if (target) {
              cur = n.tool_calls_route;
              break;
            }
          }

          cur = nextId;
          break;
        }

        case "condition":
          cur = pickConditionBranch(n, curState);
          break;

        case "loop": {
          const bodyEntry = n.body?.[0];
          if (!bodyEntry) {
            curState = { ...curState, error: `[graph-engine] loop "${n.id}" has no body` };
            cur = null;
            break;
          }
          const loopBoundary = new Set([n.id]);
          // Run the body `maxLoops` times (bounded — prevents infinite cycles).
          for (let i = 0; i < Math.max(1, maxLoops); i++) {
            const sub = await walk(bodyEntry, loopBoundary, curState);
            curState = sub.state;
            exec.push(...sub.executed);
          }
          cur = loopExit(n);
          break;
        }

        case "fan": {
          if (n.parallel) {
            const joinSet = collectJoinSet(n.id);
            const branchStarts = outgoing.get(n.id)?.map((e) => e.to) ?? [];
            const results = await Promise.all(
              branchStarts.map((b) => walk(b, joinSet, curState)),
            );
            for (const r of results) {
              exec.push(...r.executed);
              curState = r.state;
            }
            // Continue from the join where the branches recombined.
            cur = joinSet.size > 0 ? [...joinSet][0] : onlySuccessor(n.id);
          } else {
            cur = onlySuccessor(n.id);
          }
          break;
        }

        case "join":
          cur = onlySuccessor(n.id);
          break;

        default:
          cur = onlySuccessor(n.id);
          break;
      }
    }

    return { state: curState, current: cur, executed: exec };
  };

  const final = await walk(start.id, new Set<string>(), state);
  state = final.state;
  executed.push(...final.executed);

  // ── assemble the final Response ──
  if (terminalStream) {
    const body = buildCombinedStream(events, terminalStream);
    return {
      executedLlmNodes: executed,
      events,
      lastResponse: state.lastResponse,
      lastContent: state.lastContent,
      lastStatus: state.lastStatus,
      response: new Response(body as ReadableStream, { status: 200, headers: SSE_HEADERS }),
    };
  }

  if (state.lastResponse !== null) {
    const body = state.lastResponse as Record<string, unknown>;
    body.model = graph.name ?? graph.id;
    return {
      executedLlmNodes: executed,
      events,
      lastResponse: body,
      lastContent: state.lastContent,
      lastStatus: state.lastStatus,
      response: new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS }),
    };
  }

  return {
    executedLlmNodes: executed,
    events,
    lastResponse: null,
    lastContent: state.lastContent,
    lastStatus: state.lastStatus,
    response: new Response(
      JSON.stringify({
        error: {
          message: "Graph produced no response",
          type: "server_error",
          param: null,
          code: null,
        },
      }),
      { status: 500, headers: JSON_HEADERS },
    ),
  };
}

// ── free helpers ───────────────────────────────────────────────────────────

/** Build a per-llm_call payload (non-streaming) from the original chat
 * payload and the flowing execution context. Message construction reuses the
 * linear engine's `buildStepMessages` so graph and linear engines produce
 * IDENTICAL prompts for the same chain (parity gate). */
function payloadFor(
  node: GraphNode,
  originalPayload: Record<string, unknown>,
  ctx: GraphState,
): Record<string, unknown> {
  const stepContext: StepContext = {
    lastResponse: ctx.lastResponse,
    lastContent: ctx.lastContent,
  };
  const messages = buildStepMessages(
    {
      type: node.mode ?? "generate",
      system: node.system,
      assistant: node.assistant,
      user: node.user,
    },
    originalPayload,
    stepContext,
  );
  const payload: Record<string, unknown> = {
    ...originalPayload,
    model: node.model ?? "unknown",
    messages,
    stream: false,
  };
  if (node.ctx !== undefined) {
    payload.params = { ...(node.params ?? {}), ctx: node.ctx };
  } else if (node.params && Object.keys(node.params).length > 0) {
    payload.params = { ...node.params };
  }
  return payload;
}

/** Apply an llm_call result to the execution state. */
function applyLlmResult(
  state: GraphState,
  result: Record<string, unknown>,
): GraphState {
  const content = extractContent(result);
  const status = typeof result.status === "number" ? result.status : 200;
  return {
    ...state,
    lastResponse: { content, status, ...result },
    lastContent: content,
    lastStatus: status,
  };
}

/** Combine `step` progress frames with the terminal stream into one SSE body. */
function buildCombinedStream(
  events: GraphEvent[],
  terminalStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames: Uint8Array[] = [];
  for (const ev of events) {
    if (ev.type === "step") {
      frames.push(enc.encode(`event: step\ndata: ${JSON.stringify(ev)}\n\n`));
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const f of frames) controller.enqueue(f);
        const reader = terminalStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Stable completion id (same shape as the linear engine). */
function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
