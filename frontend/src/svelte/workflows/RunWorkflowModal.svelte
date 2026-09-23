<script lang="ts">
  /**
   * Run a workflow with a single prompt turn. One-shot completion against the
   * real POST /api/workflows/:name/run — no streaming simulation. Accessible
   * dialog: role=dialog, aria-modal, Escape closes, backdrop click closes,
   * focus moves in on open and returns to the trigger on close.
   */
  import { ApiError, runWorkflow } from "../../lib/api/index.js";
  import { runOutcomeContent } from "../../lib/workflows-ui.js";
  import Button from "../common/Button.svelte";
  import IconButton from "../common/IconButton.svelte";
  import { trapFocus } from "../../lib/focus-trap.js";

  let {
    name,
    onClose,
  }: {
    name: string;
    /** Called on close; `changed` is true once a run attempt reached the
        backend (a log row was written), so the list can refresh. */
    onClose: (changed: boolean) => void;
  } = $props();

  let prompt = $state("");
  let running = $state(false);
  let outcome = $state<string | null>(null);
  let error = $state<string | null>(null);
  let attempted = $state(false);
  let dialogEl = $state<HTMLDivElement>();
  let lastFocused: HTMLElement | null = null;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return "request failed";
  }

  // Mount-time wiring: capture the trigger focus, move focus into the dialog,
  // keep Tab inside it, close on Escape. Focus restoration happens in close(),
  // while the dialog is still mounted; the cleanup only unregisters listeners.
  $effect(() => {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dialogEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    const release = dialogEl === undefined ? undefined : trapFocus(dialogEl);
    return () => {
      window.removeEventListener("keydown", onKey);
      release?.();
    };
  });

  function close(): void {
    lastFocused?.focus();
    onClose(attempted);
  }

  async function submit(): Promise<void> {
    if (running) return;
    running = true;
    error = null;
    outcome = null;
    try {
      const result = await runWorkflow(name, [{ role: "user", content: prompt }]);
      outcome = runOutcomeContent(result);
    } catch (err) {
      error = errorText(err);
    } finally {
      running = false;
      attempted = true;
    }
  }
</script>

<div class="backdrop" onclick={close}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="run-title"
    tabindex="-1"
    bind:this={dialogEl}
    onclick={(event) => event.stopPropagation()}
  >
    <div class="dialog-head">
      <h2 class="dialog-title" id="run-title">Run {name}</h2>
      <IconButton name="close" label="Close" onclick={close} />
    </div>

    <div class="dialog-body">
      {#if outcome !== null}
        <p class="field-label">Output</p>
        {#if outcome === ""}
          <p class="note">The workflow produced no text.</p>
        {:else}
          <pre class="outcome">{outcome}</pre>
        {/if}
      {:else}
        {#if error !== null}
          <p class="error-text" role="alert">{error}</p>
        {/if}
        <label class="field-label" for="run-prompt">Prompt</label>
        <textarea
          id="run-prompt"
          class="prompt"
          rows={5}
          bind:value={prompt}
          placeholder="Say hello"
          disabled={running}
        ></textarea>
      {/if}
    </div>

    <div class="dialog-foot">
      {#if outcome !== null}
        <Button variant="primary" onclick={close}>Close</Button>
      {:else}
        <Button variant="secondary" onclick={close}>Cancel</Button>
        <Button
          variant="primary"
          disabled={running || prompt.trim() === ""}
          onclick={submit}
        >
          {running ? "Running…" : "Run"}
        </Button>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 15vh var(--space-4) var(--space-4);
    background: rgba(0, 0, 0, 0.6);
  }

  .dialog {
    width: min(520px, 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2);
  }

  .dialog-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4) var(--space-4);
  }

  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }

  .field-label {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .prompt {
    width: 100%;
    min-height: 120px;
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

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .outcome {
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

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>