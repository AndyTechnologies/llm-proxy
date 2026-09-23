<script lang="ts">
  /**
   * API playground (U11) — POST /v1/chat/completions against the real wire.
   *
   * Honest-data discipline: every response renders VERBATIM from the wire.
   * Non-stream: the JSON completion body pretty-printed with a summary strip
   * of wire values only (finish_reason, usage when present). Stream: the
   * progressive raw SSE transcript, then a rolled-up view (final content,
   * terminal [DONE], frame count) with the raw transcript behind a native
   * disclosure. Never fabricated fields, never derived metrics.
   *
   * Auth: this console is NOT a credential surface. The v1 client never sets
   * an Authorization header; when WEAVELLM_AUTH is on the server answers /v1
   * with its 401 envelope and the playground shows it verbatim with a hint.
   *
   * Model suggestions are NON-authoritative: /api/models ids (local registry)
   * and gateway/<name> from /api/workflows. External adapter ids resolve
   * server-side; local backend ids currently answer the unknown-model 404
   * (boot wiring, src/main.ts) — surfaced verbatim, never faked.
   */
  import {
    ApiError,
    chatCompletion,
    chatCompletionStream,
    listModels,
    listWorkflows,
  } from "../../lib/api/index.js";
  import type { V1Completion, V1StreamEvent } from "../../lib/api/index.js";
  import { highlightJson } from "../../lib/v1-ui.js";
  import Button from "../common/Button.svelte";
  import IconButton from "../common/IconButton.svelte";
  import StatusDot from "../common/StatusDot.svelte";

  const STATUS = {
    IDLE: "idle",
    CONNECTING: "connecting",
    STREAMING: "streaming",
    DONE: "done",
    CANCELLED: "cancelled",
    ERROR: "error",
  } as const;

  type PlaygroundStatus = (typeof STATUS)[keyof typeof STATUS];

  const ROLES = {
    SYSTEM: "system",
    USER: "user",
    ASSISTANT: "assistant",
  } as const;

  type PlaygroundRole = (typeof ROLES)[keyof typeof ROLES];

  const STATUS_TONE: Record<PlaygroundStatus, "idle" | "ok" | "warn" | "error"> = {
    idle: "idle",
    connecting: "warn",
    streaming: "warn",
    done: "ok",
    cancelled: "idle",
    error: "error",
  };

  interface MessageRow {
    id: string;
    role: PlaygroundRole;
    content: string;
  }

  let status = $state<PlaygroundStatus>(STATUS.IDLE);
  let model = $state("");
  let messages = $state<MessageRow[]>([{ id: crypto.randomUUID(), role: ROLES.USER, content: "" }]);
  let temperature = $state("");
  let streamEnabled = $state(true);

  let error = $state<ApiError | null>(null);
  let completion = $state<V1Completion | null>(null);
  let rawSse = $state("");
  let streamContent = $state("");
  let streamFinalDone = $state(false);
  let streamTruncated = $state(false);
  let frameCount = $state(0);

  let suggestions = $state<{ local: string[]; gateway: string[] }>({ local: [], gateway: [] });

  let rawEl: HTMLPreElement | undefined = $state(undefined);
  let controller: AbortController | null = null;

  function isBusy(): boolean {
    return status === STATUS.CONNECTING || status === STATUS.STREAMING;
  }

  function statusLabel(): string {
    switch (status) {
      case STATUS.CONNECTING:
        return "Connecting…";
      case STATUS.STREAMING:
        return "Streaming…";
      case STATUS.DONE:
        return "Done";
      case STATUS.CANCELLED:
        return "Cancelled";
      case STATUS.ERROR:
        return "Error";
      default:
        return "Ready — press Send to run";
    }
  }

  // ── Model suggestions (non-fatal, never authoritative) ──────────────────

  $effect(() => {
    let alive = true;
    void Promise.allSettled([listModels(), listWorkflows()]).then(
      ([modelsResult, workflowsResult]) => {
        if (!alive) return;
        const local =
          modelsResult.status === "fulfilled"
            ? modelsResult.value.map((row) => row.id)
            : [];
        const gateway =
          workflowsResult.status === "fulfilled"
            ? workflowsResult.value.map((row) => `gateway/${row.name}`)
            : [];
        suggestions = { local, gateway };
      },
    );
    return () => {
      alive = false;
    };
  });

  // ── Send / cancel ───────────────────────────────────────────────────────

  function send(): void {
    if (isBusy() || model.trim() === "") return;
    controller = new AbortController();
    error = null;
    completion = null;
    rawSse = "";
    streamContent = "";
    streamFinalDone = false;
    streamTruncated = false;
    frameCount = 0;
    status = STATUS.CONNECTING;

    const temperatureRequest = temperature.trim() === "" ? undefined : Number(temperature);
    const body = {
      model: model.trim(),
      messages: messages.map((row) => ({ role: row.role, content: row.content })),
      temperature: Number.isFinite(temperatureRequest) ? temperatureRequest : undefined,
      stream: streamEnabled,
    };
    if (streamEnabled) void runStream(body);
    else void runOneShot(body);
  }

  interface ChatBody {
    model: string;
    messages: { role: PlaygroundRole; content: string }[];
    temperature?: number;
    stream: boolean;
  }

  async function runOneShot(body: ChatBody): Promise<void> {
    try {
      completion = await chatCompletion(body, { signal: controller?.signal });
      status = STATUS.DONE;
    } catch (err) {
      handleError(err);
    }
  }

  async function runStream(body: ChatBody): Promise<void> {
    try {
      const events: AsyncGenerator<V1StreamEvent> = chatCompletionStream(body, {
        onRaw: (chunk) => {
          rawSse += chunk;
        },
        onDone: (summary) => {
          streamContent = summary.content;
          streamFinalDone = summary.done;
        },
        signal: controller?.signal,
      });
      for await (const event of events) {
        if (event.type === "frame") {
          frameCount += 1;
          if (status === STATUS.CONNECTING) status = STATUS.STREAMING;
        } else if (event.type === "done") {
          status = STATUS.DONE;
        } else if (event.type === "truncated") {
          streamTruncated = true;
          status = STATUS.DONE;
        } else if (event.type === "aborted") {
          status = STATUS.CANCELLED;
        }
      }
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err: unknown): void {
    if (err instanceof ApiError) {
      if (err.code === "aborted") {
        status = STATUS.CANCELLED;
        return;
      }
      error = err;
      status = STATUS.ERROR;
      return;
    }
    error = new ApiError({
      status: 0,
      code: "unknown_error",
      message: err instanceof Error ? err.message : "request failed",
    });
    status = STATUS.ERROR;
  }

  function cancelRequest(): void {
    controller?.abort();
    controller = null;
    status = STATUS.CANCELLED;
  }

  // ── Message rows ────────────────────────────────────────────────────────

  function addMessage(): void {
    messages = [
      ...messages,
      { id: crypto.randomUUID(), role: ROLES.USER, content: "" },
    ];
  }

  function removeMessage(id: string): void {
    if (messages.length <= 1) return;
    messages = messages.filter((row) => row.id !== id);
  }

  // ── Stream display: stay pinned to the newest raw bytes while streaming ─

  $effect(() => {
    if (status === STATUS.STREAMING && rawEl !== undefined) {
      rawEl.scrollTop = rawEl.scrollHeight;
    }
  });

  // ── Derived render state ────────────────────────────────────────────────

  function errorHint(): string | null {
    if (error === null) return null;
    if (error.status === 401) {
      return "The server returned its Bearer-required envelope. Authentication is owned server-side (WEAVELLM_AUTH); this console never holds credentials.";
    }
    if (error.status === 404 && error.code === "model_not_found") {
      return "Unknown-model envelope shown verbatim. Local backend ids currently answer this 404 (boot wiring); external adapter ids and gateway/<name> resolve server-side.";
    }
    if (error.status === 0) {
      return "The backend was not reachable — check that the runtime is up and the dev proxy is running.";
    }
    return null;
  }
</script>

<div class="playground">
  <div class="grid">
    <section class="card request-card" aria-label="Request">
      <div class="card-head">
        <h2 class="card-title">Request</h2>
        <span class="endpoint">POST /v1/chat/completions</span>
      </div>

      <div class="field">
        <label class="field-label" for="playground-model">Model</label>
        <input
          id="playground-model"
          class="text-input"
          type="text"
          bind:value={model}
          list="playground-model-suggestions"
          placeholder="gateway/summary"
          autocomplete="off"
          spellcheck="false"
          disabled={isBusy()}
        />
        <datalist id="playground-model-suggestions">
          {#each suggestions.local as id (id)}
            <option value={id} />
          {/each}
          {#each suggestions.gateway as id (id)}
            <option value={id} />
          {/each}
        </datalist>
        <p class="field-hint">
          Suggestions — local registry ids and gateway/&lt;workflow&gt; names.
          External adapter ids resolve server-side; the server answers unknown
          models with a 404 envelope.
        </p>
      </div>

      <fieldset class="field messages-field" disabled={isBusy()}>
        <legend class="field-label">Messages</legend>
        <div class="msg-cols" aria-hidden="true">
          <span>Role</span>
          <span>Content</span>
          <span></span>
        </div>
        {#each messages as row, i (row.id)}
          <div class="msg-row">
            <select
              class="role-select"
              aria-label="Message {i + 1} role"
              bind:value={row.role}
            >
              <option value={ROLES.SYSTEM}>system</option>
              <option value={ROLES.USER}>user</option>
              <option value={ROLES.ASSISTANT}>assistant</option>
            </select>
            <textarea
              class="msg-content"
              aria-label="Message {i + 1} content"
              rows={2}
              bind:value={row.content}
              placeholder="Message content"
            ></textarea>
            <IconButton
              name="close"
              label="Remove message {i + 1}"
              disabled={messages.length <= 1}
              onclick={() => removeMessage(row.id)}
            />
          </div>
        {/each}
        <div class="row-actions">
          <Button
            variant="secondary"
            ariaLabel="Add message"
            disabled={isBusy()}
            onclick={addMessage}
          >
            Add message
          </Button>
        </div>
      </fieldset>

      <div class="options">
        <div class="field temp-field">
          <label class="field-label" for="playground-temperature">
            Temperature (optional)
          </label>
          <input
            id="playground-temperature"
            class="text-input temp-input"
            type="number"
            min={0}
            max={2}
            step={0.1}
            bind:value={temperature}
            placeholder="0–2"
            disabled={isBusy()}
          />
        </div>
        <label class="check" for="playground-stream">
          <input
            id="playground-stream"
            type="checkbox"
            bind:checked={streamEnabled}
            disabled={isBusy()}
          />
          Stream (SSE)
        </label>
      </div>

      <div class="actions">
        <p class="auth-note">
          Requests leave this console unauthenticated — the server owns auth
          (WEAVELLM_AUTH) and credentials never live here.
        </p>
        {#if isBusy()}
          <Button variant="secondary" onclick={cancelRequest}>Cancel</Button>
        {/if}
        <Button
          variant="primary"
          disabled={isBusy() || model.trim() === ""}
          onclick={send}
        >
          {isBusy() ? (status === STATUS.STREAMING ? "Streaming…" : "Connecting…") : "Send request"}
        </Button>
      </div>
    </section>

    <section class="card response-card" aria-label="Response">
      <div class="card-head">
        <h2 class="card-title">Response</h2>
        <div class="status-line" role="status" aria-live="polite">
          <StatusDot tone={STATUS_TONE[status]} label={statusLabel()} />
          {#if status === STATUS.STREAMING}
            <span class="frame-count">
              {frameCount} {frameCount === 1 ? "frame" : "frames"}
            </span>
          {/if}
        </div>
      </div>

      {#if status === STATUS.IDLE && error === null && completion === null && rawSse === ""}
        <p class="note">
          The response renders verbatim here — no derived metrics. Press Send
          to run the request.
        </p>
      {/if}

      {#if status === STATUS.CANCELLED}
        <p class="note">
          Request cancelled. Closing the connection makes the server abort the
          upstream call (relay contract).
        </p>
      {/if}

      {#if error !== null && status === STATUS.ERROR}
        <div class="error-box" role="alert">
          <p class="error-title">
            {error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message}
          </p>
          <p class="error-code">code: {error.code}</p>
          {#if errorHint() !== null}
            <p class="error-hint">{errorHint()}</p>
          {/if}
          {#if error.errors !== undefined && error.errors !== null}
            <details class="error-envelope">
              <summary>Server envelope (verbatim)</summary>
              <pre class="json-view error-json">{highlightJson(JSON.stringify(error.errors, null, 2))}</pre>
            </details>
          {/if}
        </div>
      {/if}

      {#if completion !== null && status === STATUS.DONE}
        <div class="result">
          <div class="wire-summary">
            {#if completion.choices[0]}
              <span class="wire-chip">finish_reason: {completion.choices[0].finish_reason ?? "null"}</span>
            {/if}
            {#if completion.usage !== null && completion.usage !== undefined}
              <span class="wire-chip">
                usage: {completion.usage.prompt_tokens} prompt / {completion.usage.completion_tokens} completion / {completion.usage.total_tokens} total
              </span>
            {/if}
            <span class="wire-label">— wire values only</span>
          </div>
          <pre class="json-view">{highlightJson(JSON.stringify(completion, null, 2))}</pre>
        </div>
      {/if}

      {#if streamEnabled && (rawSse !== "" || streamContent !== "" || streamTruncated)}
        <div class="result">
          {#if streamContent !== ""}
            <div class="stream-output">
              <p class="field-label">Final content (verbatim)</p>
              <pre class="output">{streamContent}</pre>
            </div>
          {/if}
          <div class="stream-meta">
            {#if streamFinalDone}
              <span class="done-marker">
                <code>data: [DONE]</code> terminal marker received
              </span>
            {:else}
              <span class="done-marker truncated">
                Stream ended without the terminal <code>[DONE]</code> marker
              </span>
            {/if}
            {#if streamTruncated}
              <span class="wire-chip">truncated</span>
            {/if}
            <span class="wire-chip">{frameCount} {frameCount === 1 ? "frame" : "frames"}</span>
          </div>
          <details class="raw-details">
            <summary>Raw SSE transcript</summary>
            <pre class="output raw-output" bind:this={rawEl}>{rawSse}</pre>
          </details>
        </div>
      {/if}

      {#if status === STATUS.CONNECTING}
        <p class="note" aria-busy="true">Connecting to /v1/chat/completions…</p>
      {/if}
    </section>
  </div>
</div>

<style>
  .playground {
    display: flex;
    flex-direction: column;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .card {
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .card-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .endpoint {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .field-label {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .text-input {
    width: 100%;
    min-height: 36px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .text-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .text-input::placeholder {
    color: var(--muted);
  }

  .text-input:disabled {
    opacity: 0.6;
  }

  .field-hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .messages-field {
    margin: 0 0 var(--space-4);
    padding: 0;
    border: 0;
  }

  .messages-field:disabled {
    opacity: 0.6;
  }

  .msg-cols {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr) 36px;
    gap: var(--space-2);
    margin-bottom: var(--space-1);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .msg-row {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr) 36px;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    align-items: start;
  }

  .role-select {
    min-height: 36px;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
  }

  .role-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .msg-content {
    width: 100%;
    min-height: 36px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    line-height: 1.5;
    resize: vertical;
  }

  .msg-content:focus {
    outline: none;
    border-color: var(--accent);
  }

  .msg-content::placeholder {
    color: var(--muted);
  }

  .row-actions {
    display: flex;
    justify-content: flex-end;
  }

  .options {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .temp-field {
    margin-bottom: 0;
  }

  .temp-input {
    max-width: 120px;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    color: var(--secondary);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .check input {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }

  .check:has(input:disabled) {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .auth-note {
    margin: 0 auto 0 0;
    max-width: 42ch;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .status-line {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--secondary);
    font-size: 0.8125rem;
  }

  .frame-count {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .note {
    margin: 0;
    padding: var(--space-3) 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .error-box {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-control);
    background: var(--code);
  }

  .error-title {
    margin: 0;
    color: var(--danger);
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.5;
  }

  .error-code {
    margin: 0;
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .error-hint {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--bg);
    color: var(--secondary);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .error-envelope summary {
    color: var(--secondary);
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .error-json {
    max-height: 280px;
    overflow: auto;
    margin-top: var(--space-2);
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .wire-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .wire-label {
    color: var(--muted);
    font-size: 0.75rem;
  }

  .wire-chip {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--bg);
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .json-view {
    margin: 0;
    max-height: 480px;
    overflow: auto;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    white-space: pre;
  }

  .json-view :global(.tok-key) {
    color: var(--accent-hover);
  }

  .json-view :global(.tok-string) {
    color: var(--text);
  }

  .json-view :global(.tok-number),
  .json-view :global(.tok-bool),
  .json-view :global(.tok-null) {
    color: var(--secondary);
  }

  .json-view :global(.tok-punct) {
    color: var(--muted);
  }

  .stream-output {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .output {
    margin: 0;
    max-height: 320px;
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

  .stream-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .done-marker {
    color: var(--success);
    font-size: 0.8125rem;
  }

  .done-marker code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .done-marker.truncated {
    color: var(--danger);
  }

  .raw-details summary {
    color: var(--secondary);
    font-size: 0.8125rem;
    cursor: pointer;
    user-select: none;
  }

  .raw-output {
    max-height: 240px;
  }

  @media (max-width: 960px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>