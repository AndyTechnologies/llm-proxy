/**
 * Parity fixtures (refactor-graph-canonical — Phase 7).
 *
 * Shares the 6 migrated chains and a call-recording fake provider for the
 * graph parity approval test. Each chain is expressed as a `GraphPipeline`
 * and paired with a recording provider that captures `(provider, model,
 * messages)` call sequences for comparison against the committed golden
 * snapshot.
 */
import type { Provider } from "../providers/types.js";
import type { GraphNode, GraphEdge, GraphPipeline } from "./graph.js";

/** A single recorded LLM call, comparable across engine runs. */
export interface RecordedCall {
  /** Provider name that served the call. */
  provider: string;
  /** The payload model sent to the provider. */
  model: string;
  /** The message array sent to the provider. */
  messages: Array<Record<string, unknown>>;
}

/** A recording fake provider — records every `chat` call for later diffing. */
export function recordingProvider(name: string, calls: RecordedCall[]): Provider {
  return {
    name,
    async chat(
      payload: Record<string, unknown>,
      _chainName?: string,
    ): Promise<Record<string, unknown>> {
      calls.push({
        provider: name,
        model: (payload.model as string) ?? "",
        messages: (payload.messages as Array<Record<string, unknown>>) ?? [],
      });
      return {
        status: 200,
        choices: [{ message: { content: `out-${name}` } }],
      };
    },
    async *chatStream(_payload: Record<string, unknown>, _signal: AbortSignal) {
      yield JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
      });
    },
  };
}

/** Build a graph pipeline (start → llm_call* → end). */
function graphTwin(
  name: string,
  displayName: string,
  steps: Array<{
    name: string;
    type: "generate" | "refine" | "passthrough";
    model: string;
    on_429?: string;
    tool_calls_route?: string;
  }>,
): GraphPipeline {
  const nodes: GraphNode[] = [{ id: "start", type: "start" }];
  const edges: GraphEdge[] = [];
  steps.forEach((s, i) => {
    nodes.push({
      id: s.name,
      type: "llm_call",
      model: s.model,
      provider: "llama-server",
      mode: s.type,
      ...(s.on_429 ? { on_429: s.on_429 } : {}),
      ...(s.tool_calls_route ? { tool_calls_route: s.tool_calls_route } : {}),
    });
    const from = i === 0 ? "start" : steps[i - 1].name;
    edges.push({ from, to: s.name });
  });
  const lastId = steps.length === 0 ? "start" : steps[steps.length - 1].name;
  nodes.push({ id: "end", type: "end" });
  edges.push({ from: lastId, to: "end" });
  return { id: name, name: displayName, nodes, edges };
}

/**
 * The 6 migrated chains. Each entry exposes its graph `GraphPipeline` and
 * the provider map (all point at `llama-server`).
 */
export interface ParityChain {
  id: string;
  graph: GraphPipeline;
  /** The provider map — all resolve `llama-server` to a recording provider. */
  providers: Map<string, Provider>;
  /** Where that recording provider records its `chat` calls. */
  calls: RecordedCall[];
}

const STEP_SETS: Array<{
  id: string;
  display: string;
  steps: Array<{
    name: string;
    type: "generate" | "refine" | "passthrough";
    model: string;
    on_429?: string;
    tool_calls_route?: string;
  }>;
}> = [
  {
    id: "orchestrator",
    display: "Orchestrator",
    steps: [
      { name: "generate", type: "generate", model: "SmolLM3-3B" },
      { name: "refine-coder", type: "refine", model: "Qwen2.5-Coder-3B-Instruct" },
      { name: "refine-phi", type: "refine", model: "Phi-4-Mini-Instruct" },
      { name: "refine-llama", type: "refine", model: "Llama3.2-3B-Instruct" },
    ],
  },
  {
    id: "thinker",
    display: "Thinker",
    steps: [
      { name: "refine", type: "refine", model: "Phi-4-Mini-Instruct" },
      { name: "generate", type: "generate", model: "Llama3.2-3B-Instruct" },
    ],
  },
  {
    id: "coder",
    display: "Coder",
    steps: [
      { name: "generate", type: "generate", model: "Qwen2.5-Coder-3B-Instruct" },
      { name: "refine-phi", type: "refine", model: "Phi-4-Mini-Instruct" },
      { name: "refine-coder", type: "refine", model: "Qwen2.5-Coder-3B-Instruct" },
      { name: "refine-llama", type: "refine", model: "Llama3.2-3B-Instruct" },
    ],
  },
  {
    id: "verifier",
    display: "Judge",
    steps: [
      { name: "generate", type: "generate", model: "SmolLM3-3B" },
      { name: "refine-coder", type: "refine", model: "Qwen2.5-Coder-3B-Instruct" },
      { name: "refine-phi", type: "refine", model: "Phi-4-Mini-Instruct" },
      { name: "refine-llama", type: "refine", model: "Llama3.2-3B-Instruct" },
    ],
  },
  {
    id: "fallback-demo",
    display: "Fallback Demo",
    steps: [
      { name: "primary", type: "generate", model: "SmolLM3-3B", on_429: "fallback" },
      { name: "fallback", type: "generate", model: "Phi-4-Mini-Instruct" },
    ],
  },
  {
    id: "tool-demo",
    display: "Tool Demo",
    steps: [
      {
        name: "planner",
        type: "generate",
        model: "Llama3.2-3B-Instruct",
        tool_calls_route: "tool_executor",
      },
      { name: "tool_executor", type: "refine", model: "Phi-4-Mini-Instruct" },
    ],
  },
];

/** All 6 parity chains as graph pipelines with a shared provider map. */
export function parityChains(): ParityChain[] {
  return STEP_SETS.map(({ id, display, steps }) => {
    const calls: RecordedCall[] = [];
    const providers = new Map<string, Provider>();
    providers.set("llama-server", recordingProvider("llama-server", calls));
    return {
      id,
      graph: graphTwin(id, display, steps),
      providers,
      calls,
    };
  });
}

/** The canonical order of the 6 chain ids (snapshot key order). */
export const PARITY_IDS = STEP_SETS.map((s) => s.id);
