/**
 * zod schema for the gateway config file (llm-proxy.config.yaml / .json).
 *
 * The config defines the HTTP server settings, the llama-server backend
 * address, and the chain definitions used by the orchestrator. Zod validation
 * runs at startup so an invalid config fails fast with a clear message instead
 * of failing halfway through a request.
 */
import { z } from "zod";

/** Server-side HTTP settings. */
export const serverConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(8090),
  corsOrigins: z.union([z.string(), z.array(z.string())]).default("*"),
  jsonLimit: z.string().default("10mb"),
});

/** The llama-server backend. Replaces the removed llama-swap binary. */
export const llamaServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(8080),
  requestTimeoutMs: z.coerce.number().int().positive().default(300000),
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
  on_429: z.string().optional(),
  tool_calls_route: z.string().optional(),
});

/** A named chain composed of ordered steps. */
export const chainConfigSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  defaultProvider: z.string().optional(),
  provider: z.string().optional(),
  steps: z.array(stepConfigSchema).min(1, "chain.steps must not be empty"),
});

/** Top-level gateway config. */
export const configSchema = z.object({
  server: serverConfigSchema.default({}),
  llamaServer: llamaServerConfigSchema.default({}),
  defaultChain: z.string().optional(),
  chains: z.record(chainConfigSchema).default({}),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type LlamaServerConfig = z.infer<typeof llamaServerConfigSchema>;
export type StepConfig = z.infer<typeof stepConfigSchema>;
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;
