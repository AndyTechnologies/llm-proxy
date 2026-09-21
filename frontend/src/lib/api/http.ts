/**
 * Minimal HTTP transport for the console API surface.
 *
 * Funnels every typed call in this layer through `request()`, which:
 *   - resolves the base origin via getApiOrigin() (config.ts, phase 1);
 *   - sends JSON (jsonBody) or raw text (rawBody — the workflows PUT sends
 *     YAML text, not JSON);
 *   - treats 204 as undefined, everything else 2xx as parsed JSON;
 *   - maps non-2xx onto the backend envelope `{error, errors?}` throwing an
 *     `ApiError(status, message, errors?)`, and transport failures onto
 *     `ApiError(0, "network_error"|"request_timeout")`;
 *   - lets tests inject a fake fetch and/or a base origin.
 *
 * No React/Astro imports — stays importable under bun:test in any runtime.
 */

import { getApiOrigin } from "./config.js";
import type { ApiErrorEnvelope } from "./types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  /** JSON body (mutually exclusive with rawBody). */
  jsonBody?: unknown;
  /** Raw text body — the workflows PUT sends YAML text. */
  rawBody?: string;
  /** Content type for rawBody (defaults to application/x-yaml). */
  rawBodyType?: string;
  /** Override the API origin (defaults to getApiOrigin()). */
  origin?: string;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort the request. */
  signal?: AbortSignal;
  /** Timeout in ms (default 10_000). */
  timeoutMs?: number;
}

export interface ApiErrorOptions {
  status: number;
  message: string;
  code: string;
  errors?: unknown;
}

/** Error thrown on non-2xx responses (status>0) or transport failures (0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors?: unknown;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.errors = options.errors;
  }
}

async function parseBody(res: Response): Promise<string> {
  return res.text();
}

function toEnvelope(value: unknown): ApiErrorEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as ApiErrorEnvelope;
  return typeof e.error === "string" ? e : null;
}

/**
 * Execute a request against the /api surface.
 *
 * @param path    URL path, e.g. "/api/health".
 * @param options
 * @returns the parsed JSON body (T), or undefined for 204 / empty body.
 * @throws ApiError for non-2xx and transport failures.
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const origin = options.origin ?? getApiOrigin();
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "GET";
  const headers = new Headers({ accept: "application/json" });

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set("content-type", options.rawBodyType ?? "application/x-yaml");
  } else if (options.jsonBody !== undefined) {
    body = JSON.stringify(options.jsonBody);
    headers.set("content-type", "application/json");
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const name = (err as Error)?.name;
    if (name === "AbortError" && controller.signal.aborted) {
      throw new ApiError({ status: 0, message: "request_timeout", code: "request_timeout" });
    }
    throw new ApiError({
      status: 0,
      message: (err as Error)?.message ?? "network_error",
      code: "network_error",
    });
  }
  clearTimeout(timer);

  const isOk = res.ok || res.status === 204;
  if (!isOk) {
    const text = await parseBody(res).catch(() => "");
    let envelope: ApiErrorEnvelope | null = null;
    if (text.length > 0) {
      try {
        envelope = toEnvelope(JSON.parse(text));
      } catch {
        // non-JSON error body — fall through to the raw status
      }
    }
    throw new ApiError({
      status: res.status,
      message: envelope?.error ?? `http_${res.status}`,
      code: envelope?.error ?? `http_${res.status}`,
      errors: envelope?.errors,
    });
  }

  if (res.status === 204) return undefined as T    ;
  const text = await parseBody(res);
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ status: 0, message: "invalid_json", code: "invalid_json" });
  }
}
