/**
 * Workflow persistence (Task 6.10).
 *
 * Workflows live as YAML docs in the `workflows` table (name-keyed, versioned).
 * Every accepted run appends a row to `execution_log` so the API can surface
 * status history per workflow. The store owns versioning: each `save` bumps
 * the revision and touches `updated_at`.
 */
import type { Database } from "bun:sqlite";
import { serializeWorkflowGraph } from "./workflow-yaml.js";
import type { GraphPipeline } from "./graph.js";

/** List metadata row (the API's lightweight GET /workflows payload). */
export interface WorkflowRecord {
  name: string;
  version: number;
  updatedAt: string;
}

/** One execution_history row. */
export interface ExecutionLogRow {
  id: string;
  workflowId: string;
  status: "ok" | "error";
  error: string | null;
  startedAt: string;
  ms: number | null;
}

/** Full stored record including the YAML doc. */
export interface WorkflowWithYaml extends WorkflowRecord {
  yaml: string;
}

export class WorkflowStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** All workflows, newest-updated first. */
  list(): WorkflowRecord[] {
    const rows = this.#db
      .query(
        "SELECT name, version, updated_at AS updatedAt FROM workflows ORDER BY updated_at DESC",
      )
      .all() as WorkflowRecord[];
    return rows;
  }

  has(name: string): boolean {
    const row = this.#db.query("SELECT 1 FROM workflows WHERE name = ?").get(name);
    return row !== null;
  }

  /** The stored YAML doc + metadata, or null when absent. */
  get(name: string): WorkflowWithYaml | null {
    const row = this.#db
      .query(
        "SELECT name, version, yaml_graph AS yaml, updated_at AS updatedAt FROM workflows WHERE name = ?",
      )
      .get(name) as WorkflowWithYaml | null;
    return row ?? null;
  }

  /**
   * Upsert a workflow. `versionHint` seeds the first save (default 1); every
   * subsequent save of the same name bumps the stored version by one. The
   * stored YAML doc carries no `version` (the column is authoritative).
   */
  save(name: string, graph: GraphPipeline, versionHint = 1): WorkflowRecord {
    const yaml = serializeWorkflowGraph(graph);
    const existing = this.#db
      .query("SELECT version FROM workflows WHERE name = ?")
      .get(name) as { version: number } | null;
    const version = existing === null ? versionHint : existing.version + 1;
    this.#db
      .query(
        "INSERT INTO workflows (name, version, yaml_graph, updated_at) VALUES (?, ?, ?, datetime('now')) " +
          "ON CONFLICT(name) DO UPDATE SET yaml_graph = excluded.yaml_graph, version = excluded.version, updated_at = excluded.updated_at",
      )
      .run(name, version, yaml);
    return { name, version, updatedAt: new Date().toISOString() };
  }

  /** Delete a workflow. True when it existed. */
  remove(name: string): boolean {
    const before = this.has(name);
    this.#db.query("DELETE FROM workflows WHERE name = ?").run(name);
    return before;
  }

  /** Append a run outcome to the workflow's execution log (unknown → no-op). */
  recordExecution(
    name: string,
    entry: { status: "ok" | "error"; error?: string; startedAt: string; ms: number },
  ): void {
    if (!this.has(name)) return;
    this.#db
      .query(
        "INSERT INTO execution_log (id, workflow_id, status, error, started_at, ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), name, entry.status, entry.error ?? null, entry.startedAt, entry.ms);
  }

  /** Run history for a workflow, newest first. */
  logs(name: string): ExecutionLogRow[] {
    const rows = this.#db
      .query(
        "SELECT id, workflow_id AS workflowId, status, error, started_at AS startedAt, ms " +
          "FROM execution_log WHERE workflow_id = ? ORDER BY started_at DESC",
      )
      .all(name) as ExecutionLogRow[];
    return rows;
  }
}