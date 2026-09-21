/**
 * WebSocket workflow streaming (Task 6.9, websocket-streaming spec).
 *
 * `/ws` (ws://) is the primary channel for live workflow runs. Wire protocol
 * (JSON, one envelope per frame):
 *
 *   client → server
 *     {type: "bind", workflow}          — bind this socket to a workflow name
 *     {type: "run", messages}           — run the bound workflow (OpenAI body)
 *   server → client (typed events)
 *     {type: "status", workflow, state, error?}
 *     {type: "step_started", workflow, nodeId, nodeType}
 *     {type: "step_completed", workflow, nodeId, ms}
 *     {type: "token", workflow, data}   — one SSE frame (`data: …\n\n`); the
 *                                        completed run's OpenAI-wire SSE is
 *                                        relayed, then exactly one
 *                                        `data: [DONE]` frame
 *     {type: "error", workflow, nodeId?, error}
 *
 * Scoping: every event a socket receives belongs to the workflow it bound.
 * A client disconnect aborts the in-flight upstream run (per-socket
 * AbortController). A plain HTTP GET to `/ws` answers 426 (the server fetch
 * handles that before any websocket upgrade).
 */
import type { Server, ServerWebSocket } from "bun";
import type { EngineEvent } from "../orchestrator/engine.js";
import type { ChatMessage } from "../orchestrator/engine.js";
import type { RunResult, WorkflowRunner } from "../orchestrator/runner.js";

/** Per-socket state: the bound workflow + the in-flight run's abort handle. */
export interface WsSocketData {
  workflow: string | null;
  controller: AbortController | null;
  messages: ChatMessage[];
}

/** Outgoing typed events (websocket-streaming spec). */
export type WsEvent =
  | { type: "status"; workflow: string | null; state: "bound" | "running" | "ok" | "error"; error?: string }
  | { type: "step_started"; workflow: string; nodeId: string; nodeType: string }
  | { type: "step_completed"; workflow: string; nodeId: string; ms: number }
  | { type: "token"; workflow: string; data: string }
  | { type: "error"; workflow: string | null; nodeId?: string; error: string };

export interface WsHubDeps {
  runner: WorkflowRunner;
}

export interface WsHub {
  /**
   * Attempt the upgrade for a /ws request. Returns false when the request is
   * not a websocket upgrade (the server answers 426).
   */
  upgrade(req: Request, server: Server<WsSocketData>): boolean;
  open(ws: ServerWebSocket<WsSocketData>): void;
  message(ws: ServerWebSocket<WsSocketData>, raw: string | Buffer): void;
  close(ws: ServerWebSocket<WsSocketData>): void;
}

export function makeWsHub(deps: WsHubDeps): WsHub {
  const send = (ws: ServerWebSocket<WsSocketData>, event: WsEvent): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  };

  const relay = (ws: ServerWebSocket<WsSocketData>, event: EngineEvent): void => {
    const workflow = ws.data.workflow;
    if (workflow === null) return;
    switch (event.type) {
      case "step:start":
        send(ws, { type: "step_started", workflow, nodeId: event.nodeId, nodeType: event.nodeType });
        break;
      case "step:complete":
        send(ws, { type: "step_completed", workflow, nodeId: event.nodeId, ms: event.ms });
        break;
      case "step:error":
        send(ws, { type: "error", workflow, nodeId: event.nodeId, error: event.error });
        break;
      default:
        // run:start / run:complete / reroute fold into status/ok/error — the
        // closed event set the spec advertises stays the wire contract.
        break;
    }
  };

  const runFor = async (ws: ServerWebSocket<WsSocketData>): Promise<void> => {
    const workflow = ws.data.workflow;
    if (workflow === null) {
      send(ws, {
        type: "error",
        workflow: null,
        error: 'bind a workflow first: {"type":"bind","workflow":"<name>"}',
      });
      return;
    }
    if (ws.data.controller !== null) {
      send(ws, { type: "error", workflow, error: "a run is already in flight for this socket" });
      return;
    }

    const controller = new AbortController();
    ws.data.controller = controller;
    send(ws, { type: "status", workflow, state: "running" });

    let result: RunResult;
    try {
      result = await deps.runner.run(
        workflow,
        { messages: ws.data.messages },
        controller.signal,
        (event) => relay(ws, event),
      );
    } catch (err) {
      result = { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
    }
    ws.data.controller = null;

    if (result.ok) {
      // The completed run's OpenAI-wire SSE, then exactly one [DONE] frame.
      send(ws, { type: "token", workflow, data: `data: ${JSON.stringify(result.output)}\n\n` });
      send(ws, { type: "token", workflow, data: "data: [DONE]\n\n" });
      send(ws, { type: "status", workflow, state: "ok" });
    } else {
      send(ws, { type: "status", workflow, state: "error", error: result.error });
    }
  };

  return {
    upgrade(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws") return false;
      const upgradeHeader = req.headers.get("upgrade") ?? "";
      if (!upgradeHeader.toLowerCase().includes("websocket")) return false;
      return server.upgrade(req, {
        data: { workflow: null, controller: null, messages: [] },
      });
    },

    open(_ws) {
      // Nothing to announce on connect; binding is explicit (message-driven).
    },

    message(ws, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send(ws, { type: "error", workflow: ws.data.workflow, error: "message is not valid JSON" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        send(ws, { type: "error", workflow: ws.data.workflow, error: "message must be a JSON object" });
        return;
      }
      const msg = parsed as Record<string, unknown>;

      if (msg.type === "bind" && typeof msg.workflow === "string") {
        if (!deps.runner.ids().includes(msg.workflow)) {
          send(ws, { type: "error", workflow: null, error: `unknown workflow "${msg.workflow}"` });
          return;
        }
        ws.data.workflow = msg.workflow;
        send(ws, { type: "status", workflow: msg.workflow, state: "bound" });
        return;
      }

      if (msg.type === "run" && Array.isArray(msg.messages)) {
        const messages = msg.messages as ChatMessage[];
        if (!messages.every((m) => m && typeof m.role === "string" && typeof m.content === "string")) {
          send(ws, {
            type: "error",
            workflow: ws.data.workflow,
            error: 'run messages must be [{role, content}, …]',
          });
          return;
        }
        ws.data.messages = messages;
        void runFor(ws);
        return;
      }

      send(ws, {
        type: "error",
        workflow: ws.data.workflow,
        error: 'unknown message: expected {"type":"bind"} or {"type":"run"}',
      });
    },

    close(ws) {
      // Client disconnect aborts the upstream run (websocket-streaming spec).
      ws.data.controller?.abort();
      ws.data.controller = null;
      ws.data.workflow = null;
    },
  };
}