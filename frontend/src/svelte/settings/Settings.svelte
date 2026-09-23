<script lang="ts">
  /**
   * Settings island (U13) — read-only console settings against the REAL
   * surface. There is no settings API on the backend, so this island never
   * mutates anything and renders no forms:
   *
   *   Authentication — runtimeStatus() (runtime.ts): health + a 401 probe
   *                    on the models branch ⇒ authEnabled. No new probing
   *                    logic; the result maps onto an honest card view.
   *   Server env     — static rows with the "Coming from backend"
   *                    placeholder: host/port/app-data/store live in server
   *                    env (WEAVELLM_*) that the public API never exposes,
   *                    so the browser cannot observe them and nothing here
   *                    guesses a value.
   *
   * Honest-data discipline: the Authentication card owns its own
   * loading/error/loaded states (a failed probe renders the error verbatim
   * with Retry); Refresh re-runs the probe; the env card is static because
   * there is nothing to probe for it.
   */
  import { runtimeStatus } from "../../lib/api/index.js";
  import {
    SERVER_ENV_NOTE,
    SERVER_ENV_ROWS,
    authProbe,
    authView,
  } from "../../lib/settings-ui.js";
  import type { AuthCardView, AuthProbeState } from "../../lib/settings-ui.js";
  import Button from "../common/Button.svelte";
  import StatusCard from "../overview/StatusCard.svelte";

  let probe = $state<AuthProbeState>({ status: "loading" });
  /** Manual refresh counter — an attempt bump re-runs the probe effect. */
  let attempt = $state(0);
  let loading = $state(false);
  /** Monotonic probe id: a slower older refresh never overwrites newer data. */
  let probeSeq = 0;

  async function loadProbe(): Promise<void> {
    const seq = ++probeSeq;
    loading = true;
    probe = { status: "loading" };
    // runtimeStatus never throws — unreachable surfaces as reachable:false.
    const result = await runtimeStatus();
    if (seq !== probeSeq) return; // superseded by a newer refresh
    probe = authProbe(result);
    loading = false;
  }

  // Initial probe + manual refresh (an attempt bump re-runs this effect).
  $effect(() => {
    void attempt;
    void loadProbe();
  });

  function refresh(): void {
    attempt += 1;
  }

  const authCard: AuthCardView = $derived(authView(probe));
</script>

<div class="settings-panel" data-testid="settings-panel">
  <div class="panel-toolbar">
    <p class="scope-note">
      Read-only settings. No settings API exists on the backend: the auth
      gate is probed live, and server-owned configuration is marked honestly.
    </p>
    <Button
      variant="secondary"
      ariaLabel="Refresh settings"
      disabled={loading}
      onclick={refresh}
    >
      Refresh
    </Button>
  </div>

  <div class="cards">
    <StatusCard
      label="Authentication"
      value={authCard.value}
      hint={authCard.hint}
      tone={authCard.tone}
      statusLabel={authCard.statusLabel}
    >
      {#if probe.status === "error"}
        <p class="card-error" role="alert">{probe.error}</p>
        <Button variant="secondary" ariaLabel="Retry the auth probe" onclick={refresh}>
          Retry
        </Button>
      {/if}
    </StatusCard>

    <article class="info-card">
      <header class="card-head">
        <h2 class="card-label">Server environment</h2>
      </header>
      <div class="env-rows">
        {#each SERVER_ENV_ROWS as row (row.label)}
          <div class="env-row">
            <p class="env-label">{row.label}</p>
            <code class="env-value">{row.value}</code>
          </div>
        {/each}
      </div>
      <p class="card-hint">{SERVER_ENV_NOTE}</p>
    </article>
  </div>
</div>

<style>
  .panel-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .scope-note {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-4);
    align-items: stretch;
  }

  /* Plain card shares the StatusCard recipe (16px radius, subtle border). */
  .info-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .card-label {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--secondary);
  }

  .card-hint {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--secondary);
    word-break: break-word;
  }

  .card-error {
    margin: 0;
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
    word-break: break-word;
  }

  .env-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .env-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .env-label {
    margin: 0;
    color: var(--muted);
    font-size: 0.75rem;
  }

  .env-value {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
</style>