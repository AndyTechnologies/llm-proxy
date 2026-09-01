/**
 * Chain config parser.
 *
 * Takes the validated `GatewayConfig.chains` (already zod-parsed) and
 * resolves each chain's steps into `ResolvedStep[]` — guaranteeing every
 * step has a non-optional `provider` field. Invalid chain references
 * (missing provider, empty steps) are caught at startup so they never
 * surface as runtime 500s.
 *
 * WHY parse at startup: a chain misconfiguration is a deployment error,
 * not a per-request error. Failing fast at boot prevents serving broken
 * chains to clients.
 */
import type { GatewayConfig } from "../config/schema.js";
import type { Chain, Step, ResolvedStep } from "../types/chain.js";

/** A fully resolved chain ready for the engine to execute. */
export interface ParsedChain extends Chain {
  steps: ResolvedStep[];
}

const DEFAULT_PROVIDER = "llama-server";

/**
 * Resolve a single step, filling in the provider from chain-level defaults.
 */
function resolveStep(step: Step, defaultProvider: string): ResolvedStep {
  return {
    ...step,
    provider: step.provider ?? defaultProvider,
  };
}

/**
 * Parse all chains from the config into executable ParsedChain objects.
 * Throws on any invalid chain so the server refuses to start.
 */
export function parseChains(config: GatewayConfig): Map<string, ParsedChain> {
  const chains = new Map<string, ParsedChain>();

  for (const [name, chainCfg] of Object.entries(config.chains)) {
    const defaultProvider =
      chainCfg.provider ?? chainCfg.defaultProvider ?? DEFAULT_PROVIDER;

    // Refuse chains with zero steps — this is a config authoring error.
    if (!chainCfg.steps || chainCfg.steps.length === 0) {
      throw new Error(
        `[parser] chain "${name}" has no steps — refusing to register`,
      );
    }

    const steps: ResolvedStep[] = chainCfg.steps.map((s) =>
      resolveStep(s, defaultProvider),
    );

    // Validate on_429 references point to a step that actually exists in this chain.
    const stepNames = new Set(steps.map((s, i) => s.name ?? `step-${i}`));
    for (const step of steps) {
      if (step.on_429 && !stepNames.has(step.on_429)) {
        throw new Error(
          `[parser] chain "${name}" step "${step.name ?? "(unnamed)"}" references on_429 "${step.on_429}" which does not exist in the chain`,
        );
      }
      if (step.tool_calls_route && !stepNames.has(step.tool_calls_route)) {
        throw new Error(
          `[parser] chain "${name}" step "${step.name ?? "(unnamed)"}" references tool_calls_route "${step.tool_calls_route}" which does not exist in the chain`,
        );
      }
    }

    chains.set(name, {
      name,
      displayName: chainCfg.displayName,
      defaultProvider,
      provider: chainCfg.provider,
      steps,
    });

    console.log(
      `[parser] registered chain "${name}" (${chainCfg.displayName ?? name}): ${steps.length} steps`,
    );
  }

  return chains;
}
