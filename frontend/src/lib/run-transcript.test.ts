/**
 * bun:test suite for the run-view state machine (run-transcript.ts). All
 * events are applied synchronously in arrival order; each test drives an
 * explicit event sequence and asserts the resulting snapshot.
 */

import { describe, expect, test } from "bun:test";
import {
  RUN_STATUS,
  createRunTranscript,
  applyRunEvent,
} from "./run-transcript.js";
import type { RunTranscript, RunStep } from "./run-transcript.js";
import type { WorkflowWsEvent } from "./ws.js";

function status(
  state: "bound" | "running" | "ok" | "error",
  error?: string,
): WorkflowWsEvent {
  return { type: "status", workflow: "demo", state, error };
}

function started(nodeId: string, nodeType = "llm_call"): WorkflowWsEvent {
  return { type: "step_started", workflow: "demo", nodeId, nodeType };
}

function completed(nodeId: string, ms: number): WorkflowWsEvent {
  return { type: "step_completed", workflow: "demo", nodeId, ms };
}

function token(data: string): WorkflowWsEvent {
  return { type: "token", workflow: "demo", data };
}

function runError(error: string, nodeId?: string): WorkflowWsEvent {
  return { type: "error", workflow: "demo", error, nodeId };
}

function contentFrame(text: string): string {
  return `data: {"choices":[{"message":{"content":${JSON.stringify(text)}}}]}\n\n`;
}

function doneFrame(): string {
  return "data: [DONE]\n\n";
}

function run(fresh: RunTranscript, ...events: WorkflowWsEvent[]): RunTranscript {
  return events.reduce(applyRunEvent, fresh);
}

describe("createRunTranscript", () => {
  test("starts idle with no steps, output or error", () => {
    expect(createRunTranscript()).toEqual({
      status: "idle",
      steps: [],
      output: "",
      done: false,
    });
  });

  test("accepts an explicit initial status (connecting)", () => {
    expect(createRunTranscript(RUN_STATUS.CONNECTING).status).toBe("connecting");
  });
});

describe("applyRunEvent — lifecycle", () => {
  test("status bound is a no-op for the run view", () => {
    const t = run(createRunTranscript(), status("bound"));
    expect(t.status).toBe("idle");
  });

  test("status running marks the run active", () => {
    const t = run(createRunTranscript(), status("running"));
    expect(t.status).toBe("running");
  });

  test("status ok is terminal", () => {
    const fresh = createRunTranscript();
    const t = run(fresh, status("running"), status("ok"));
    expect(t.status).toBe("ok");
    expect(t.done).toBe(true);
    expect(t.error).toBeUndefined();
  });

  test("status error is terminal and carries the verbatim error", () => {
    const t = run(createRunTranscript(), status("running"), status("error", "boom"));
    expect(t.status).toBe("error");
    expect(t.done).toBe(true);
    expect(t.error).toBe("boom");
  });
});

describe("applyRunEvent — steps", () => {
  test("step_started appends a running step", () => {
    const t = run(createRunTranscript(), started("llm-1", "llm_call"));
    expect(t.steps).toEqual([{ nodeId: "llm-1", nodeType: "llm_call", state: "running" }]);
  });

  test("an earlier running step resolves to done when a new step starts", () => {
    const t = run(createRunTranscript(), started("start"), started("llm-1"));
    expect(t.steps.map((s) => s.state)).toEqual(["done", "running"]);
  });

  test("step_completed marks the running step done with its duration", () => {
    const t = run(createRunTranscript(), started("llm-1"), completed("llm-1", 384));
    const step = t.steps[0] as RunStep;
    expect(step.state).toBe("done");
    expect(step.ms).toBe(384);
  });

  test("step_completed for an unknown node leaves the trace untouched", () => {
    const t = run(createRunTranscript(), started("llm-1"), completed("ghost", 5));
    expect(t.steps[0]?.state).toBe("running");
  });

  test("the same node id across loop iterations keeps separate step entries", () => {
    const t = run(
      createRunTranscript(),
      started("llm-1"),
      completed("llm-1", 10),
      started("llm-1"),
      completed("llm-1", 20),
    );
    expect(t.steps).toHaveLength(2);
    expect(t.steps.map((s) => s.ms)).toEqual([10, 20]);
    expect(t.steps.every((s) => s.state === "done")).toBe(true);
  });
});

describe("applyRunEvent — tokens", () => {
  test("token frames append decoded content in order", () => {
    const t = run(
      createRunTranscript(),
      token(contentFrame("The ")),
      token(contentFrame("answer.")),
    );
    expect(t.output).toBe("The answer.");
    expect(t.done).toBe(false);
  });

  test("a [DONE] token frame sets done without appending content", () => {
    const t = run(createRunTranscript(), token(contentFrame("hi")), token(doneFrame()));
    expect(t.output).toBe("hi");
    expect(t.done).toBe(true);
  });

  test("empty token frames leave the output untouched", () => {
    const t = run(createRunTranscript(), token(""));
    expect(t.output).toBe("");
    expect(t.done).toBe(false);
  });
});

describe("applyRunEvent — errors", () => {
  test("an error with a nodeId marks that running step error", () => {
    const t = run(createRunTranscript(), started("llm-1"), runError("boom", "llm-1"));
    expect(t.steps[0]?.state).toBe("error");
    // Terminality is decided by the runner's status error, not the step error.
    expect(t.status).toBe("idle");
    expect(t.done).toBe(false);
  });

  test("an error without a nodeId (protocol-level) ends the run", () => {
    const t = run(createRunTranscript(), runError("unknown workflow \"ghost\""));
    expect(t.status).toBe("error");
    expect(t.done).toBe(true);
    expect(t.error).toBe('unknown workflow "ghost"');
  });

  test("a step error followed by status error stays terminal with the status text", () => {
    const t = run(
      createRunTranscript(),
      started("llm-1"),
      runError("boom", "llm-1"),
      status("error", "boom"),
    );
    expect(t.status).toBe("error");
    expect(t.done).toBe(true);
    expect(t.error).toBe("boom");
    expect(t.steps[0]?.state).toBe("error");
  });
});

describe("applyRunEvent — full wire sequence", () => {
  test("sequential happy path mirrors the real protocol", () => {
    const fresh = createRunTranscript(RUN_STATUS.CONNECTING);
    const t = run(
      fresh,
      status("bound"),
      status("running"),
      started("start"),
      completed("start", 2),
      started("llm-1"),
      completed("llm-1", 384),
      started("end"),
      completed("end", 1),
      token(contentFrame("Hello!")),
      token(doneFrame()),
      status("ok"),
    );
    expect(t.status).toBe("ok");
    expect(t.done).toBe(true);
    expect(t.output).toBe("Hello!");
    expect(t.steps.map((s) => s.nodeId)).toEqual(["start", "llm-1", "end"]);
    expect(t.steps.every((s) => s.state === "done")).toBe(true);
  });

  test("protocol error mid-run ends with the error visible", () => {
    const t = run(
      createRunTranscript(RUN_STATUS.CONNECTING),
      status("running"),
      started("llm-1"),
      token("data: not-json\n\n"),
      runError("received a message that is not valid JSON"),
    );
    expect(t.status).toBe("error");
    expect(t.error).toBe("received a message that is not valid JSON");
  });
});