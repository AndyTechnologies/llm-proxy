/**
 * Pure run-view state machine for the workflow RunPanel (frontend, U07).
 *
 * Turns the WS event stream (WorkflowWsEvent, ../lib/ws.ts) into the panel's
 * render model: a status, a step trace, and aggregated output text. Events
 * are applied synchronously in arrival order — the machine never reorders or
 * batches them. No IO, no Svelte: importable under bun:test.
 */

import { decodeTokenData } from "./sse.js";
import type { WorkflowWsEvent } from "./ws.js";

export const RUN_STATUS = {
  IDLE: "idle",
  CONNECTING: "connecting",
  RUNNING: "running",
  OK: "ok",
  ERROR: "error",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const STEP_STATE = {
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
} as const;

export type StepState = (typeof STEP_STATE)[keyof typeof STEP_STATE];

export interface RunStep {
  nodeId: string;
  nodeType: string;
  /** Duration in ms once the step completed. */
  ms?: number;
  state: StepState;
}

export interface RunTranscript {
  status: RunStatus;
  /** Step lifecycle events in arrival order (loops may repeat node ids). */
  steps: RunStep[];
  /** Aggregated assistant output decoded from token events. */
  output: string;
  /** True once the run finished (status ok/error or a [DONE] token frame). */
  done: boolean;
  /** Verbatim run error (status error / error events). */
  error?: string;
}

/** Fresh run view; `connecting` is the status the panel sets while opening. */
export function createRunTranscript(status: RunStatus = RUN_STATUS.IDLE): RunTranscript {
  return { status, steps: [], output: "", done: false };
}

/** Apply one wire event to the transcript, returning the next snapshot. */
export function applyRunEvent(
  transcript: RunTranscript,
  event: WorkflowWsEvent,
): RunTranscript {
  switch (event.type) {
    case "status":
      return applyStatus(transcript, event);
    case "step_started":
      return applyStepStarted(transcript, event);
    case "step_completed":
      return applyStepCompleted(transcript, event);
    case "token":
      return applyToken(transcript, event);
    case "error":
      return applyError(transcript, event);
  }
}

function applyStatus(
  transcript: RunTranscript,
  event: Extract<WorkflowWsEvent, { type: "status" }>,
): RunTranscript {
  switch (event.state) {
    case "running":
      return { ...transcript, status: RUN_STATUS.RUNNING };
    case "ok":
      return { ...transcript, status: RUN_STATUS.OK, done: true, error: undefined };
    case "error":
      return { ...transcript, status: RUN_STATUS.ERROR, done: true, error: event.error };
    default:
      // "bound" carries no run-view transition.
      return transcript;
  }
}

function applyStepStarted(
  transcript: RunTranscript,
  event: Extract<WorkflowWsEvent, { type: "step_started" }>,
): RunTranscript {
  // A new step starting resolves any still-running predecessor(s) to done —
  // the engine's events are sequential per path; any branch the runner left
  // running converges to done once its own step_completed arrives.
  const steps = transcript.steps.map((step) =>
    step.state === STEP_STATE.RUNNING ? { ...step, state: STEP_STATE.DONE } : step,
  );
  steps.push({
    nodeId: event.nodeId,
    nodeType: event.nodeType,
    state: STEP_STATE.RUNNING,
  });
  return { ...transcript, steps };
}

function applyStepCompleted(
  transcript: RunTranscript,
  event: Extract<WorkflowWsEvent, { type: "step_completed" }>,
): RunTranscript {
  const steps = transcript.steps.map((step) =>
    step.nodeId === event.nodeId && step.state === STEP_STATE.RUNNING
      ? { ...step, state: STEP_STATE.DONE, ms: event.ms }
      : step,
  );
  return { ...transcript, steps };
}

function applyToken(
  transcript: RunTranscript,
  event: Extract<WorkflowWsEvent, { type: "token" }>,
): RunTranscript {
  const decoded = decodeTokenData(event.data);
  return {
    ...transcript,
    output:
      decoded.content.length > 0 ? transcript.output + decoded.content : transcript.output,
    done: transcript.done || decoded.done,
  };
}

function applyError(
  transcript: RunTranscript,
  event: Extract<WorkflowWsEvent, { type: "error" }>,
): RunTranscript {
  if (event.nodeId !== undefined) {
    // A step-level error marks that step; the runner's status error follows.
    const steps = transcript.steps.map((step) =>
      step.nodeId === event.nodeId && step.state === STEP_STATE.RUNNING
        ? { ...step, state: STEP_STATE.ERROR }
        : step,
    );
    return { ...transcript, steps };
  }
  // Protocol-level errors (bind failure, bad JSON, closed mid-run) end the run.
  return { ...transcript, status: RUN_STATUS.ERROR, done: true, error: event.error };
}