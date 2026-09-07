<script lang="ts">
  /**
   * App shell + composition root (svelte-ui task 3.3).
   *
   * Creates the store layer (editor, dashboard, trace) and the SSE service
   * through injected factories — the browser wires real REST/EventSource,
   * tests wire the fakes from test-setup/fakes.ts. Owns the a11y shell that
   * the Phase-2 placeholder carried statically in index.html: skip link,
   * banner, Spanish nav with the five hash routes, and the live
   * connection-status region fed by the SSE service.
   *
   * SSE events are funneled into batched refreshes (spec §SSE): execution
   * and step events refresh executions, pipeline:reloaded refreshes
   * pipelines, models:changed refreshes models — each collapsed by the
   * dashboard store's throttle window into a single fetch per domain.
   */
  import { onMount, onDestroy } from "svelte";
  import type { AppDeps, ViewId } from "./app-types.js";
  import { NAV_VIEWS } from "./app-types.js";
  import { createEditorStore } from "./stores/editor-store.js";
  import { createDashboardStore } from "./stores/dashboard-store.js";
  import { createTraceService } from "./services/trace-service.js";
  import { createSseService } from "./services/sse-service.js";
  import { createRestService } from "./services/rest-service.js";
  import { SSE_STATE, type SSEState, type TraceEntry } from "./stores/types.js";
  import type { SseService } from "./services/sse-service.js";
  import { applySseEvent } from "./lib/sse-effects.js";
  import { formatTraceTime, formatTraceDetail } from "./lib/trace-format.js";
  import Editor from "./views/Editor.svelte";
  import Pipelines from "./views/Pipelines.svelte";
  import Modelos from "./views/Modelos.svelte";
  import Ejecuciones from "./views/Ejecuciones.svelte";
  import Agentes from "./views/Agentes.svelte";

  export const NAV_ITEMS = [
    { view: "editor", label: "Editor", href: "#editor" },
    { view: "pipelines", label: "Pipelines", href: "#pipelines" },
    { view: "models", label: "Modelos", href: "#models" },
    { view: "executions", label: "Ejecuciones", href: "#executions" },
    { view: "agents", label: "Agentes", href: "#agents" },
  ] as const;

  /** Browser wiring: real REST api + real EventSource + trace. */
  function defaultDeps(): AppDeps {
    const rest = createRestService();
    return {
      makeStores: () => ({
        editor: createEditorStore({ api: rest }),
        dashboard: createDashboardStore({ api: rest }),
        trace: createTraceService(),
      }),
      makeSse: (stores) =>
        createSseService({
          onEvent: (type, data) => {
            // Shared funnel: log + route each domain to its throttled refresh
            // (spec §SSE); step:failed also feeds the dashboard retry data.
            applySseEvent({ type, data }, stores);
          },
        }),
    };
  }

  let { deps = defaultDeps() }: { deps?: AppDeps } = $props();

  const stores = deps.makeStores();
  const sse: SseService = deps.makeSse(stores);

  function viewFromHash(): ViewId {
    const hash = window.location.hash.replace(/^#/, "");
    return (NAV_VIEWS as readonly string[]).includes(hash) ? (hash as ViewId) : "editor";
  }

  let active = $state<ViewId>(viewFromHash());
  let connState = $state<SSEState>(SSE_STATE.CONNECTING);

  let unsubSse: (() => void) | null = null;
  let unsubTrace: (() => void) | null = null;

  // Trace panel: entries mirrored from the trace service (cap-500 ring),
  // default open; verbose reveals the detail payloads.
  let traceOpen = $state(true);
  let traceVerbose = $state(false);
  let traceEntries = $state<TraceEntry[]>([]);

  onMount(() => {
    stores.trace.log("store", "boot");
    unsubSse = sse.subscribe((state) => {
      connState = state;
    });
    unsubTrace = stores.trace.subscribe((entries) => {
      traceEntries = entries;
    });
    sse.start();
    void stores.dashboard.actions.refreshAll();
    const onHash = (): void => {
      active = viewFromHash();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      unsubTrace?.();
    };
  });

  onDestroy(() => {
    sse.stop();
    unsubSse?.();
    unsubTrace?.();
  });
</script>

<a class="skip-link" href="#main">Saltar al contenido principal</a>

<header class="app-header" role="banner">
  <h1 class="app-title">llm-proxy</h1>
  <nav class="app-nav" aria-label="Principal">
    {#each NAV_ITEMS as item (item.view)}
      <a
        class="nav-link"
        data-view={item.view}
        href={item.href}
        aria-current={active === item.view ? "true" : undefined}
      >
        {item.label}
      </a>
    {/each}
  </nav>
  <div id="conn-status" class="conn-status" role="status" aria-live="polite" data-state={connState}>
    {connState === SSE_STATE.CONNECTED ? "En línea" : connState === SSE_STATE.CONNECTING ? "Conectando…" : "Desconectado"}
  </div>
</header>

<main id="main" class="app-main">
  <Editor hidden={active !== "editor"} store={stores.editor} />
  <Pipelines hidden={active !== "pipelines"} store={stores.dashboard} editor={stores.editor} />
  <Modelos hidden={active !== "models"} store={stores.dashboard} />
  <Ejecuciones hidden={active !== "executions"} store={stores.dashboard} />
  <Agentes hidden={active !== "agents"} store={stores.dashboard} />
</main>

<footer id="trace-panel" class="trace-panel" data-testid="trace-panel" aria-label="Registro de eventos">
  <div class="trace-header">
    <h2 class="trace-title">Registro de eventos</h2>
    <button
      id="trace-toggle"
      type="button"
      class="btn btn-ghost"
      aria-expanded={traceOpen ? "true" : "false"}
      data-testid="trace-toggle"
      onclick={() => (traceOpen = !traceOpen)}
    >
      {traceOpen ? "Ocultar registro" : "Mostrar registro"}
    </button>
    <label class="trace-verbose">
      <input type="checkbox" bind:checked={traceVerbose} data-testid="trace-verbose" />
      <span>Detalles</span>
    </label>
  </div>
  {#if traceOpen}
    <ul id="trace-list" class="trace-list" data-testid="trace-list">
      {#each traceEntries as entry, i (entry.ts + ":" + i)}
        <li class="trace-entry" data-kind={entry.kind} data-testid="trace-entry">
          <time class="trace-time secondary">{formatTraceTime(entry.ts)}</time>
          <span class="trace-kind">{entry.kind}</span>
          <span class="trace-message">{entry.message}</span>
          {#if traceVerbose && entry.detail !== undefined}
            <pre class="trace-detail" data-testid="trace-detail">{formatTraceDetail(entry.detail)}</pre>
          {/if}
        </li>
      {/each}
      {#if traceEntries.length === 0}
        <li class="hint">Sin eventos todavía.</li>
      {/if}
    </ul>
  {/if}
</footer>