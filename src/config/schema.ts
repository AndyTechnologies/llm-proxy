/**
 * zod schema for the gateway config file (llm-proxy.config.yaml / .json).
 *
 * The config defines the HTTP server settings, the managed llama backend
 * (binary, models, router args), and the chain definitions used by the
 * orchestrator. Zod validation runs at startup so an invalid config fails
 * fast with a clear message instead of failing halfway through a request.
 *
 * MIGRATION NOTE: the old `llamaServer` (static host:port) section has been
 * replaced by the managed `llama` section (binary, models, router args, etc.)
 * in the backend-management capability. The provider and proxy now derive
 * the backend URL from the manager's dynamic port.
 */
import { z } from "zod";
import type { AstExpr } from "../orchestrator/graph.js";

/** Server-side HTTP settings. */
export const serverConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(8090),
  corsOrigins: z.union([z.string(), z.array(z.string())]).default("*"),
  jsonLimit: z.string().default("10mb"),
});

/** Per-model config: GGUF file, context size, temperature, extra CLI args. */
export const modelConfigSchema = z.object({
  file: z.string().min(1),
  ctx: z.number().int().positive().optional(),
  temp: z.number().min(0).max(2).optional(),
  args: z.string().optional(),
});

/** Global router args passed to `llama serve`. */
export const routerConfigSchema = z.object({
  ctx: z.number().int().positive().default(8192),
  n: z.number().int().positive().default(2048),
  nGpuLayers: z.number().int().default(-1),
  flashAttn: z.boolean().default(true),
  cacheTypeK: z.string().default("q8_0"),
  cacheTypeV: z.string().default("q8_0"),
  batch: z.number().int().positive().default(2048),
  ubatch: z.number().int().positive().default(512),
  tools: z.string().default("all"),
  parallel: z.number().int().positive().default(1),
});

/** Managed llama-server backend config. */
export const llamaConfigSchema = z.object({
  binary: z.string().default("llama"),
  host: z.string().default("127.0.0.1"),
  port: z.union([z.literal(0), z.number().int().positive()]).default(8080),
  autoStart: z.boolean().default(true),
  startupTimeoutMs: z.number().int().positive().default(30000),
  stopTimeoutMs: z.number().int().positive().default(5000),
  requestTimeoutMs: z.number().int().positive().default(300000),
  // Timing knobs for the supervised backend lifecycle (previously hardcoded).
  healthPollIntervalMs: z.coerce.number().int().positive().default(1000),
  portParseTimeoutMs: z.coerce.number().int().positive().default(5000),
  backoffCapMs: z.coerce.number().int().positive().default(30000),
  // Fail-fast restart cap: unexpected exits beyond this stop retrying and set
  // state:"error". 0 = unlimited retries (legacy behavior).
  maxRestartAttempts: z.coerce.number().int().min(0).default(5),
  modelsDir: z.string().default("~/Models"),
  autoload: z.boolean().default(true),
  router: routerConfigSchema.default({}),
  models: z.record(modelConfigSchema).default({}),
});

/**
 * Max nesting depth for a condition AST expression. Admitted config can nest
 * conditions (logical/not) arbitrarily, which risks a stack overflow when the
 * interpreter recurses. The schema caps depth at admission (12) — not the hot
 * path, so a traversal here is fine.
 */
export const MAX_CONDITION_DEPTH = 12;

/** Count the nesting depth of a condition AST (1 for a leaf expression). */
export function astDepth(expr: AstExpr): number {
  switch (expr.op) {
    case "exists":
    case "compare":
      return 1;
    case "not":
      return 1 + astDepth(expr.child);
    case "logical": {
      let max = 1;
      for (const arg of expr.args) {
        max = Math.max(max, 1 + astDepth(arg));
      }
      return max;
    }
  }
}

/**
 * SAFE condition AST — the only shapes the interpreter will ever evaluate (the
 * closed set mirrored by `AstExpr` in graph.ts). Recursive via `z.lazy`; the
 * nesting depth is capped by `superRefine` at admission.
 */
const astExprSchema = z
  .lazy(() =>
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("exists"), field: z.string() }),
      z.object({ op: z.literal("not"), child: astExprSchema }),
      z.object({
        op: z.literal("logical"),
        and: z.boolean(),
        args: z.array(astExprSchema).min(1).max(10),
      }),
      z.object({
        op: z.literal("compare"),
        field: z.string(),
        op2: z.enum(["==", "!=", "<", "<=", ">", ">="]),
        value: z.unknown(),
      }),
    ]),
  )
  .superRefine((val, ctx) => {
    // `z.unknown()` makes the `compare` `value` optional in the inferred output
    // type, but `AstExpr.compare.value` is required. Cast to the closed set: the
    // schema already admits only the `AstExpr` shapes, so this is safe.
    const expr = val as AstExpr;
    if (astDepth(expr) > MAX_CONDITION_DEPTH) {
      ctx.addIssue({
        code: "custom",
        message: `condition nesting exceeds max depth ${MAX_CONDITION_DEPTH}`,
      });
    }
  }) as z.ZodType<AstExpr>;

/**
 * A single graph node inside a pipeline. The editor's graph model maps 1:1 to
 * this shape: `id`, `type` (node kind), and type-specific fields (`model` for
 * `llm_call`, `condition` for `condition`, `pipeline`/`params` for `pipeline`,
 * `body` for `loop`). `pos` holds the editor's layout position and is preserved
 * through config round-trips (config-load Req "pos is preserved").
 */
export const graphNodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      "start",
      "end",
      "llm_call",
      "condition",
      "loop",
      "fan",
      "join",
      "pipeline",
    ]),
    model: z.string().optional(),
    mode: z.enum(["generate", "refine", "passthrough"]).optional().default("generate"),
    provider: z.string().optional(),
    system: z.string().optional(),
    assistant: z.string().optional(),
    user: z.string().optional(),
    /** Optional per-node context window override (tokens) → `params.ctx`. */
    ctx: z.union([z.number().int().positive(), z.string()]).optional(),
    /** Editor layout position — preserved through config round-trip. */
    pos: z.object({ x: z.number(), y: z.number() }).optional(),
    on_429: z.string().optional(),
    tool_calls_route: z.string().optional(),
    condition: astExprSchema.optional(),
    body: z.array(z.string()).optional(),
    pipeline: z.string().optional(),
    params: z.record(z.string()).optional(),
    parallel: z.boolean().optional(),
    guard: z.string().optional(),
  })
  .strict();

/** A directed edge between graph nodes, with an optional condition guard. */
export const graphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    guard: z.string().optional(),
  })
  .strict();

/**
 * A named chain as a pipeline graph: ordered `nodes` plus `edges`. The graph is
 * the canonical representation; the legacy `steps` shape is gone.
 */
export const chainConfigSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    defaultProvider: z.string().optional(),
    provider: z.string().optional(),
    nodes: z.array(graphNodeSchema).min(1, "chain.nodes must not be empty"),
    edges: z.array(graphEdgeSchema).default([]),
  })
  // Strict so a stray legacy `steps` key (or any unknown shape) is rejected —
  // the graph is the only supported representation.
  .strict();

/** Top-level gateway config. */
export const configSchema = z.object({
  server: serverConfigSchema.default({}),
  llama: llamaConfigSchema.default({}),
  defaultChain: z.string().optional(),
  chains: z.record(chainConfigSchema).default({}),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type LlamaConfig = z.infer<typeof llamaConfigSchema>;
export type GraphNodeConfig = z.infer<typeof graphNodeSchema>;
export type GraphEdgeConfig = z.infer<typeof graphEdgeSchema>;
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;
