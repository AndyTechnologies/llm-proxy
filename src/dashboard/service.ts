/**
 * Dashboard apply service (Slice C — task 3.4, dashboard-api Req "Apply
 * endpoint").
 *
 * `POST /api/ui/apply` flow: zod-validate the draft `{config:{...}}` → atomic
 * persist to the config file → reload the registry. On any failure it writes
 * nothing (validation precedes the write) and rolls back the registry to its
 * previous registered chains. A failed apply MUST leave no side effects.
 *
 * Errors are surfaced as typed `ApplyError` objects matching the required
 * `{error:{message,type,param,code}}` envelope so the router can normalize them
 * into HTTP responses.
 *
 * Pure/injectable: `persist` and `reload` are injected so unit tests exercise
 * validation, write-nothing-on-failure, and rollback without touching disk.
 */
import { configSchema, type GatewayConfig } from "../config/schema.js";

/** A typed error carrying the dashboard error-envelope fields. */
export interface ApplyError extends Error {
  type: string;
  param: string | null;
  code: string | null;
}

/** Injected dependencies for the apply service. */
export interface ApplyDeps {
  /** Where the config is persisted (null/skip when absent). */
  configPath: string;
  /**
   * Persist the validated config atomically (write-nothing on validation
   * failure is the caller's zod-gated contract) and return serialized YAML.
   */
  persist: (config: GatewayConfig, configPath: string) => Promise<string>;
  /**
   * Reload the registry with the NEW set of registered chain names. Throws (or
   * rejects) to signal a reload failure (the caller rolls back and rethrows).
   * The chain names are passed as an array the impl maps to its own
   * parse+validate.
   */
  reload: (chains: string[]) => void | Promise<void>;
  /** Current registered chain names (for rollback on reload failure). */
  getCurrentChains: () => string[];
}

/** Build the error envelope as a thrown ApplyError. */
function asApplyError(
  message: string,
  type: string,
  param: string | null = null,
  code: string | null = null,
): ApplyError {
  const err = new Error(message) as ApplyError;
  err.type = type;
  err.param = param;
  err.code = code;
  return err;
}

/** The apply service result on success. */
export interface ApplyResult {
  status: "applied";
  reloadedChains: string[];
}

/** The apply service surface. */
export interface ApplyService {
  apply(draft: { config: unknown }): Promise<ApplyResult>;
}

/** Create the apply service with injected persistence/reload deps. */
export function createApplyService(deps: ApplyDeps): ApplyService {
  function chainNamesFor(config: GatewayConfig): string[] {
    return Object.keys(config.chains);
  }

  return {
    async apply(draft) {
      // 1. zod-validate the raw draft — invalid config writes NOTHING.
      let validated: GatewayConfig;
      try {
        validated = configSchema.parse(draft.config);
      } catch (err) {
        throw asApplyError(
          err instanceof Error ? err.message : "Configuration is invalid",
          "invalid_request_error",
        );
      }

      const reloadedChains = chainNamesFor(validated);

      // 2. Persist the validated config atomically (write first, before any
      //    registry change so a partial write never leaves an inconsistent
      //    disk + registry pair).
      const previous = deps.getCurrentChains();
      try {
        await deps.persist(validated, deps.configPath);
      } catch (err) {
        throw asApplyError(
          err instanceof Error ? err.message : "Failed to persist config",
          "server_error",
        );
      }

      // 3. Reload the registry with the new chains. If reload fails, roll
      //    back the registry to its previous chains, then rethrow.
      try {
        await deps.reload(reloadedChains);
      } catch (err) {
        try {
          await deps.reload(previous);
        } catch {
          // Best-effort rollback — if the previous chains also fail to reload
          // the original error takes precedence.
        }
        throw asApplyError(
          err instanceof Error ? err.message : "Failed to reload registry",
          "server_error",
        );
      }

      return { status: "applied", reloadedChains };
    },
  };
}
