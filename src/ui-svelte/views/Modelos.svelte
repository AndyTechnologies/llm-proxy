<script lang="ts">
  /**
   * Modelos view — model registry + lifecycle backend panel (task 3.3).
   *
   * The panel fields render the loaded config and VRAM state; saving the
   * lifecycle settings and the unload actions wire up in task 3.6.
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";
  import type { ModelEntry } from "../stores/types.js";

  let { store, hidden = false }: { store: DashboardStore; hidden?: boolean } = $props();

  const VRAM_MODES = ["auto", "off", "free", "cap"];

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
        value={$store.config?.llama?.lifecycle?.ttl ?? ""}
        disabled
        data-testid="lc-ttl"
      />
      <label class="lc-label" for="lc-vram-mode">Modo VRAM</label>
      <select id="lc-vram-mode" class="text-input" disabled data-testid="lc-vram-mode">
        {#each VRAM_MODES as mode (mode)}
          <option value={mode} selected={$store.config?.llama?.lifecycle?.vram?.mode === mode}>{mode}</option>
        {/each}
      </select>
      <label class="lc-label" for="lc-freegb">VRAM libre (GiB)</label>
      <input
        id="lc-freegb"
        class="text-input"
        type="number"
        min="0"
        step="0.5"
        value={$store.config?.llama?.lifecycle?.vram?.freeGb ?? ""}
        disabled
        data-testid="lc-freegb"
      />
      <label class="lc-label" for="lc-capgb">VRAM cap (GiB)</label>
      <input
        id="lc-capgb"
        class="text-input"
        type="number"
        min="0"
        step="0.5"
        value={$store.config?.llama?.lifecycle?.vram?.capGb ?? ""}
        disabled
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
    <div class="lc-actions">
      <button id="lc-save" class="btn btn-primary" disabled data-testid="lc-save">Guardar ajustes</button>
      <button id="lc-unload-all" class="btn btn-danger" disabled data-testid="lc-unload-all">Descargar todos</button>
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