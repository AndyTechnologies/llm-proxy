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

/** A single orchestration step inside a chain. */
export const stepConfigSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["generate", "refine", "passthrough"]).default("generate"),
  provider: z.string().optional(),
  model: z.string().min(1, "step.model is required"),
  system: z.string().optional(),
  assistant: z.string().optional(),
  user: z.string().optional(),
  // Optional per-step context window override (tokens). Set from the editor's
  // llm_call context selector; a plain number or string so custom values pass.
  ctx: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  on_429: z.string().optional(),
  tool_calls_route: z.string().optional(),
});

/** A named chain composed of ordered steps. */
export const chainConfigSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  defaultProvider: z.string().optional(),
  provider: z.string().optional(),
  steps: z.array(stepConfigSchema).min(1, "chain.steps must not be empty"),
});

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
export type StepConfig = z.infer<typeof stepConfigSchema>;
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;
