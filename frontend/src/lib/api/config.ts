/**
 * API origin resolution for the console shell.
 *
 * The backend listens on 127.0.0.1:4317 in development. The origin can be
 * overridden at build/dev time with `PUBLIC_WEAVELLM_API_ORIGIN` (Astro
 * exposes PUBLIC_* environment variables to client code through
 * `import.meta.env`). This is the only API-layer module in phase 1; typed
 * clients for /api, /v1 and /ws arrive in phase 2.
 */

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4317";

/** Base origin for backend HTTP calls (defaults to the local runtime). */
export function getApiOrigin(): string {
  const override: string | undefined = import.meta.env.PUBLIC_WEAVELLM_API_ORIGIN as
    | string
    | undefined;
  return typeof override === "string" && override.length > 0
    ? override
    : DEFAULT_API_ORIGIN;
}

/** Derive a websocket origin from an http(s) origin (http→ws, https→wss). */
export function wsOriginFrom(apiOrigin: string): string {
  return apiOrigin.replace(/^http/, "ws");
}

/** Base origin for backend websocket calls (WS /ws). */
export function getWsOrigin(): string {
  return wsOriginFrom(getApiOrigin());
}