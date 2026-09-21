/**
 * Unified graph engine (Phase 6.2).
 *
 * Executes EVERY pipeline — linear, conditional, parallel, looping — through
 * a single walk scheduler over the effective adjacency the validator uses
 * (graph.ts). There is no linear engine and no hybrid selector: `runChain`
 * is an alias of `runGraphEngine`.
 *
 * Semantics:
 *  - nodes run when all their effective predecessors have completed
 *    (fan-out is naturally concurrent; `join` is a fan-in gate)
 *  - `condition`/`router` follow only guard-matching edges (sequential-guarded)
 *  - `llm_call` reroutes via `on_429` / `tool_calls_route` after execution
 *  - `join` aggregates its direct predecessors' outputs into a `drafts`
 *    variable; a downstream synthesis consumes every draft (MoA 3+1 shape)
 *  - `loop` runs its body (sequential member array) `iterations` times
 *  - `pipeline` composes registered graphs with a bounded depth; composed
 *    steps surface in the outer event stream and results ledger
 *  - failures stop the graph, keep prior outputs, and surface as
 *    `step:error` + `run:complete {ok:false}` events
 *  - all node side effects go through the injected `EngineServices` seam —
 *    the engine itself is pure orchestration (unit-testable with fakes)
 */
import {
  evaluateAst,
  type AstContext,
  type GraphNode,
  type GraphPipeline,
  type NodeType,
} from "./graph.js";

// ── Shared types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

/** The engine's branch-local execution context. */
export interface EngineBranch {
  /** The last executed node's OpenAI-ish response (status/content). */
  lastResponse: { status: number; content: string } | null;
  /** Variables (embedding, sources, code outputs…) — merged at joins. */
  variables: Record<string, unknown>;
  /** Original request messages (generate-mode payload base). */
  messages: ChatMessage[];
  /** Memory rows injected by a `memory` node. */
  history: ChatMessage[];
  /** Conversation scope id for memory nodes. */
  convId: string | null;
}

export interface NodeResult {
  nodeId: string;
  status: "ok" | "error" | "rerouted";
  output: unknown;
  error?: string;
  ms: number;
}

export type EngineEvent =
  | { type: "run:start"; ts: number }
  | { type: "step:start"; nodeId: string; nodeType: NodeType; ts: number }
  | { type: "step:complete"; nodeId: string; status: "ok"; ms: number; ts: number }
  | { type: "step:error"; nodeId: string; error: string; ms: number; ts: number }
  | {
      type: "reroute";
      from: string;
      to: string;
      reason: "on_429" | "tool_calls";
      ts: number;
    }
  | { type: "run:complete"; ok: boolean; error: string | null; ms: number; ts: number };

/** Result of one llm_call execution (OpenAI-ish wire response). */
export interface CallOutcome {
  status: number;
  content: string;
  toolCalls?: unknown[];
}

/** Injected side-effect seam for the engine (all I/O lives here). */
export interface EngineServices {
  /** Execute one `llm_call` against its resolved provider/model. */
  call: (node: GraphNode, messages: ChatMessage[], signal: AbortSignal) => Promise<CallOutcome>;
  /** Run one `data.code` node in the sandbox. */
  runCode: (
    code: string,
    input: unknown,
    opts: { signal: AbortSignal },
  ) => Promise<{ ok: boolean; stdout: string; error?: string }>;
  /** Embed text for `rag_local` / `embeddings` nodes. */
  embed: (text: string) => Promise<Float32Array>;
  /** Top-k retrieval for `rag_local`. */
  retrieve: (vector: Float32Array, k: number) => Promise<Array<{ doc: string; text: string; score: number }>>;
  /** Load recent conversation rows for a `memory` node. */
  loadMemory: (convId: string, limit: number) => Promise<ChatMessage[]>;
  /** Persist a conversation row (memory write side). */
  storeMemory: (convId: string, role: string, content: string) => Promise<void>;
  /** Registered pipeline lookup for `pipeline` composition nodes. */
  graphMap: () => ReadonlyMap<string, GraphPipeline>;
}

export interface RunGraphOptions {
  graph: GraphPipeline;
  services: EngineServices;
  input: { messages: ChatMessage[]; convId?: string };
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Progress/telemetry sink; events are also accumulated in the result. */
  onEvent?: (event: EngineEvent) => void;
  /** Pipeline-composition depth bound (default 5). */
  maxDepth?: number;
}

export interface RunGraphResult {
  ok: boolean;
  /** Final `lastResponse` when the graph reached an `end` node. */
  output: { status: number; content: string; toolCalls?: unknown[] } | null;
  error: string | null;
  events: EngineEvent[];
  results: NodeResult[];
  variables: Record<string, unknown>;
  ms: number;
}

// ── Message construction (graph-engine Req "Message refeed") ───────────────

export interface StepMessageState {
  original: ChatMessage[];
  lastContent: string | null;
  history: ChatMessage[];
  /**
   * Drafts aggregated by a preceding `join` (MoA): an array of the joined
   * branches' output contents. Folded into the payload as numbered user
   * turns so a synthesis node consumes every branch, not just the last.
   */
  drafts?: unknown;
}

/**
 * Build the llm_call payload messages from the original request + context.
 * `generate` sends the original messages with memory history folded in after
 * any system rows (and before the user turns); `refine` refeeds the previous
 * node's content as a trailing user turn; `passthrough` forwards the
 * originals unchanged (the linear-chain twin, graph-native).
 *
 * Multi-armed (MoA) shape: when a `join` aggregated `drafts`, they fold in
 * after history and before the tail — `Draft 1: <content>`, `Draft 2: …` —
 * so a synthesis node consumes every branch output.
 */
export function buildStepMessages(node: GraphNode, state: StepMessageState): ChatMessage[] {
  const history = state.history ?? [];
  switch (node.mode ?? "generate") {
    case "refine": {
      const refeed: ChatMessage[] =
        state.lastContent === null ? [] : [{ role: "user", content: state.lastContent }];
      return [...withScaffolds(node, state.original, history, state.drafts), ...refeed];
    }
    case "passthrough":
      return [...state.original];
    case "generate":
    default:
      return withScaffolds(node, state.original, history, state.drafts);
  }
}

/** Aggregated drafts → numbered user turns (malformed input → none). */
function toDraftTurns(drafts: unknown): ChatMessage[] {
  if (!Array.isArray(drafts)) return [];
  const turns: ChatMessage[] = [];
  let n = 0;
  for (const draft of drafts) {
    if (typeof draft !== "string") continue;
    n += 1;
    turns.push({ role: "user", content: `Draft ${n}:\n${draft}` });
  }
  return turns;
}

/** Original messages, keeping system rows first, history folded after them. */
function withScaffolds(
  node: GraphNode,
  original: ChatMessage[],
  history: ChatMessage[],
  drafts?: unknown,
): ChatMessage[] {
  const sys =
    node.system !== undefined
      ? [{ role: "system", content: node.system }]
      : original.filter((m) => m.role === "system");
  const assistant =
    node.assistant !== undefined ? [{ role: "assistant", content: node.assistant }] : [];
  return [
    ...sys,
    ...history,
    ...toDraftTurns(drafts),
    ...original.filter((m) => m.role !== "system"),
    ...assistant,
  ];
}

// ── Effective adjacency (mirrors graph.ts validator connectivity) ───────────

interface WalkAdjacency {
  out: Map<string, string[]>;
  in: Map<string, string[]>;
}

/**
 * Effective walk edges. A loop node's edges into its own body and back edges
 * from body members are consumed: the loop runner owns body entry/exit, so
 * body members are never scheduled by the walk scheduler (that would double
 * them). Unknown edges (edges to/from ids without a node) are ignored.
 */
function buildWalkAdjacency(graph: GraphPipeline): WalkAdjacency {
  const loopBodies = new Map<string, string[]>();
  const bodyOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.type === "loop" && Array.isArray(n.body) && n.body.length > 0) {
      loopBodies.set(n.id, n.body);
      for (const memberId of n.body) bodyOf.set(memberId, n.id);
    }
  }
  const out = new Map<string, string[]>();
  const push = (from: string, to: string): void => {
    const list = out.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    out.set(from, list);
  };
  for (const e of graph.edges) {
    if (bodyOf.has(e.from)) continue; // stale exit from a loop body member
    const body = loopBodies.get(e.from);
    if (body !== undefined && body.includes(e.to)) continue; // loop → own body
    push(e.from, e.to);
  }
  // Loop body auto-chain: member[i] → member[i+1] (the back edge to the loop
  // is consumed by the loop runner).
  for (const n of graph.nodes) {
    if (n.type !== "loop" || !Array.isArray(n.body) || n.body.length === 0) continue;
    const seq = n.body;
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] && seq[i + 1]) push(seq[i], seq[i + 1]);
    }
  }
  const inMap = new Map<string, string[]>();
  for (const [from, tos] of out) {
    for (const to of tos) {
      const list = inMap.get(to) ?? [];
      list.push(from);
      inMap.set(to, list);
    }
  }
  return { out, in: inMap };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

interface SchedulerState extends EngineBranch {
  results: NodeResult[];
  events: EngineEvent[];
  startMs: number;
}

export async function runGraphEngine(opts: RunGraphOptions): Promise<RunGraphResult> {
  const startMs = Date.now();
  const { graph, services, input, onEvent } = opts;
  const adj = buildWalkAdjacency(graph);
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);

  const state: SchedulerState = {
    lastResponse: { status: 200, content: "" },
    variables: { ...(opts.variables ?? {}) },
    messages: input.messages,
    history: [],
    convId: input.convId ?? null,
    results: [],
    events: [],
    startMs,
  };

  const emit = (e: EngineEvent): void => {
    state.events.push(e);
    onEvent?.(e);
  };
  emit({ type: "run:start", ts: startMs });

  const runAbort = new AbortController();
  const externalAbort = opts.signal;
  if (externalAbort !== undefined) {
    if (externalAbort.aborted) runAbort.abort();
    else externalAbort.addEventListener("abort", () => runAbort.abort(), { once: true });
  }
  const signal = runAbort.signal;

  const pending = new Map<string, number>();
  const done = new Set<string>();
  // Failures push here (not a `let` flag): TS cannot see assignments made
  // inside the drainPending closure, which narrows a plain variable to its
  // initializer and makes the failure object unreachable at the final read.
  const failures: Array<{ nodeId: string; error: string }> = [];

  // Indegree over effective adjacency; reroute targets get no static edges.
  for (const n of graph.nodes) {
    const froms = adj.in.get(n.id) ?? [];
    pending.set(n.id, froms.length);
  }
  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    return fail(startMs, `graph "${graph.id}" must have exactly one start node`, state, emit);
  }
  const queue: string[] = [starts[0].id];

  // One node completes its gate → execute it and fan out to successors.
  const drainPending = async (id: string): Promise<void> => {
    if (done.has(id)) return;
    pending.set(id, -1); // running
    const node = byId.get(id);
    if (!node) return;
    const outcome = await executeNode(node, adj, byId, state, services, signal, opts.maxDepth ?? 5, emit);
    done.add(id);
    if (!outcome.ok) {
      state.results.push(outcome.result); // failed nodes are still recorded
      failures.push({ nodeId: id, error: outcome.error ?? "node failed" });
      runAbort.abort();
      return;
    }
    mergeBranch(state, outcome.branch);
    // `start`/`end` are structural gates, not executed work — leave them out
    // of the results ledger (fan/join/output are real work and are kept).
    if (node.type !== "start" && node.type !== "end") state.results.push(outcome.result);
    // Reroute edges replace the normal successor set. Reroute targets have no
    // real in-edges (the validator only makes them reachable), so they are
    // forced past the static gate instead of decremented into it.
    if (outcome.rerouteTo !== undefined) {
      const to = outcome.rerouteTo;
      if (byId.has(to) && !done.has(to) && failures.length === 0) {
        pending.set(to, 0);
        queue.push(to);
      }
    } else {
      for (const to of pickSuccessors(adj, graph, node, outcome.guard)) {
        const p = pending.get(to);
        if (p === undefined || p <= 0) continue;
        pending.set(to, p - 1);
        if (pending.get(to) === 0) queue.push(to);
      }
    }
    // The outer processQueue loop re-checks the queue after this wave; no
    // nested drain here — reentrant runs would steal the queue and let the
    // outer loop read state before the final merges land.
  };

  const processQueue = async (): Promise<void> => {
    while (queue.length > 0 && failures.length === 0) {
      const wave = [...queue];
      queue.length = 0;
      await Promise.all(wave.map((id) => drainPending(id)));
    }
  };

  // Kick off from the start node (gate 0 by construction).
  pending.set(starts[0].id, 0);
  await processQueue();

  const ms = Date.now() - startMs;
  const failure = failures[0] ?? null;
  if (failure !== null) {
    emit({ type: "run:complete", ok: false, error: failure.error, ms, ts: Date.now() });
    return {
      ok: false,
      output: state.lastResponse,
      error: failure.error,
      events: state.events,
      results: state.results,
      variables: state.variables,
      ms,
    };
  }
  const ended = graph.nodes.filter((n) => n.type === "end").length > 0
    ? state.lastResponse
    : null;
  emit({ type: "run:complete", ok: true, error: null, ms, ts: Date.now() });
  return {
    ok: true,
    output: ended,
    error: null,
    events: state.events,
    results: state.results,
    variables: state.variables,
    ms,
  };
}

function fail(
  startMs: number,
  error: string,
  state: SchedulerState,
  emit: (e: EngineEvent) => void,
): RunGraphResult {
  const ms = Date.now() - startMs;
  emit({ type: "run:complete", ok: false, error, ms, ts: Date.now() });
  return { ok: false, output: null, error, events: state.events, results: [], variables: state.variables, ms };
}

/** Guard-based successor selection for condition/router nodes. */
function pickSuccessors(
  adj: WalkAdjacency,
  graph: GraphPipeline,
  node: GraphNode,
  guard: boolean | undefined,
): string[] {
  const edgeTargets = (adj.out.get(node.id) ?? []).filter((to) => {
    if (node.type !== "condition" && node.type !== "router") return true;
    const matching = graph.edges.filter((e) => e.from === node.id && e.to === to);
    if (matching.length === 0) return true;
    return matching.some((e) => e.guard === String(guard));
  });
  return edgeTargets;
}

// ── Node execution ───────────────────────────────────────────────────────────

interface NodeOutcome {
  ok: boolean;
  error?: string;
  branch: EngineBranch;
  result: NodeResult;
  rerouteTo?: string;
  guard?: boolean;
}

function astContext(state: EngineBranch): AstContext {
  return {
    lastResponse: state.lastResponse,
    error: null,
    variables: state.variables,
  };
}

async function executeNode(
  node: GraphNode,
  adj: WalkAdjacency,
  byId: Map<string, GraphNode>,
  state: SchedulerState,
  services: EngineServices,
  signal: AbortSignal,
  depth: number,
  emit: (e: EngineEvent) => void,
): Promise<NodeOutcome> {
  const started = Date.now();
  emit({ type: "step:start", nodeId: node.id, nodeType: node.type, ts: started });
  const branch: EngineBranch = { ...state, variables: { ...state.variables }, history: [...state.history] };

  const okOutcome = (result: NodeResult, extra: Partial<NodeOutcome> = {}): NodeOutcome => {
    emit({ type: "step:complete", nodeId: node.id, status: "ok", ms: result.ms, ts: Date.now() });
    return {
      ok: true,
      branch,
      result,
      ...extra,
    };
  };
  const errOutcome = (error: string, extra: Partial<NodeOutcome> = {}): NodeOutcome => {
    const ms = Date.now() - started;
    emit({ type: "step:error", nodeId: node.id, error, ms, ts: Date.now() });
    return { ok: false, error, branch, result: { nodeId: node.id, status: "error", output: null, error, ms }, ...extra };
  };

  try {
    switch (node.type) {
      case "start":
      case "end":
      case "fan":
      case "output": {
        const output = node.type === "end" ? state.lastResponse : branch.lastResponse;
        branch.lastResponse = output;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output,
          ms: Date.now() - started,
        });
      }

      case "llm_call": {
        const messages = buildStepMessages(node, {
          original: state.messages,
          lastContent: state.lastResponse?.content ?? null,
          history: state.history,
          drafts: state.variables["drafts"],
        });
        let outcome: CallOutcome;
        try {
          outcome = await services.call(node, messages, signal);
        } catch (err) {
          const status = (err as { status?: unknown } | null)?.status;
          if (status === 429 && node.on_429 !== undefined && node.on_429 !== "") {
            emit({
              type: "reroute",
              from: node.id,
              to: node.on_429,
              reason: "on_429",
              ts: Date.now(),
            });
            return okOutcome(
              {
                nodeId: node.id,
                status: "rerouted",
                output: null,
                ms: Date.now() - started,
              },
              { rerouteTo: node.on_429 },
            );
          }
          const message = err instanceof Error ? err.message : "llm_call failed";
          return errOutcome(message);
        }
        const r: { status: number; content: string; toolCalls?: unknown[] } = {
          status: outcome.status,
          content: outcome.content,
        };
        if (outcome.toolCalls !== undefined) r.toolCalls = outcome.toolCalls;
        branch.lastResponse = r;
        await services.storeMemory(
          branch.convId ?? "default",
          "assistant",
          outcome.content,
        ).catch(() => {});
        if (
          Array.isArray(outcome.toolCalls) &&
          outcome.toolCalls.length > 0 &&
          node.tool_calls_route !== undefined &&
          node.tool_calls_route !== ""
        ) {
          emit({
            type: "reroute",
            from: node.id,
            to: node.tool_calls_route,
            reason: "tool_calls",
            ts: Date.now(),
          });
          return okOutcome(
            { nodeId: node.id, status: "rerouted", output: r, ms: Date.now() - started },
            { rerouteTo: node.tool_calls_route },
          );
        }
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: r,
          ms: Date.now() - started,
        });
      }

      case "condition":
      case "router": {
        if (node.condition === undefined) return errOutcome("condition node missing its expression");
        const result = evaluateAst(node.condition, astContext(branch));
        branch.variables["condition.last"] = result;
        return okOutcome(
          { nodeId: node.id, status: "ok", output: result, ms: Date.now() - started },
          { guard: result },
        );
      }

      case "join": {
        // The gate guarantees every predecessor ran; lastResponse holds the
        // most recent completed branch's output (variables already merged).
        // MoA shape: aggregate the DIRECT predecessors' outputs into a
        // `drafts` variable so a downstream synthesis consumes every branch.
        const drafts: string[] = [];
        for (const predId of adj.in.get(node.id) ?? []) {
          const pred = state.results.find((r) => r.nodeId === predId && r.status === "ok");
          const content = (pred?.output as { content?: unknown } | null)?.content;
          if (typeof content === "string") drafts.push(content);
        }
        if (drafts.length > 0) branch.variables["drafts"] = drafts;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: branch.lastResponse,
          ms: Date.now() - started,
        });
      }

      case "memory": {
        const convId = node.convId ?? branch.convId ?? "default";
        const rows = await services.loadMemory(convId, 10);
        branch.history = rows;
        branch.convId = convId;
        const content = rows.map((r) => r.content).join("\n");
        branch.lastResponse = { status: 200, content };
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: { status: 200, content },
          ms: Date.now() - started,
        });
      }

      case "data.code": {
        if (node.code === undefined || node.code.trim() === "")
          return errOutcome("data.code node missing its code field");
        const input = state.lastResponse?.content ?? "";
        const run = await services.runCode(node.code, input, { signal });
        if (!run.ok) return errOutcome(run.error ?? "sandbox execution failed");
        branch.lastResponse = { status: 200, content: run.stdout };
        branch.variables["lastOutput"] = run.stdout;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: { status: 200, content: run.stdout },
          ms: Date.now() - started,
        });
      }

      case "embeddings": {
        const text = node.text ?? state.lastResponse?.content ?? "";
        const vector = await services.embed(text);
        branch.variables["embedding"] = Array.from(vector);
        const content = `embedding:${vector.length} dims`;
        branch.lastResponse = { status: 200, content };
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: { status: 200, content },
          ms: Date.now() - started,
        });
      }

      case "rag_local": {
        const query = state.lastResponse?.content ?? "";
        const k = node.k ?? 4;
        const vector = await services.embed(query);
        const chunks = await services.retrieve(vector, k);
        const generate = (messages: ChatMessage[]): Promise<string> =>
          services.call(node, messages, signal).then((r) => r.content);
        const system =
          chunks.length === 0
            ? "No relevant context was found for this query. State that clearly, then answer " +
              "from general knowledge — never invent citations."
            : `Answer the user's question using ONLY the retrieved context below. ` +
              `Cite the source of each claim as [n].\n\nContext:\n${chunks
                .map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`)
                .join("\n")}`;
        const answer = await generate([
          { role: "system", content: system },
          { role: "user", content: query },
        ]);
        branch.lastResponse = { status: 200, content: answer };
        branch.variables["sources"] = chunks;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: { status: 200, content: answer },
          ms: Date.now() - started,
        });
      }

      case "loop": {
        if (!Array.isArray(node.body) || node.body.length === 0)
          return errOutcome("loop node missing its body");
        const iterations = node.iterations ?? 1;
        if (iterations < 1) return errOutcome("loop iterations must be ≥ 1");
        const bodyNodes: GraphNode[] = [];
        for (const memberId of node.body) {
          const member = byId.get(memberId);
          if (member === undefined) {
            return errOutcome(`loop body references unknown node "${memberId}"`);
          }
          bodyNodes.push(member);
        }
        let last = branch.lastResponse;
        for (let i = 0; i < iterations; i++) {
          if (signal.aborted) return errOutcome("aborted during loop");
          for (const member of bodyNodes) {
            const inner = await executeNode(member, adj, byId, state, services, signal, depth, emit);
            if (!inner.ok) return inner;
            mergeBranch(state, inner.branch);
            state.results.push(inner.result);
            if (inner.rerouteTo !== undefined) {
              state.lastResponse = { status: 200, content: "" };
              return errOutcome("reroute inside loop bodies is not supported");
            }
            last = inner.branch.lastResponse;
          }
        }
        branch.lastResponse = last;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: last,
          ms: Date.now() - started,
        });
      }

      case "pipeline": {
        if (node.pipeline === undefined) return errOutcome("pipeline node missing its name");
        if (depth <= 0) return errOutcome("pipeline composition depth exceeded");
        const target = services.graphMap().get(node.pipeline);
        if (target === undefined) return errOutcome(`pipeline "${node.pipeline}" is not registered`);
        const inner = await runGraphEngine({
          graph: target,
          services,
          input: {
            messages: [{ role: "user", content: state.lastResponse?.content ?? "" }],
            convId: branch.convId ?? undefined,
          },
          variables: branch.variables,
          maxDepth: depth - 1,
          // Surface composed steps in the outer event stream (step:*, token,
          // reroute) but suppress the inner run:* bookends — one run pair per
          // workflow run.
          onEvent: (e) => {
            if (e.type !== "run:start" && e.type !== "run:complete") emit(e);
          },
        });
        if (!inner.ok) return errOutcome(inner.error ?? "composed pipeline failed");
        // Flatten the composed ledger into the outer results (same rule as
        // loop body members: real executed work stays visible).
        state.results.push(...inner.results);
        branch.lastResponse = inner.output;
        return okOutcome({
          nodeId: node.id,
          status: "ok",
          output: inner.output,
          ms: Date.now() - started,
        });
      }

      default: {
        return errOutcome(`unsupported node type "${node.type}"`);
      }
    }
  } catch (err) {
    return errOutcome(err instanceof Error ? err.message : "node execution failed");
  }
}

/** Merge a completed branch back into the shared state (join recombination). */
function mergeBranch(state: SchedulerState, branch: EngineBranch): void {
  state.lastResponse = branch.lastResponse;
  state.variables = { ...state.variables, ...branch.variables };
  state.history = branch.history;
  state.convId = branch.convId;
}

/** runChain — the graph-native alias (no separate linear engine exists). */
export const runChain = runGraphEngine;