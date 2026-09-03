/**
 * Chain orchestration types.
 *
 * A chain is the config-driven replacement for the old hardcoded
 * generate/refine pipelines. Each step targets a provider/model and may carry
 * conditional routing (429 fallback, tool_calls routing) and per-step message
 * scaffolding (system/assistant/user overrides). The engine interprets these
 * shapes; parser.ts turns raw config (JSON/YAML) into validated Step[]/Chain[].
 */

/** How a step builds its message context for the provider call. */
export type StepType = "generate" | "refine" | "passthrough";

/**
 * A single orchestration step.
 *
 * - generate:  seed with the incoming user messages (optionally a system prompt).
 * - refine:    feed the previous step's output back for verification/improvement.
 * - passthrough: forward the request to a provider without transformation
 *              (used for final streaming stages that must proxy verbatim).
 *
 * `on_429` names a fallback step (by name) to run when this step returns 429.
 * `tool_calls_route` names the next step when the response carries tool_calls.
 * `provider` defaults to the chain's default provider when omitted.
 */
export interface Step {
  name?: string;
  type: StepType;
  provider?: string;
  model: string;
  system?: string;
  assistant?: string;
  user?: string;
  /**
   * Optional per-step context window override (tokens). Persisted from the
   * editor's llm_call context selector and carried onto the graph node's
   * `params.ctx` when the chain is materialized into a graph.
   */
  ctx?: number | string;
  on_429?: string;
  tool_calls_route?: string;
}

/** A named chain (virtual model) composed of ordered steps. */
export interface Chain {
  name: string;
  displayName?: string;
  defaultProvider?: string;
  provider?: string;
  steps: Step[];
}

/** Resolved per-execution context flowing between steps. */
export interface StepContext {
  /** Full response body of the most recent executed step. */
  lastResponse: unknown;
  /** Extracted textual content from the last response (context refeed). */
  lastContent: string;
}

/** A provider+model reference after chain resolution. */
export interface ResolvedStep extends Step {
  provider: string;
}
