<script lang="ts">
  /**
   * Runtime panel island (U12) — backend health, endpoints, auth gate,
   * websocket handshake and version, all against the REAL surface:
   *
   *   Health  — GET /api/health through the typed client, timestamped with
   *             real round-trip latency (performance.now around the call).
   *   Auth    — runtimeStatus() (runtime.ts): health + a 401 probe on the
   *             models branch ⇒ authEnabled. No new probing logic.
   *   WS probe — one-shot connection to ${getWsOrigin()}/ws: connect, wait
   *             for the handshake (or an error), then close. No bind/run,
   *             no auto-reconnect loop.
   *
   * Honest-data discipline: every card owns its loading/error/loaded state;
   * a failed probe renders its placeholder ("—" / Unavailable) with the
   * error verbatim, never invented telemetry. Version comes from the root
   * package.json at build time (page prop) — the browser cannot read server
   * env, so nothing else about the server config is claimed.
   */
  import { ApiError, getApiOrigin, getHealth, getWsOrigin, runtimeStatus } from "../../lib/api/index.js";
  import type { HealthStatus } from "../../lib/api/index.js";
  import {
    WS_PROBE_INITIAL,
    healthView,
    versionLine,
    wsProbeState,
  } from "../../lib/runtime-ui.js";
  import type { WsProbeState } from "../../lib/runtime-ui.js";
  import Button from "../common/Button.svelte";
  import StatusDot from "../common/StatusDot.svelte";
  import StatusCard from "../overview/StatusCard.svelte";

  /** How long the probe holds the open socket so "Connected" is visible. */
  const PROBE_HOLD_MS = 600;

  const apiOrigin = getApiOrigin();
  const wsOrigin = getWsOrigin();
  const probeUrl = `${wsOrigin}/ws`;

  interface HealthCell {
    status: "loading" | "loaded" | "error";
    health: HealthStatus | null;
    latencyMs: number | null;
    error: string | null;
  }

  interface AuthCell {
    status: "loading" | "loaded" | "error";
    authEnabled: boolean | null;
    error: string | null;
  }

  interface CardView {
    value: string;
    hint: string;
    tone: "ok" | "error" | "neutral";
    statusLabel: string;
  }

  let { name = "weavellm", version = "0.0.0" }: { name?: string; version?: string } =
    $props();

  let healthCell = $state<HealthCell>({
    status: "loading",
    health: null,
    latencyMs: null,
    error: null,
  });
  let authCell = $state<AuthCell>({
    status: "loading",
    authEnabled: null,
    error: null,
  });
  let ws = $state<WsProbeState>(WS_PROBE_INITIAL);
  /** Manual refresh counter — re-runs the fetch effect when bumped. */
  let attempt = $state(0);
  /** Manual WS probe counter — re-runs the probe effect when bumped. */
  let wsAttempt = $state(0);
  let loading = $state(false);

  /** Monotonic fetch id: a slower older refresh never overwrites newer data. */
  let requestSeq = 0;
  // Probe bookkeeping lives OUTSIDE $state on purpose: the probe effect must
  // not react to its own writes (a reactive socket reference would re-run it
  // in a loop), so these are plain locals.
  let socket: WebSocket | null = null;
  let closeTimer: number | null = null;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return "request failed";
  }

  /** Health call with real measured latency (marks the round-trip). */
  async function timedHealth(): Promise<{ health: HealthStatus; latencyMs: number }> {
    const started = performance.now();
    const health = await getHealth();
    return { health, latencyMs: performance.now() - started };
  }

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    healthCell = { ...healthCell, status: "loading" };
    authCell = { ...authCell, status: "loading" };

    // allSettled: a failing probe degrades its own card, never the panel.
    const [healthResult, authResult] = await Promise.allSettled([
      timedHealth(),
      runtimeStatus(),
    ]);

    if (seq !== requestSeq) return; // superseded by a newer refresh

    if (healthResult.status === "fulfilled") {
      healthCell = {
        status: "loaded",
        health: healthResult.value.health,
        latencyMs: healthResult.value.latencyMs,
        error: null,
      };
    } else {
      healthCell = { status: "error", health: null, latencyMs: null, error: errorText(healthResult.reason) };
    }

    // runtimeStatus never throws; unreachable surfaces as reachable:false.
    if (authResult.status === "fulfilled" && authResult.value.reachable) {
      authCell = { status: "loaded", authEnabled: authResult.value.authEnabled, error: null };
    } else {
      authCell = { status: "error", authEnabled: null, error: "backend unreachable" };
    }
    loading = false;
  }

  // Initial load + manual refresh/retry (an attempt bump re-runs this effect).
  $effect(() => {
    void attempt;
    void load();
  });

  // ── WebSocket probe ────────────────────────────────────────────────────────

  /** Open one probe socket, wait for the handshake (or an error), then close. */
  function startProbe(): void {
    if (socket !== null) return; // one probe at a time
    ws = wsProbeState(WS_PROBE_INITIAL, { type: "start" });
    const s = new WebSocket(probeUrl);
    socket = s;

    s.onopen = () => {
      ws = wsProbeState(ws, { type: "open" });
      closeTimer = window.setTimeout(() => {
        s.close();
      }, PROBE_HOLD_MS);
    };
    s.onerror = () => {
      ws = wsProbeState(ws, { type: "error", error: "websocket error" });
    };
    s.onclose = () => {
      ws = wsProbeState(ws, { type: "close" });
      if (socket === s) socket = null;
    };
  }

  // Mount probe + manual retry (a wsAttempt bump re-runs this effect). The
  // cleanup tears the previous probe down before a retry starts a new one.
  $effect(() => {
    void wsAttempt;
    startProbe();
    return () => {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (socket !== null) {
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    };
  });

  function refresh(): void {
    attempt += 1;
  }

  function retryProbe(): void {
    wsAttempt += 1;
  }

  // ── View mapping (per card, independent) ───────────────────────────────────

  const healthCard: CardView = $derived.by(() => {
    if (healthCell.status === "loading" && healthCell.health === null) {
      return { value: "…", hint: "Loading…", tone: "neutral", statusLabel: "" };
    }
    if (healthCell.status === "error") {
      return { value: "—", hint: "Unavailable", tone: "error", statusLabel: "Unavailable" };
    }
    const view = healthView(healthCell.health, healthCell.latencyMs);
    const parts: string[] = [];
    if (view.latency !== "—") parts.push(view.latency);
    if (view.localModels !== "—") parts.push(view.localModels);
    return {
      value: view.statusText,
      hint: parts.length > 0 ? parts.join(" · ") : "backend answered",
      tone: view.tone,
      statusLabel: view.statusText,
    };
  });

  const authCard: CardView = $derived.by(() => {
    if (authCell.status === "loading" && authCell.authEnabled === null) {
      return { value: "…", hint: "Probing the auth gate…", tone: "neutral", statusLabel: "" };
    }
    if (authCell.status === "error") {
      return {
        value: "—",
        hint: authCell.error ?? "backend unreachable",
        tone: "error",
        statusLabel: "Unavailable",
      };
    }
    return authCell.authEnabled === true
      ? {
          value: "Enabled",
          hint: "owned server-side (WEAVELLM_AUTH)",
          tone: "ok",
          statusLabel: "Enabled",
        }
      : {
          value: "Disabled",
          hint: "owned server-side (WEAVELLM_AUTH off)",
          tone: "neutral",
          statusLabel: "Disabled",
        };
  });

  const versionView = $derived(versionLine({ name, version }));

  // ── WebSocket card presentation ────────────────────────────────────────────

  interface WsCardView {
    value: string;
    hint: string;
    dotTone: "ok" | "warn" | "error" | "idle";
    dotLabel: string;
    announce: string;
  }

  const wsCard: WsCardView = $derived.by(() => {
    switch (ws.phase) {
      case "idle":
        return {
          value: "—",
          hint: probeUrl,
          dotTone: "idle",
          dotLabel: "Not probed",
          announce: "WebSocket probe not started.",
        };
      case "connecting":
        return {
          value: "Connecting…",
          hint: probeUrl,
          dotTone: "warn",
          dotLabel: "Connecting",
          announce: "WebSocket probe: connecting.",
        };
      case "connected":
        return {
          value: "Connected",
          hint: probeUrl,
          dotTone: "ok",
          dotLabel: "Connected",
          announce: "WebSocket probe: connected.",
        };
      case "closed":
        return ws.everConnected
          ? {
              value: "Probe ok",
              hint: `${probeUrl} — handshake accepted, probe closed.`,
              dotTone: "ok",
              dotLabel: "Probe ok",
              announce: "WebSocket probe: closed after a successful handshake.",
            }
          : {
              value: "No connection",
              hint: `${probeUrl} — closed before any handshake.`,
              dotTone: "error",
              dotLabel: "Closed",
              announce: "WebSocket probe: closed without a handshake.",
            };
      case "error":
        return {
          value: "Error",
          hint: probeUrl,
          dotTone: "error",
          dotLabel: "Error",
          announce: "WebSocket probe failed.",
        };
    }
  });

  const probeBusy = $derived(ws.phase === "connecting");
</script>

<div class="runtime-panel" data-testid="runtime-panel">
  <div class="panel-toolbar">
    <p class="scope-note">
      Status from GET /api/health, the auth probe and a WS /ws handshake probe —
      values the browser cannot observe come from the backend.
    </p>
    <Button
      variant="secondary"
      ariaLabel="Refresh runtime status"
      disabled={loading}
      onclick={refresh}
    >
      Refresh
    </Button>
  </div>

  <div class="cards">
    <StatusCard
      label="Health"
      value={healthCard.value}
      hint={healthCard.hint}
      tone={healthCard.tone}
      statusLabel={healthCard.statusLabel}
    >
      {#if healthCell.status === "error"}
        <p class="card-error" role="alert">{healthCell.error}</p>
        <Button variant="secondary" ariaLabel="Retry the health probe" onclick={refresh}>
          Retry
        </Button>
      {/if}
    </StatusCard>

    <StatusCard
      label="Authentication"
      value={authCard.value}
      hint={authCard.hint}
      tone={authCard.tone}
      statusLabel={authCard.statusLabel}
    >
      {#if authCell.status === "error"}
        <p class="card-error" role="alert">{authCell.error}</p>
        <Button variant="secondary" ariaLabel="Retry the auth probe" onclick={refresh}>
          Retry
        </Button>
      {/if}
    </StatusCard>

    <article class="info-card">
      <header class="card-head">
        <h2 class="card-label">Server address</h2>
      </header>
      <div class="addr-block">
        <p class="addr-key">API origin</p>
        <code class="addr-value">{apiOrigin}</code>
      </div>
      <div class="addr-block">
        <p class="addr-key">WebSocket origin</p>
        <code class="addr-value">{wsOrigin}</code>
      </div>
      <p class="card-hint">
        The endpoints this console talks to (client config). In dev, the Astro
        proxy forwards them to the local backend.
      </p>
    </article>

    <article class="info-card ws-card">
      <header class="card-head">
        <h2 class="card-label">WebSocket</h2>
        <StatusDot tone={wsCard.dotTone} label={wsCard.dotLabel} />
      </header>
      <p class="ws-value">{wsCard.value}</p>
      <p class="probe-live" aria-live="polite">{wsCard.announce}</p>
      {#if ws.phase === "error"}
        <p class="card-error" role="alert">{ws.error}</p>
      {/if}
      <div class="ws-actions">
        <Button
          variant="secondary"
          ariaLabel="Retry the websocket probe"
          disabled={probeBusy}
          onclick={retryProbe}
        >
          Retry
        </Button>
      </div>
      <p class="card-hint">{wsCard.hint}</p>
    </article>

    <StatusCard
      label="Version"
      value={versionView}
      hint="bundle: static Astro · from package.json at build time"
    />
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

  /* Plain cards share the StatusCard recipe (16px radius, subtle border). */
  .info-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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

  .addr-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .addr-key {
    margin: 0;
    color: var(--muted);
    font-size: 0.75rem;
  }

  .addr-value {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font-size: 0.8125rem;
    line-height: 1.4;
    word-break: break-all;
  }

  /* WS card: the probe state is the headline, announced live on changes. */
  .ws-value {
    margin: 0;
    min-height: 2.05rem;
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .probe-live {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .ws-actions {
    display: flex;
    margin-top: auto;
    padding-top: var(--space-1);
  }
</style>