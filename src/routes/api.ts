/**
 * Workflow CRUD + run API (Task 6.10).
 *
 * A thin JSON/REST surface over the workflow store:
 *
 *   GET    /api/workflows            → [{name, version, updatedAt}]
 *   GET    /api/workflows/:name      → {name, version, updatedAt, yaml} | 404
 *   PUT    /api/workflows/:name      → YAML body; 400 names the offending
 *                                     node/validation error; upserts (version
 *                                     bumps on resave)
 *   DELETE /api/workflows/:name      → 204 | 404
 *   POST   /api/workflows/:name/run  → OpenAI chat body → runner result (or
 *                                     the runner's 404/502 passthrough)
 *   GET    /api/workflows/:name/logs → execution history | 404
 *
 * The runner is injected (never constructed here) so the API stays testable
 * and the real backend plugs in at boot.
 */
import { parseWorkflowGraph } from "../orchestrator/workflow-yaml.js";
import { validateGraph } from "../orchestrator/graph.js";
import type { WorkflowStore } from "../orchestrator/store.js";
import type { WorkflowRunner } from "../orchestrator/runner.js";

export interface ApiDeps {
  store: WorkflowStore;
  runner: WorkflowRunner;
  /** Optional model list for workflow validation (omitted → model check skipped). */
  knownModels?: () => string[];
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
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "workflows", ...]

    if (parts[0] !== "api" || parts[1] !== "workflows") {
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