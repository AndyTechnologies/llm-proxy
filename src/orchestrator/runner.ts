/**
 * Workflow runner contract (Tasks 6.6 / 6.10).
 *
 * The runner turns a stored workflow into an OpenAI-shaped completion — the
 * same surface a chain sees — so the /api run endpoint and the
 * gateway/name virtual model share one path. makeWorkflowRunner (the
 * implementation) lives here with makeRuntimeServices; the interface is
 * defined first so the API layer and routes can depend on it without a
 * concrete engine backend.
 */
import type { ChatMessage, EngineEvent, EngineServices } from "./engine.js";
import { runGraphEngine } from "./engine.js";
import { validateGraph } from "./graph.js";
import type { GraphNode, GraphPipeline } from "./graph.js";
import { parseWorkflowGraph } from "./workflow-yaml.js";
import { chatWithFallback } from "../providers/fallback.js";
import { extractContent } from "../utils/extract.js";
import { makeChatCompletionId } from "../utils/ids.js";
import type { Provider } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Embedder } from "../providers/embeddings.js";
import type { ChunkStore } from "../rag/chunks.js";
import type { MemoryStore } from "../rag/memory.js";
import type { WorkflowStore } from "./store.js";

/** Runtime seam bundle the runner needs to turn stored work into LLM work. */
export interface RuntimeDeps {
  registry: ProviderRegistry;
  /** The managed llama-server backend provider, or null when unavailable. */
  localProvider: () => Provider | null;
  /** Model ids the managed backend currently serves. */
  localModels: () => string[];
  /** The workflow store (source of stored graphs + execution log). */
  store: WorkflowStore;
  /** Sandboxed code runner (`data.code`). */
  sandbox: (code: string, input: unknown, opts: { signal: AbortSignal }) => Promise<{
    ok: boolean;
    stdout: string;
    error: string | null;
  }>;
  /** Embedder over the managed backend, or null when absent. */
  embedder: () => Embedder | null;
  /** Vector store for rag_local retrieval, or null when absent. */
  chunks: () => ChunkStore | null;
  /** Conversation memory store, or null when absent. */
  memory: () => MemoryStore | null;
}

/**
 * The engine's injected side-effect seam bound to real runtime pieces:
 * llm_call → provider registry / local backend; data.code → sandbox;
 * rag_local/embeddings → Embedder + ChunkStore; memory → MemoryStore;
 * pipeline composition → stored workflows parsed live from the store.
 */
export function makeRuntimeServices(deps: RuntimeDeps): EngineServices {
  return {
    async call(node: GraphNode, messages: ChatMessage[], _signal: AbortSignal) {
      const model = node.model ?? "";
      const local = deps.localProvider();
      let kind: string | null = null;
      if (local !== null && deps.localModels().includes(model)) {
        const res = await local.chat({ model, messages });
        return { status: 200, content: extractContent(res) };
      }
      for (const adapter of deps.registry.adapters.values()) {
        if (adapter.models.includes(model)) {
          kind = adapter.kind;
          break;
        }
      }
      if (kind === null) throw new Error(`unknown model "${model}"`);
      const res = await chatWithFallback(deps.registry, kind, { model, messages, stream: false });
      return { status: 200, content: extractContent(res) };
    },

    async runCode(code, input, opts) {
      const r = await deps.sandbox(code, input, opts);
      return { ok: r.ok, stdout: r.stdout, error: r.error ?? undefined };
    },

    async embed(text) {
      const embedder = deps.embedder();
      if (embedder === null) throw new Error("no embedder configured");
      const res = await embedder.embed(text);
      const first = res.data?.[0]?.embedding;
      if (first === undefined) throw new Error("embedding response has no vector");
      return Float32Array.from(first);
    },

    async retrieve(vector, k) {
      const chunks = deps.chunks();
      if (chunks === null) return [];
      return chunks.search(vector, k);
    },

    async loadMemory(convId, limit) {
      const memory = deps.memory();
      if (memory === null) return [];
      return memory.recent(convId, limit).map((m) => ({ role: m.role, content: m.content }));
    },

    async storeMemory(convId, role, content) {
      deps.memory()?.record(convId, role, content);
    },

    graphMap() {
      const map = new Map<string, GraphPipeline>();
      for (const record of deps.store.list()) {
        const doc = deps.store.get(record.name);
        if (doc === null) continue;
        try {
          const parsed = parseWorkflowGraph(doc.yaml);
          map.set(parsed.graph.id, parsed.graph);
        } catch {
          // Corrupt workflows are invisible to pipeline composition; the
          // runner still surfaces them (with their own 502) when invoked.
        }
      }
      return map;
    },
  };
}

function buildCompletion(name: string, content: string): ChainCompletion {
  return {
    id: makeChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: `gateway/${name}`,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: null,
  };
}

export interface WorkflowRunnerDeps {
  store: WorkflowStore;
  services: EngineServices;
}

/** Execute stored workflows as OpenAI-shaped completions. */
export function makeWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  return {
    ids() {
      return deps.store.list().map((r) => r.name);
    },

    async run(name, body, signal, onEvent) {
      const record = deps.store.get(name);
      if (record === null) return { ok: false, status: 404, error: "model_not_found" };
      const startedAt = new Date().toISOString();
      const t0 = Date.now();

      let graph: ReturnType<typeof parseWorkflowGraph>["graph"];
      try {
        graph = parseWorkflowGraph(record.yaml).graph;
      } catch (err) {
        deps.store.recordExecution(name, {
          status: "error",
          error: String((err as Error).message),
          startedAt,
          ms: Date.now() - t0,
        });
        return { ok: false, status: 502, error: String((err as Error).message) };
      }
      const validation = validateGraph(graph, {});
      if (!validation.ok) {
        const error = validation.errors[0] ?? "workflow failed validation";
        deps.store.recordExecution(name, { status: "error", error, startedAt, ms: Date.now() - t0 });
        return { ok: false, status: 502, error };
      }

      const result = await runGraphEngine({
        graph,
        services: deps.services,
        input: { messages: body.messages, convId: "default" },
        signal: signal ?? new AbortController().signal,
        onEvent,
      });
      if (!result.ok) {
        const error = result.error ?? "workflow execution failed";
        deps.store.recordExecution(name, { status: "error", error, startedAt, ms: Date.now() - t0 });
        return { ok: false, status: 502, error };
      }
      deps.store.recordExecution(name, { status: "ok", startedAt, ms: Date.now() - t0 });
      return { ok: true, output: buildCompletion(name, result.output?.content ?? "") };
    },
  };
}

/** The OpenAI-shaped completion the runner yields (workflow = assistant turn). */
export interface ChainCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop";
    },
  ];
  usage: null;
}

export type RunResult =
  | { ok: true; output: ChainCompletion }
  | { ok: false; status: number; error: string };

export interface WorkflowRunner {
  /** Names of every workflow that can be run. */
  ids(): string[];
  /**
   * Run a stored workflow by name with an OpenAI chat body. Unknown name →
   * `{ ok: false, status: 404 }` (model_not_found); engine failure →
   * `{ ok: false, status: 502 }`. Each accepted run is recorded in the
   * workflow's execution log before resolving.
   */
  run(
    name: string,
    body: { messages: ChatMessage[] },
    signal?: AbortSignal,
    /**
     * Engine telemetry sink (websocket-streaming). When provided, the runner
     * forwards step/reroute/run lifecycle events as they happen.
     */
    onEvent?: (event: EngineEvent) => void,
  ): Promise<RunResult>;
}