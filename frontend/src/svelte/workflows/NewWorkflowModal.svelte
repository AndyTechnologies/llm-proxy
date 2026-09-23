<script lang="ts">
/**
   * Create a workflow from the canonical template. Shape verified against the
   * real parser (`src/orchestrator/workflow-yaml.ts` + `graph.ts`):
   * - `nodes` is an ARRAY of node objects using the engine's field names
   *   (unknown fields are dropped; there is no map form);
   * - `llm_call` requires a non-empty `model` (placeholder here — the editor
   *   lets the user pick a real one); `provider` is optional;
   * - flow is expressed by `edges` only (there is no `next` field).
   * Only the `name:` placeholder is swapped for the typed name.
   */
  import { ApiError, saveWorkflow } from "../../lib/api/index.js";
  import Button from "../common/Button.svelte";
  import IconButton from "../common/IconButton.svelte";

  let { onClose }: { onClose: () => void } = $props();

  const NAME_PATTERN = /^[a-z0-9._-]+$/i;

  /** Canonical new-workflow definition (real backend shape). */
  const TEMPLATE = `name: NEW_NAME
nodes:
  - id: start
    type: start
  - id: llm
    type: llm_call
    mode: generate
    model: your-model-id
  - id: end
    type: end
edges:
  - from: start
    to: llm
  - from: llm
    to: end
`;

  let name = $state("");
  let yaml = $state(TEMPLATE);
  let nameTouched = $state(false);
  /** Stops auto-sync once the user edits the YAML by hand. */
  let yamlDirty = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let errorDetails = $state<string[]>([]);
  let dialogEl = $state<HTMLDivElement>();
  let nameEl = $state<HTMLInputElement>();
  let lastFocused: HTMLElement | null = null;

  const valid = $derived(
    name.trim() !== "" && NAME_PATTERN.test(name.trim()),
  );

  function templateFor(workflowName: string): string {
    if (workflowName.trim() === "") return TEMPLATE;
    return TEMPLATE.replace("NEW_NAME", workflowName.trim());
  }

  // Keep the template's name placeholders in sync while the YAML is untouched.
  $effect(() => {
    if (yamlDirty) return;
    yaml = templateFor(name);
  });

  function onNameInput(): void {
    nameTouched = true;
  }

  function nameError(): string | null {
    if (!nameTouched) return null;
    const trimmed = name.trim();
    if (trimmed === "") return "Name is required.";
    if (!NAME_PATTERN.test(trimmed)) {
      return "Only letters, digits, dot, underscore and dash are allowed.";
    }
    return null;
  }

  // Dialog wiring: capture focus, move it to the name field, close on Escape.
  // Focus restoration happens in close(), while the dialog is still mounted.
  $effect(() => {
    lastFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => nameEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function close(): void {
    lastFocused?.focus();
    onClose();
  }

  async function submit(): Promise<void> {
    if (saving || !valid) return;
    saving = true;
    error = null;
    errorDetails = [];
    try {
      const result = await saveWorkflow(name.trim(), yaml);
      // The library already re-fetches on modal close; the canvas page is a
      // U05 placeholder, so a full navigation is the honest next step.
      window.location.assign(`/workflows/${encodeURIComponent(result.name)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
        if (Array.isArray(err.errors)) {
          errorDetails = err.errors.map((line) =>
            typeof line === "string" ? line : String(line),
          );
        }
      } else {
        error = "request failed";
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="backdrop" onclick={close}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-title"
    tabindex="-1"
    bind:this={dialogEl}
    onclick={(event) => event.stopPropagation()}
  >
    <div class="dialog-head">
      <h2 class="dialog-title" id="new-title">New workflow</h2>
      <IconButton name="close" label="Close" onclick={close} />
    </div>

    <div class="dialog-body">
      <label class="field-label" for="new-name">Name</label>
      <input
        id="new-name"
        type="text"
        bind:this={nameEl}
        bind:value={name}
        oninput={onNameInput}
        placeholder="my-workflow"
        autocomplete="off"
        spellcheck="false"
        disabled={saving}
      />
      {#if nameError() !== null}
        <p class="error-text" role="alert">{nameError()}</p>
      {/if}

      <label class="field-label" for="new-yaml">YAML definition</label>
      <textarea
        id="new-yaml"
        class="yaml"
        rows={13}
        bind:value={yaml}
        oninput={() => {
          yamlDirty = true;
        }}
        disabled={saving}
      ></textarea>

      {#if error !== null}
        <p class="error-text" role="alert">{error}</p>
      {/if}
      {#if errorDetails.length > 0}
        <pre class="error-details" role="alert">{errorDetails.join("\n")}</pre>
      {/if}
    </div>

    <div class="dialog-foot">
      <Button variant="secondary" disabled={saving} onclick={close}>Cancel</Button>
      <Button variant="primary" disabled={saving || !valid} onclick={submit}>
        {saving ? "Saving…" : "Create workflow"}
      </Button>
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
    padding: 10vh var(--space-4) var(--space-4);
    background: rgba(0, 0, 0, 0.6);
  }

  .dialog {
    width: min(560px, 100%);
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
    font-size: 1rem;
    font-weight: 600;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4) var(--space-4);
  }

  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }

  .field-label {
    color: var(--secondary);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  input {
    width: 100%;
    min-height: 36px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    font-family: var(--font-mono);
  }

  input:focus,
  .yaml:focus {
    outline: none;
    border-color: var(--accent);
  }

  input::placeholder {
    color: var(--muted);
  }

  .yaml {
    width: 100%;
    min-height: 260px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
    resize: vertical;
    tab-size: 2;
    white-space: pre;
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  /* Backend validation is shown verbatim so users see the real reasons. */
  .error-details {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  input:disabled,
  .yaml:disabled {
    opacity: 0.6;
  }
</style>