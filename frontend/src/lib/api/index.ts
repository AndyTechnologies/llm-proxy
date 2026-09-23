/**
 * Public barrel for the console API layer.
 *
 *   config.ts     — origin resolution (phase 1, U01) — re-exported so the
 *                   console consumes ONE api surface from one import root.
 *   http.ts       — request() + ApiError (typed transport funnel).
 *   types.ts      — shared wire types (verbatim backend shapes).
 *   health.ts     — /api/health.
 *   models.ts     — /api/models hub surface.
 *   workflows.ts  — /api/workflows CRUD + run + logs.
 *   runtime.ts    — combined runtime status probe.
 *   v1.ts         — /v1/chat/completions (JSON + OpenAI-wire SSE).
 */

export * from "./config.js";
export * from "./http.js";
export * from "./types.js";
export * from "./health.js";
export * from "./models.js";
export * from "./workflows.js";
export * from "./runtime.js";
export * from "./v1.js";
