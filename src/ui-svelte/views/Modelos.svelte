<script lang="ts">
  /**
   * Modelos view — model registry + lifecycle backend panel (tasks 3.3/3.6,
   * verify scenario 10).
   *
   * The panel edits a local draft seeded from the loaded config, validates
   * client-side, and applies the MERGED config through the dashboard store
   * (api.applyConfig), which reloads config + models so the view reflects
   * the saved values. VRAM modes/labels mirror the legacy /ui select;
   * freeGb/capGb visibility follows the legacy toggling by mode.
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";
  import type { ModelEntry } from "../stores/types.js";
  import {
    VRAM_MODES,
    VRAM_MODE_LABELS,
    toLifecycleDraft,
    mergeLifecycleConfig,
    validateLifecycleDraft,
    lifecycleDraftEquals,
    isVramMode,
    type LifecycleDraft,
  } from "../lib/lifecycle-form.js";

  let { store, hidden = false }: { store: DashboardStore; hidden?: boolean } = $props();

  /** Draft of the visible panel fields; re-seeded whenever the loaded config
   * changes and the user has not touched the form (apply reloads included). */
  let draft = $state<LifecycleDraft>(toLifecycleDraft($store.config));
  let touched = $state(false);
  let formError = $state<string | null>(null);

  $effect(() => {
    if (!touched) draft = toLifecycleDraft($store.config);
  });

  const isDirty = $derived(!lifecycleDraftEquals(draft, toLifecycleDraft($store.config)));
  const showFreeGb = $derived(draft.vramMode === "dynamic" || draft.vramMode === "margin");

  function setDraft(patch: Partial<LifecycleDraft>): void {
    touched = true;
    formError = null;
    draft = { ...draft, ...patch };
  }

  function handleTtl(event: Event): void {
    setDraft({ ttl: Number((event.currentTarget as HTMLInputElement).value) });
  }

  function handleMode(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isVramMode(value)) setDraft({ vramMode: value });
  }

  function handleFreeGb(event: Event): void {
    setDraft({ freeGb: Number((event.currentTarget as HTMLInputElement).value) });
  }

  function handleCapGb(event: Event): void {
    setDraft({ capGb: Number((event.currentTarget as HTMLInputElement).value) });
  }

  async function save(): Promise<void> {
    const error = validateLifecycleDraft(draft);
    formError = error;
    if (error) return;
    const merged = mergeLifecycleConfig($store.config ?? {}, draft);
    await store.actions.applyConfig(merged);
    touched = false;
  }

  function unloadAll(): void {
    void store.actions.unloadAllModels();
  }

  function statusLabel(model: ModelEntry): string {
    if (model.processLoaded && model.loaded) return "banner activo";
    if (model.loaded) return "cargado";
    return "descargado";
  }

  function statusTone(model: ModelEntry): string {
    return model.processLoaded || model.loaded ? "active" : "inactive";
  }
</script>

<section id="models" class="view" aria-label="Modelos" data-testid="view-models" hidden={hidden || undefined}>
  <h2 class="panel-title">Modelos</h2>

  <div id="backend-panel" class="lc-panel" aria-label="Ajustes del backend" data-testid="backend-panel">
    <div class="lc-grid">
      <label class="lc-label" for="lc-ttl">TTL (min)</label>
      <input
        id="lc-ttl"
        class="text-input"
        type="number"
        min="0"
        step="1"
        value={draft.ttl}
        oninput={handleTtl}
        data-testid="lc-ttl"
      />
      <label class="lc-label" for="lc-vram-mode">Modo VRAM</label>
      <select
        id="lc-vram-mode"
        class="text-input"
        value={draft.vramMode}
        onchange={handleMode}
        data-testid="lc-vram-mode"
      >
        {#each VRAM_MODES as mode (mode)}
          <option value={mode}>{VRAM_MODE_LABELS[mode]}</option>
        {/each}
      </select>
      <label class="lc-label" for="lc-freegb" hidden={!showFreeGb || undefined}>VRAM libre (GiB)</label>
      <input
        id="lc-freegb"
        class="text-input"
        type="number"
        min="0"
        step="0.5"
        value={draft.freeGb}
        oninput={handleFreeGb}
        hidden={!showFreeGb || undefined}
        data-testid="lc-freegb"
      />
      <label class="lc-label" for="lc-capgb" hidden={showFreeGb || undefined}>VRAM cap (GiB)</label>
      <input
        id="lc-capgb"
        class="text-input"
        type="number"
        min="0"
        step="0.5"
        value={draft.capGb}
        oninput={handleCapGb}
        hidden={showFreeGb || undefined}
        data-testid="lc-capgb"
      />
      <label class="lc-label" for="lc-status">Estado</label>
      <span id="lc-status" class="secondary" data-testid="lc-status">
        {#if $store.lifecycle?.vramPolicyActive}
          VRAM activo · {$store.lifecycle.lastVramSample
            ? `${$store.lifecycle.lastVramSample.usedMiB} MiB / ${$store.lifecycle.lastVramSample.totalMiB} MiB`
            : "sin muestra"}
        {:else}
          Sin datos de VRAM
        {/if}
      </span>
    </div>
    {#if formError}
      <p class="validation-error" data-testid="lc-form-error">{formError}</p>
    {/if}
    {#if $store.applyError}
      <p class="validation-error" data-testid="lc-apply-error">{$store.applyError}</p>
    {/if}
    {#if $store.unloadAllError}
      <p class="validation-error" data-testid="lc-unload-error">{$store.unloadAllError}</p>
    {/if}
    <div class="lc-actions">
      <button
        id="lc-save"
        class="btn btn-primary"
        disabled={!isDirty || $store.applying}
        onclick={save}
        data-testid="lc-save"
      >
        {#if $store.applying}Guardando…{:else}Guardar ajustes{/if}
      </button>
      <button
        id="lc-unload-all"
        class="btn btn-danger"
        disabled={$store.unloadingAll}
        onclick={unloadAll}
        data-testid="lc-unload-all"
      >
        {#if $store.unloadingAll}Descargando…{:else}Descargar todos{/if}
      </button>
    </div>
  </div>

  {#if $store.modelsDir}
    <p class="hint" id="models-dir">Modelos en {$store.modelsDir}</p>
  {/if}

  {#if $store.models.length === 0}
    <p class="hint">No hay modelos registrados.</p>
  {:else}
    <div id="models-list" class="list" role="list" data-testid="models-list">
      {#each $store.models as model (model.id)}
        <div class="list-item" role="listitem" data-model-id={model.id}>
          <span class="primary">{model.id}</span>
          <span class="status status--{statusTone(model)}">{statusLabel(model)}</span>
          {#if model.ctx}
            <span class="secondary">ctx {model.ctx}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>