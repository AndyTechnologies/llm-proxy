/**
 * Typed workflow-run socket client (frontend, U07).
 *
 * Mirrors the REAL server wire protocol in src/app/ws.ts field-for-field:
 *
 *   client → {type:"bind", workflow} then {type:"run", messages}
 *   server → status | step_started | step_completed | token | error
 *
 * Responsibilities:
 *   - binds on open;
 *   - queues run requests made before binding, flushes them once bound, and
 *     surfaces an error if the bind fails instead of dropping the run;
 *   - surfaces every server frame as a typed event; client-side parse
 *     failures become local error events — never swallowed;
 *   - on an unexpected close during a run emits "connection closed during
 *     run" — no silent auto-reconnect mid-run.
 *
 * The browser's standard WebSocket is used; tests inject a stand-in via
 * `ws`. The default URL is `${getWsOrigin()}/ws` (api/config.ts).
 */

import { getWsOrigin } from "./api/config.js";

/** Server → client events (same field names as src/app/ws.ts WsEvent). */
export type WorkflowWsEvent =
  | {
      type: "status";
      workflow: string | null;
      state: "bound" | "running" | "ok" | "error";
      error?: string;
    }
  | { type: "step_started"; workflow: string; nodeId: string; nodeType: string }
  | { type: "step_completed"; workflow: string; nodeId: string; ms: number }
  | { type: "token"; workflow: string; data: string }
  | { type: "error"; workflow: string | null; nodeId?: string; error: string };

export interface WorkflowChatMessage {
  role: string;
  content: string;
}

export interface WorkflowSocketOptions {
  workflow: string;
  /** Injectable in tests; defaults to the browser global WebSocket. */
  ws?: typeof WebSocket;
  /** Full socket URL; defaults to `${getWsOrigin()}/ws`. */
  url?: string;
  /** Every decoded server event (and local protocol errors). */
  onEvent: (event: WorkflowWsEvent) => void;
  /** Fired on every socket close (caller-initiated or not). */
  onClose?: () => void;
}

export interface WorkflowSocket {
  /** Send a run; queued until the socket is bound, then flushed. */
  sendRun(messages: WorkflowChatMessage[]): void;
  /** Graceful close; caller-initiated closes never emit mid-run errors. */
  close(): void;
  /** Resolves true on status:"bound", false when binding fails. */
  ready: Promise<boolean>;
}

/**
 * Shape-check a decoded server frame into the typed event union. Null for
 * anything that is not a well-formed server envelope (surfaced by the caller
 * as a local error event instead of being swallowed).
 */
function toWorkflowWsEvent(value: unknown): WorkflowWsEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case "status": {
      const workflow = msg.workflow;
      const state = msg.state;
      if (workflow !== null && typeof workflow !== "string") return null;
      if (state !== "bound" && state !== "running" && state !== "ok" && state !== "error") {
        return null;
      }
      const error = typeof msg.error === "string" ? msg.error : undefined;
      return { type: "status", workflow, state, error };
    }
    case "step_started": {
      const workflow = msg.workflow;
      const nodeId = msg.nodeId;
      const nodeType = msg.nodeType;
      if (
        typeof workflow !== "string" ||
        typeof nodeId !== "string" ||
        typeof nodeType !== "string"
      ) {
        return null;
      }
      return { type: "step_started", workflow, nodeId, nodeType };
    }
    case "step_completed": {
      const workflow = msg.workflow;
      const nodeId = msg.nodeId;
      const ms = msg.ms;
      if (typeof workflow !== "string" || typeof nodeId !== "string" || typeof ms !== "number") {
        return null;
      }
      return { type: "step_completed", workflow, nodeId, ms };
    }
    case "token": {
      const workflow = msg.workflow;
      const data = msg.data;
      if (typeof workflow !== "string" || typeof data !== "string") return null;
      return { type: "token", workflow, data };
    }
    case "error": {
      const workflow = msg.workflow;
      const error = msg.error;
      const nodeId = msg.nodeId;
      if (workflow !== null && typeof workflow !== "string") return null;
      if (typeof error !== "string") return null;
      if (nodeId !== undefined && typeof nodeId !== "string") return null;
      return { type: "error", workflow, error, nodeId };
    }
    default:
      return null;
  }
}

export function connectWorkflowSocket(options: WorkflowSocketOptions): WorkflowSocket {
  const Ctor = options.ws ?? WebSocket;
  const url = options.url ?? `${getWsOrigin()}/ws`;
  const socket = new Ctor(url);

  let bound = false;
  let runInFlight = false;
  let closedByCaller = false;
  let settled = false;
  let resolveReady: (ok: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const queued: WorkflowChatMessage[][] = [];

  function emit(event: WorkflowWsEvent): void {
    options.onEvent(event);
  }

  function emitError(error: string): void {
    emit({ type: "error", workflow: options.workflow, error });
  }

  function settle(ok: boolean): void {
    if (settled) return;
    settled = true;
    resolveReady(ok);
    // A queued run that can never be flushed is an error the caller must see.
    if (!ok && !closedByCaller && queued.length > 0) {
      emitError("run requested before the socket bound; the run was not sent");
    }
  }

  function sendRunFrame(messages: WorkflowChatMessage[]): void {
    runInFlight = true;
    socket.send(JSON.stringify({ type: "run", messages }));
  }

  function handle(event: WorkflowWsEvent): void {
    switch (event.type) {
      case "status":
        if (event.state === "bound") {
          bound = true;
          settle(true);
          for (const messages of queued.splice(0)) sendRunFrame(messages);
        } else if (event.state === "running") {
          runInFlight = true;
        } else {
          runInFlight = false; // ok | error ends the in-flight run
        }
        break;
      case "error":
        // A protocol-level error before binding means the bind failed.
        if (!bound) settle(false);
        break;
      default:
        break;
    }
    emit(event);
  }

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "bind", workflow: options.workflow }));
  };

  socket.onmessage = (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      emitError("received a message that is not valid JSON");
      return;
    }
    const typed = toWorkflowWsEvent(parsed);
    if (typed === null) {
      emitError("received an unrecognized message from the server");
      return;
    }
    handle(typed);
  };

  socket.onclose = () => {
    const wasInFlight = runInFlight;
    runInFlight = false;
    if (!closedByCaller && wasInFlight) {
      emitError("connection closed during run");
    }
    if (!settled) settle(false);
    options.onClose?.();
  };

  function sendRun(messages: WorkflowChatMessage[]): void {
    if (bound) {
      sendRunFrame(messages);
      return;
    }
    queued.push(messages);
  }

  function close(): void {
    if (closedByCaller) return;
    closedByCaller = true;
    socket.close();
  }

  return { sendRun, close, ready };
}