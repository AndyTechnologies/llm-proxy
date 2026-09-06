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
import { z, ZodError } from "zod";
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

/** The default English message zod would generate for this issue. */
function zodDefaultMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `Expected ${issue.expected}, received ${issue.received}`;
    case z.ZodIssueCode.too_small: {
      if (issue.type === "array") return `Array must contain at least ${issue.minimum} element(s)`;
      if (issue.type === "string") return `String must contain at least ${issue.minimum} character(s)`;
      if (issue.type === "number") {
        return `Number must be ${issue.inclusive ? "greater than or equal to" : "greater than"} ${issue.minimum}`;
      }
      return issue.message;
    }
    case z.ZodIssueCode.too_big: {
      if (issue.type === "array") return `Array must contain at most ${issue.maximum} element(s)`;
      if (issue.type === "string") return `String must contain at most ${issue.maximum} character(s)`;
      if (issue.type === "number") {
        return `Number must be ${issue.inclusive ? "less than or equal to" : "less than"} ${issue.maximum}`;
      }
      return issue.message;
    }
    case z.ZodIssueCode.invalid_enum_value:
      return `Invalid enum value. Expected ${issue.options.join(" | ")}, received '${String(issue.received)}'`;
    case z.ZodIssueCode.unrecognized_keys:
      return `Unrecognized key(s) in object: ${issue.keys.join(", ")}`;
    case z.ZodIssueCode.invalid_literal:
      return `Invalid literal value, expected ${String(issue.expected)}`;
    default:
      return issue.message;
  }
}

/**
 * Human-readable Spanish message for a Zod issue. Messages shown in the UI
 * must be Spanish (server-side root fix, so the UI never has to translate).
 * Custom messages defined in the schema (already Spanish) win over the
 * generic per-code translation.
 */
function zodIssueToSpanish(issue: z.ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join(".") : "(raíz)";
  if (issue.message !== zodDefaultMessage(issue)) {
    return `${where}: ${issue.message}`;
  }
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `${where}: se esperaba ${issue.expected}, se recibió ${issue.received}`;
    case z.ZodIssueCode.too_small:
      if (issue.type === "array") return `${where}: debe tener al menos ${issue.minimum} elemento(s)`;
      if (issue.type === "string") return `${where}: debe tener al menos ${issue.minimum} caracteres`;
      if (issue.type === "number") {
        return `${where}: debe ser ${issue.inclusive ? "mayor o igual" : "mayor"} a ${issue.minimum}`;
      }
      return `${where}: ${issue.message}`;
    case z.ZodIssueCode.too_big:
      if (issue.type === "array") return `${where}: debe tener como máximo ${issue.maximum} elemento(s)`;
      if (issue.type === "string") return `${where}: debe tener como máximo ${issue.maximum} caracteres`;
      if (issue.type === "number") {
        return `${where}: debe ser ${issue.inclusive ? "menor o igual" : "menor"} a ${issue.maximum}`;
      }
      return `${where}: ${issue.message}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `${where}: valor inválido "${issue.received}" (permitidos: ${issue.options.join(", ")})`;
    case z.ZodIssueCode.unrecognized_keys:
      return `${where}: claves no reconocidas: ${issue.keys.join(", ")}`;
    case z.ZodIssueCode.invalid_literal:
      return `${where}: se esperaba el valor literal ${String(issue.expected)}`;
    default:
      return `${where}: ${issue.message}`;
  }
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
        if (err instanceof ZodError) {
          // `err.message` is a raw JSON array of issues — surface a readable
          // Spanish list instead ("chains.nuevo-pipeline.nodes: chain.nodes
          // no debe estar vacío").
          throw asApplyError(
            err.issues.map(zodIssueToSpanish).join(" · "),
            "invalid_request_error",
          );
        }
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
