<script lang="ts">
  /**
   * Agentes view (svelte-ui task 3.3 + 3.6).
   *
   * Agent status rows (OpenCode, Pi) from the dashboard store; each row has a
   * "Configurar" button that syncs the agent's provider with the gateway
   * (store action -> POST /api/ui/agents/configure) with pending / success /
   * inline-error feedback.
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";

  let { store, hidden = false }: { store: DashboardStore; hidden?: boolean } = $props();
</script>

<section id="agents" class="view" aria-label="Agentes" data-testid="view-agents" hidden={hidden || undefined}>
  <h2 class="panel-title">Agentes</h2>
  {#if $store.agents.length === 0}
    <p class="hint">
      Configurá tus agentes de código (OpenCode, Pi) para que aparezcan aquí. Cada pipeline puede declarar el agente
      que lo ejecuta.
    </p>
  {:else}
    <div id="agents-list" class="list" role="list" data-testid="agents-list">
      {#each $store.agents as agent (agent.id)}
        <div class="list-item" role="listitem" data-agent-id={agent.id}>
          <span class="primary">{agent.label}</span>
          <span class="secondary">{agent.id}</span>
          {#if agent.providerPresent}
            <span class="status status--active">proveedor presente</span>
          {/if}
          <span class="secondary">{agent.modelCount ?? 0} modelos</span>
          <button
            type="button"
            class="btn btn-small agent-configure"
            data-testid="agent-configure"
            data-agent-id={agent.id}
            disabled={$store.configuring[agent.id] === true}
            onclick={() => store.actions.configureAgent(agent.id)}
          >
            {#if $store.configuring[agent.id]}
              configurando…
            {:else}
              Configurar
            {/if}
          </button>
          {#if $store.configureErrors[agent.id]}
            <span class="agent-configure-error" data-testid="agent-configure-error" data-agent-id={agent.id}>
              {$store.configureErrors[agent.id]}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>