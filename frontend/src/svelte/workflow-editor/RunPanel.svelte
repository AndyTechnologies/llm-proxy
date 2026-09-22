<script lang="ts">
  /**
   * Run panel (U07) — the execution drawer inside the workflow editor.
   *
   * Two sections (Run / Runs), the live run view driving the REAL /ws
   * protocol through lib/ws.ts + lib/run-transcript.ts, and executions from
   * GET /api/workflows/:name/logs in the Runs tab (no global API exists —
   * logs stay per-workflow in the editor).
   *
   * Live runs show step lifecycle events as they stream and the aggregated
   * output when the final token frames arrive — the real protocol has no
   * mid-run per-token streaming, so nothing here invents one. When the
   * socket cannot be established the panel honestly falls back to the
   * one-shot POST /api/workflows/:name/run into the same output view.
   */
  import { ApiError, runWorkflow, workflowLogs } from "../../lib/api/index.js";
  import type { ExecutionLogRow } from "../../lib/api/index.js";
  import {
    RUN_STATUS,
    applyRunEvent,
    createRunTranscript,
  } from "../../lib/run-transcript.js";
  import type { RunTranscript } from "../../lib/run-transcript.js";
  import { connectWorkflowSocket } from "../../lib/ws.js";
  import type { WorkflowChatMessage, WorkflowSocket } from "../../lib/ws.js";
  import { encodeTokenFrame } from "../../lib/sse.js";
  import { formatMs, formatUpdatedAt, runOutcomeContent } from "../../lib/workflows-ui.js";
  import Button from "../common/Button.svelte";
  import Icon from "../common/Icon.svelte";
  import IconButton from "../common/IconButton.svelte";
  import StatusDot from "../common/StatusDot.svelte";

  let {
    name,
    onClose,
  }: {
    name: string;
    /** Called when the drawer is closed (focus restored by the panel). */
    onClose: () => void;
  } = $props();

  /** Static skeleton rows shown while the first logs load is in flight. */
  const SKELETON_ROWS = 3;
  const skeletons = Array.from({ length: SKELETON_ROWS });

  let tab = $state<"run" | "runs">("run");
  let prompt = $state("");
  let transcript = $state<RunTranscript>(createRunTranscript());
  /** User cancelled a run (the wire has no cancel event — local state). */
  let cancelled = $state(false);
  /** The live socket failed; the current/next run uses one-shot HTTP. */
  let oneShot = $state(false);
  // Plain field: never rendered reactively, only closed/read imperatively.
  let socket: WorkflowSocket | null = null;

  // ── Runs tab state (logs) ──────────────────────────────────────────────
  let logs = $state<ExecutionLogRow[] | null>(null);
  let logsError = $state<string | null>(null);
  let logsAttempt = $state(0);
  /** Monotonic request id: a slower older refresh never overwrites a newer one. */
  let requestSeq = 0;

  let panelEl = $state<HTMLDivElement>();
  let lastFocused: HTMLElement | null = null;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return err instanceof Error ? err.message : "request failed";
  }

  // ── Live run ────────────────────────────────────────────────────────────

  /** A run is in progress while connecting, running, or user-cancelled. */
  function isBusy(): boolean {
    return (
      !cancelled &&
      (transcript.status === RUN_STATUS.CONNECTING || transcript.status === RUN_STATUS.RUNNING)
    );
  }

  function statusLabel(): string {
    if (cancelled) return "Cancelled";
    switch (transcript.status) {
      case RUN_STATUS.CONNECTING:
        return "Connecting…";
      case RUN_STATUS.RUNNING:
        return "Running…";
      case RUN_STATUS.OK:
        return "Done";
      case RUN_STATUS.ERROR:
        return "Failed";
      default:
        return "";
    }
  }

  function startRun(): void {
    if (isBusy()) return;
    const messages: WorkflowChatMessage[] = [{ role: "user", content: prompt }];
    transcript = createRunTranscript(RUN_STATUS.CONNECTING);
    cancelled = false;
    oneShot = false;
    socket?.close();
    socket = null;

    let wsSocket: WorkflowSocket;
    try {
      wsSocket = connectWorkflowSocket({
        workflow: name,
        onEvent: (event) => {
          transcript = applyRunEvent(transcript, event);
        },
        onClose: () => {
          if (socket === wsSocket) socket = null;
        },
      });
    } catch {
      // Socket construction failed (e.g. invalid URL scheme) → fall back.
      oneShot = true;
      void runOneShot(messages);
      return;
    }
    socket = wsSocket;

    void wsSocket.ready.then((ok) => {
      if (socket !== wsSocket || cancelled) return; // superseded or cancelled
      if (ok) {
        wsSocket.sendRun(messages);
        return;
      }
      // Live streaming unavailable (no socket / bind failed) — honest
      // fallback through the HTTP one-shot run into the same output view.
      oneShot = true;
      transcript = createRunTranscript(RUN_STATUS.CONNECTING);
      void runOneShot(messages);
    });
  }

  /** One-shot HTTP run — same output view, marked "one-shot" in the UI. */
  async function runOneShot(messages: WorkflowChatMessage[]): Promise<void> {
    try {
      const result = await runWorkflow(name, messages);
      const content = runOutcomeContent(result);
      // Synthesize the same wire sequence a live run emits: output frame,
      // [DONE], then status ok — the transcript decodes them identically.
      if (content !== null) {
        transcript = applyRunEvent(transcript, {
          type: "token",
          workflow: name,
          data: encodeTokenFrame(content),
        });
      }
      transcript = applyRunEvent(transcript, {
        type: "token",
        workflow: name,
        data: "data: [DONE]\n\n",
      });
      transcript = applyRunEvent(transcript, { type: "status", workflow: name, state: "ok" });
    } catch (err) {
      transcript = applyRunEvent(transcript, {
        type: "status",
        workflow: name,
        state: "error",
        error: errorText(err),
      });
    }
  }

  /** Cancel: closing the socket aborts the upstream run by wire contract. */
  function cancel(): void {
    if (socket !== null) {
      cancelled = true;
      socket.close();
      socket = null;
    }
  }

  // ── Runs tab (execution logs) ───────────────────────────────────────────

  async function loadLogs(): Promise<void> {
    const seq = ++requestSeq;
    logsError = null;
    try {
      const rows = await workflowLogs(name);
      if (seq === requestSeq) logs = rows;
    } catch (err) {
      if (seq === requestSeq) logsError = errorText(err);
    }
  }

  /** First-open load + Retry (`logsAttempt` bumps re-run this effect). */
  $effect(() => {
    void logsAttempt;
    void tab;
    if (tab === "runs") void loadLogs();
  });

  /** The backend writes the log row before resolving the run, so a terminal
      status guarantees the row exists — refresh the runs tab after it. */
  $effect(() => {
    if (transcript.status === RUN_STATUS.OK || transcript.status === RUN_STATUS.ERROR) {
      void loadLogs();
    }
  });

  // ── Drawer wiring: focus in, Escape out, socket teardown on unmount ─────

  $effect(() => {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => panelEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Socket leases die with the panel (an open socket would keep streaming).
  $effect(() => {
    return () => {
      socket?.close();
      socket = null;
    };
  });

  function closePanel(): void {
    socket?.close();
    socket = null;
    lastFocused?.focus();
    onClose();
  }
</script>

<aside
  class="run-panel"
  role="region"
  aria-label="Run workflow"
  tabindex="-1"
  bind:this={panelEl}
  data-testid="run-panel"
>
  <div class="panel-head">
    <h2 class="panel-title" id="run-panel-title">Run {name}</h2>
    <IconButton name="close" label="Close run panel" onclick={closePanel} />
  </div>

  <div class="tabs" role="group" aria-label="Run panel sections">
    <button
      type="button"
      class="tab"
      aria-pressed={tab === "run"}
      onclick={() => {
        tab = "run";
      }}
    >
      Run
    </button>
    <button
      type="button"
      class="tab"
      aria-pressed={tab === "runs"}
      onclick={() => {
        tab = "runs";
      }}
    >
      Runs
    </button>
  </div>

  <div class="tab-body">
    {#if tab === "run"}
      <div class="run-tab">
        {#if oneShot}
          <p class="notice" role="status">Live streaming unavailable — using one-shot run.</p>
        {/if}

        <label class="field-label" for="run-prompt">Prompt</label>
        <textarea
          id="run-prompt"
          class="prompt"
          rows={5}
          bind:value={prompt}
          placeholder="Say hello"
          disabled={isBusy()}
        ></textarea>

        <div class="actions">
          {#if isBusy()}
            <Button variant="secondary" onclick={cancel}>Cancel</Button>
          {/if}
          <Button variant="primary" disabled={isBusy()} onclick={startRun}>
            {isBusy() ? "Running…" : "Run"}
          </Button>
        </div>

        {#if transcript.status !== "idle" || transcript.steps.length > 0 || transcript.error !== undefined}
          <div class="live" aria-live="polite">
            <p class="status-line status-{transcript.status}{cancelled ? " status-cancelled" : ""}">
              {statusLabel()}
            </p>

            {#if transcript.steps.length > 0}
              <p class="field-label">Steps</p>
              <ul class="step-list" aria-label="Step trace">
                {#each transcript.steps as step, i (i)}
                  <li class="step-chip step-{step.state}">
                    <span class="step-id">{step.nodeId}</span>
                    <span class="step-type">{step.nodeType}</span>
                    {#if step.state === "done"}
                      <Icon name="check" size={12} />
                    {:else if step.state === "error"}
                      <span class="step-mark" aria-hidden="true">!</span>
                    {:else}
                      <span class="step-running" aria-hidden="true"></span>
                    {/if}
                    <span class="sr-only">{step.state}</span>
                  </li>
                {/each}
              </ul>
            {/if}

            {#if transcript.output !== ""}
              <p class="field-label">Output</p>
              <pre class="output">{transcript.output}</pre>
            {/if}

            {#if transcript.error !== undefined}
              <div class="error-box" role="alert">
                <p class="error-text">{transcript.error}</p>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="runs-tab">
        {#if logsError !== null}
          <div class="state" role="alert">
            <p class="error-text">{logsError}</p>
            <Button
              variant="secondary"
              ariaLabel="Retry loading runs"
              onclick={() => {
                logsAttempt += 1;
              }}
            >
              Retry
            </Button>
          </div>
        {:else if logs === null}
          <ul class="log-list" aria-busy="true">
            {#each skeletons as _skel, i (i)}
              <li class="log-row" aria-hidden="true">
                <span class="sk sk-status"></span>
                <span class="sk sk-started"></span>
                <span class="sk sk-ms"></span>
              </li>
            {/each}
          </ul>
          <p class="sr-only">Loading runs…</p>
        {:else if logs.length === 0}
          <p class="note">No runs yet. Run this workflow to see execution history here.</p>
        {:else}
          <ul class="log-list">
            {#each logs as entry (entry.id)}
              <li class="log-row">
                <StatusDot tone={entry.status} label={entry.status} />
                <span class="cell-started">{formatUpdatedAt(entry.startedAt)}</span>
                <span class="cell-ms">{formatMs(entry.ms)}</span>
                {#if entry.status === "error" && entry.error !== null && entry.error !== ""}
                  <span class="cell-error">{entry.error}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .run-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    width: min(440px, 100%);
    border-left: 1px solid var(--border);
    background: var(--card);
    box-shadow: -16px 0 40px rgba(0, 0, 0, 0.35);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2);
  }

  .panel-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .tabs {
    display: flex;
    gap: var(--space-1);
    padding: 0 var(--space-4) var(--space-3);
  }

  .tab {
    min-height: 32px;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--secondary);
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .tab:hover {
    color: var(--text);
    background: var(--accent-subtle);
  }

  .tab[aria-pressed="true"] {
    background: var(--accent-subtle);
    border-color: var(--border-hover);
    color: var(--accent-hover);
  }

  .tab-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .notice {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--accent-subtle);
    color: var(--secondary);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .field-label {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .prompt {
    width: 100%;
    min-height: 110px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.5;
    resize: vertical;
  }

  .prompt:focus {
    outline: none;
    border-color: var(--accent);
  }

  .prompt::placeholder {
    color: var(--muted);
  }

  .prompt:disabled {
    opacity: 0.6;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .live {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
  }

  .status-line {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--secondary);
  }

  .status-running,
  .status-connecting {
    color: var(--accent-hover);
  }

  .status-cancelled {
    color: var(--secondary);
  }

  .status-ok {
    color: var(--success);
  }

  .status-error {
    color: var(--danger);
  }

  .step-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .step-chip {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 28px;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--bg);
    font-size: 0.75rem;
  }

  .step-id {
    color: var(--text);
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .step-type {
    color: var(--muted);
    font-family: var(--font-mono);
  }

  /* Running: subtle accent dot, deliberately spin-free (no spinners). */
  .step-running {
    width: 8px;
    height: 8px;
    margin-left: auto;
    border-radius: var(--radius-full);
    background: var(--accent);
  }

  .step-done {
    border-color: var(--border);
  }

  .step-done .step-id {
    color: var(--secondary);
  }

  .step-done :global(svg) {
    margin-left: auto;
    color: var(--success);
  }

  .step-error {
    border-color: var(--danger);
  }

  .step-mark {
    margin-left: auto;
    color: var(--danger);
    font-weight: 700;
  }

  .output {
    margin: 0;
    max-height: 240px;
    overflow-y: auto;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-box {
    padding: var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-control);
    background: var(--code);
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .note {
    margin: 0;
    padding: var(--space-2) 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }

  .log-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  .log-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "status started ms";
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .log-row:last-child {
    border-bottom: 0;
  }

  .log-row > :first-child {
    grid-area: status;
  }

  .cell-started {
    grid-area: started;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .cell-ms {
    grid-area: ms;
    justify-self: end;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .log-row:has(.cell-error) {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "status started ms"
      "status error error";
  }

  .cell-error {
    grid-area: error;
    align-self: start;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  /* Static skeleton blocks — no animation (reduced-motion safe). */
  .sk {
    display: block;
    background: var(--code);
    border-radius: var(--radius-control);
  }

  .sk-status {
    width: 72px;
    height: 12px;
  }

  .sk-started {
    width: 140px;
    height: 12px;
  }

  .sk-ms {
    width: 56px;
    height: 12px;
    justify-self: end;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>