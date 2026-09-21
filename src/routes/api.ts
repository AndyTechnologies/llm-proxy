/**
 * Workflow CRUD + run API + model management API (Task 6.10).
 *
 * REST surface:
 *
 * Workflows (unchanged):
 *   GET    /api/workflows            → [{name, version, updatedAt}]
 *   GET    /api/workflows/:name      → {name, version, updatedAt, yaml} | 404
 *   PUT    /api/workflows/:name      → YAML body; 400 names the offending
 *                                     node/validation error; upserts (version
 *                                     bumps on resave)
 *   DELETE /api/workflows/:name      → 204 | 404
 *   POST   /api/workflows/:name/run  → OpenAI chat body → runner result
 *   GET    /api/workflows/:name/logs → execution history | 404
 *
 * Models (NEW — optional `hub` dep):
 *   GET    /api/models                → ModelStatus[] (full registry)
 *   GET    /api/models/:id            → ModelStatus | 404
 *   POST   /api/models/:id/activate   → {state, pid, port} | 404 | 400 | 503
 *   POST   /api/models/:id/deactivate → {state} | 404
 *
 * Auth gate (optional `auth` dep): applied to the models branch only; 401
 * when the gate rejects.
 */
import { parseWorkflowGraph } from "../orchestrator/workflow-yaml.js";
import { validateGraph } from "../orchestrator/graph.js";
import type { WorkflowStore } from "../orchestrator/store.js";
import type { WorkflowRunner } from "../orchestrator/runner.js";
import type { LocalBackendHub, HubError } from "../backend/hub.js";

export interface ApiDeps {
  store: WorkflowStore;
  runner: WorkflowRunner;
  knownModels?: () => string[];
  hub?: LocalBackendHub;
  auth?: (req: Request) => Promise<boolean>;
}

export type ApiHandler = (req: Request) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function makeApiHandler(deps: ApiDeps): ApiHandler {
  const { store } = deps;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "models"|"workflows", ...]

    if (parts[0] !== "api") {
      return jsonResponse({ error: "not_found" }, 404);
    }

    // ── models branch ───────────────────────────────────────────────
    if (parts[1] === "models") {
      const hub = deps.hub;
      if (hub === undefined) return jsonResponse({ error: "not_found" }, 404);
      if (deps.auth !== undefined) {
        const ok = await deps.auth(req);
        if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
      }

      // GET /api/models (list)
      if (parts[2] === undefined) {
        if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
        return jsonResponse(hub.statusAll(), 200);
      }

      const modelId = parts[2];
      const sub = parts[3];

      if (sub === undefined || sub === "status") {
        if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
        const s = hub.status(modelId);
        if (s === null) return jsonResponse({ error: "model_not_found" }, 404);
        return jsonResponse(s, 200);
      }

      if (sub === "activate") {
        if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
        try {
          const result = await hub.activate(modelId);
          return jsonResponse(result, 200);
        } catch (err) {
          return jsonResponse({ error: (err as HubError).message }, (err as HubError).status);
        }
      }

      if (sub === "deactivate") {
        if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
        try {
          const result = await hub.deactivate(modelId);
          return jsonResponse(result, 200);
        } catch (err) {
          return jsonResponse({ error: (err as HubError).message }, (err as HubError).status);
        }
      }

      return jsonResponse({ error: "not_found" }, 404);
    }

    // ── workflows branch ────────────────────────────────────────────
    if (parts[1] !== "workflows") {
      return jsonResponse({ error: "not_found" }, 404);
    }

    const name = parts[2];
    if (name === undefined) {
      if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(store.list(), 200);
    }

    const sub = parts[3];

    if (sub === "run") {
      if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      if (!store.has(name)) return jsonResponse({ error: "model_not_found" }, 404);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
      const messages = (body as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) return jsonResponse({ error: "missing messages array" }, 400);
      const result = await deps.runner.run(name, { messages: messages as never });
      if (result.ok) return jsonResponse(result.output, 200);
      return jsonResponse({ error: result.error }, result.status);
    }

    if (sub === "logs") {
      if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
      if (!store.has(name)) return jsonResponse({ error: "not_found" }, 404);
      return jsonResponse(store.logs(name), 200);
    }

    if (sub !== undefined) return jsonResponse({ error: "not_found" }, 404);

    switch (req.method) {
      case "GET": {
        const record = store.get(name);
        if (record === null) return jsonResponse({ error: "not_found" }, 404);
        return jsonResponse(record, 200);
      }
      case "PUT": {
        const source = await req.text();
        let parsed;
        try {
          parsed = parseWorkflowGraph(source);
        } catch (err) {
          return jsonResponse({ error: String((err as Error).message) }, 400);
        }
        const knownModels = deps.knownModels?.();
        const validation = validateGraph(
          parsed.graph,
          knownModels !== undefined && knownModels.length > 0 ? { knownModels } : {},
        );
        if (!validation.ok) {
          return jsonResponse(
            { error: `workflow "${name}" failed validation`, errors: validation.errors },
            400,
          );
        }
        const saved = store.save(name, parsed.graph, parsed.version ?? 1);
        return jsonResponse({ ok: true, name: saved.name, version: saved.version }, 200);
      }
      case "DELETE": {
        if (!store.remove(name)) return jsonResponse({ error: "not_found" }, 404);
        return new Response(null, { status: 204 });
      }
      default:
        return jsonResponse({ error: "method_not_allowed" }, 405);
    }
  };
}