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
  import { SSE_STATE, type SSEState } from "./stores/types.js";
  import type { SseService } from "./services/sse-service.js";
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
          onEvent: (type) => {
            stores.trace.log("sse", type);
            if (type === "pipeline:reloaded") stores.dashboard.actions.scheduleRefresh("pipelines");
            else if (type === "models:changed") stores.dashboard.actions.scheduleRefresh("models");
            else stores.dashboard.actions.scheduleRefresh("executions");
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

  onMount(() => {
    stores.trace.log("store", "boot");
    unsubSse = sse.subscribe((state) => {
      connState = state;
    });
    sse.start();
    void stores.dashboard.actions.refreshAll();
    const onHash = (): void => {
      active = viewFromHash();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  });

  onDestroy(() => {
    sse.stop();
    unsubSse?.();
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