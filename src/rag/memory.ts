/**
 * Conversation memory (embeddings-rag spec).
 *
 * The `memory` workflow node reads the prior turns of a conversation from the
 * `kv_memory` table (conv_id-scoped) and prepends them to the next LLM call so
 * chains can carry context across steps without a growing request payload.
 */
import type { Database } from "bun:sqlite";

export interface MemoryTurn {
  role: string;
  content: string;
  ts: string;
}

export class MemoryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Append one turn to a conversation's memory. */
  record(convId: string, role: string, content: string): void {
    this.#db
      .query("INSERT INTO kv_memory (conv_id, role, content) VALUES (?, ?, ?)")
      .run(convId, role, content);
  }

  /**
   * The last `limit` turns of a conversation in chronological order. Rows are
   * picked newest-first (ts, then rowid to break same-second ties) and
   * reversed, so the caller gets a natural conversation window.
   */
  recent(convId: string, limit = 10): MemoryTurn[] {
    const rows = this.#db
      .query(
        "SELECT role, content, ts FROM kv_memory WHERE conv_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
      )
      .all(convId, limit) as Array<{ role: string; content: string; ts: string }>;
    return rows.reverse();
  }

  /** Drop every stored turn for a conversation. */
  clear(convId: string): void {
    this.#db.query("DELETE FROM kv_memory WHERE conv_id = ?").run(convId);
  }

  /** Number of stored turns for a conversation. */
  count(convId: string): number {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM kv_memory WHERE conv_id = ?")
      .get(convId) as { n: number };
    return row.n;
  }
}

/**
 * Build the next LLM call's message list: memory turns first (timestamps
 * stripped, empty content skipped), then the current messages unchanged.
 */
export function buildMemoryMessages(
  history: MemoryTurn[],
  current: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const memory: Array<{ role: string; content: string }> = [];
  for (const turn of history) {
    if (typeof turn.content !== "string" || turn.content === "") continue;
    memory.push({ role: turn.role, content: turn.content });
  }
  return [...memory, ...current];
}