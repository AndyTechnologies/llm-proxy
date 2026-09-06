<script lang="ts">
  /**
   * Editor view — shell for task 3.3 (palette, canvas, toolbar, dialogs).
   *
   * Interactions (drag, numeric keys, connect, zoom, keyboard pan/select)
   * build on top of this in task 3.4; history/undo-redo in 3.5. Palette
   * clicks already funnel through the editor store's addNode.
   */
  import type { EditorStore } from "../stores/editor-store.js";
  import type { NodeType } from "../lib/graph-model.js";

  const PALETTE = [
    { type: "start", label: "Inicio", key: "1" },
    { type: "llm_call", label: "Llamada LLM", key: "2" },
    { type: "condition", label: "Condición", key: "3" },
    { type: "loop", label: "Bucle", key: "4" },
    { type: "pipeline", label: "Pipeline", key: "5" },
    { type: "end", label: "Fin", key: "6" },
  ] as const satisfies ReadonlyArray<{ type: NodeType; label: string; key: string }>;

  let { store, hidden = false }: { store: EditorStore; hidden?: boolean } = $props();

  let validateDialog = $state<HTMLDialogElement | null>(null);
  let applyDialog = $state<HTMLDialogElement | null>(null);

  async function runValidate(): Promise<void> {
    await store.actions.validate();
    validateDialog?.showModal();
  }

  function openApply(): void {
    applyDialog?.showModal();
  }

  function closeApply(): void {
    applyDialog?.close();
  }

  async function confirmApply(): Promise<void> {
    await store.actions.apply();
    applyDialog?.close();
  }
</script>

<section id="editor" class="view" aria-label="Editor de pipelines" data-testid="view-editor" hidden={hidden || undefined}>
  <div class="editor-layout">
    <aside id="palette" class="palette" aria-label="Paleta de nodos">
      <h2 class="panel-title">Paleta de nodos</h2>
      <p class="hint" id="palette-hint">
        Arrastrá un nodo al lienzo o presioná su tecla numérica con el lienzo enfocado.
      </p>
      <div class="palette-section">
        <h3 class="palette-section-title">Bloques base</h3>
        <ul id="palette-list" class="palette-list" data-testid="palette-list">
          {#each PALETTE as item (item.type)}
            <li>
              <button
                type="button"
                class="palette-item"
                data-node-type={item.type}
                data-key={item.key}
                draggable="true"
                data-testid="palette-item"
                onclick={() => store.actions.addNode(item.type)}
              >
                {item.label}
                <span class="shortcut">{item.key}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </aside>
    <div id="graph-canvas" class="graph-canvas" tabindex="0" aria-label="Lienzo del grafo" data-testid="graph-canvas"></div>
  </div>

  <div class="toolbar" role="toolbar" aria-label="Acciones del editor">
    <button id="btn-undo" class="btn" disabled title="Deshacer (Ctrl+Z)" data-testid="btn-undo">Deshacer</button>
    <button id="btn-redo" class="btn" disabled title="Rehacer (Ctrl+Y)" data-testid="btn-redo">Rehacer</button>
    <button id="btn-validate" class="btn btn-primary" onclick={runValidate} data-testid="btn-validate">Validar</button>
    <button id="btn-apply" class="btn btn-primary" onclick={openApply} data-testid="btn-apply">Aplicar</button>
  </div>

  <dialog id="validate-dialog" class="dialog" bind:this={validateDialog} data-testid="validate-dialog">
    <div class="dialog-content">
      <h2 class="panel-title dialog-title">Validación</h2>
      {#if $store.validation}
        {#if $store.validation.valid}
          <p class="validation-result" data-state="valid">El pipeline es válido.</p>
        {:else}
          <ul class="validation-errors">
            {#each $store.validation.errors ?? [] as error (error)}
              <li class="validation-result" data-state="invalid" data-testid="validation-error">
                {error}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="hint">Validando…</p>
      {/if}
      <div class="dialog-actions">
        <button class="btn" onclick={() => validateDialog?.close()} data-testid="btn-close-validate">Cerrar</button>
      </div>
    </div>
  </dialog>

  <dialog id="apply-dialog" class="dialog" bind:this={applyDialog} data-testid="apply-dialog">
    <div class="dialog-content">
      <h2 class="panel-title dialog-title">Aplicar cambios</h2>
      <p>¿Aplicar el pipeline actual a la configuración del servidor?</p>
      {#if $store.applyError}
        <p class="validation-error" data-testid="apply-error">{$store.applyError}</p>
      {/if}
      <div class="dialog-actions">
        <button class="btn" onclick={closeApply}>Cancelar</button>
        <button id="btn-confirm-apply" class="btn btn-primary" onclick={confirmApply} data-testid="btn-confirm-apply">
          Aplicar cambios
        </button>
      </div>
    </div>
  </dialog>
</section>