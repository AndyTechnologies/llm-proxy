/**
 * Workflow runner contract (Tasks 6.6 / 6.10).
 *
 * The runner turns a stored workflow into an OpenAI-shaped completion — the
 * same surface a chain sees — so the /api run endpoint and the
 * gateway/name virtual model share one path. makeWorkflowRunner (the
 * implementation) lives here with makeRuntimeServices; the interface is
 * defined first so the API layer and routes can depend on it without a
 * concrete engine backend.
 */
import type { ChatMessage } from "./engine.js";

/** The OpenAI-shaped completion the runner yields (workflow = assistant turn). */
export interface ChainCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop";
    },
  ];
  usage: null;
}

export type RunResult =
  | { ok: true; output: ChainCompletion }
  | { ok: false; status: number; error: string };

export interface WorkflowRunner {
  /** Names of every workflow that can be run. */
  ids(): string[];
  /**
   * Run a stored workflow by name with an OpenAI chat body. Unknown name →
   * `{ ok: false, status: 404 }` (model_not_found); engine failure →
   * `{ ok: false, status: 502 }`. Each accepted run is recorded in the
   * workflow's execution log before resolving.
   */
  run(name: string, body: { messages: ChatMessage[] }, signal?: AbortSignal): Promise<RunResult>;
}