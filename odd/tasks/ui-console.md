# Feature: ui-console — Consola de administración WeaveLLM (spec v2, PHASE 1–14)

**Objective:** transformar el frontend actual (única página `index.astro` + ModelBadge/WorkflowEditor) en la consola completa de administración según la spec revisada v2 (~secciones 0–303, entregada 2026-09-20): Overview, Workflows (+editor visual), Models (registry/catalog/downloads), Providers, Executions, API Playground, Runtime, Settings, About.

**Problem:** la spec de diseño anterior estaba basada en una versión VIEJA de WeaveLLM e inventaba endpoints (`/api/ui/*`, `/api/pipelines/*`, `/api/executions/*`) que no existen. El usuario pidió roll-back explícito ("eliminar el worktree y empezar de nuevo") y la spec v2. **Regla central (§2): la UI representa la superficie backend REAL; está prohibido inventar endpoints, telemetría o datos.**

**Why:** pedido explícito del usuario + desbloqueo del trabajo pendiente de la consola sobre el runtime real (el backend ya expone /api, /v1, /ws; falta la UI).

**Roll-back ejecutado (2026-09-20):** rama `feat/dashboard-api-surface` eliminada (sin commits propios); descartados `src/orchestrator/graph.ts`/`graph.test.ts` (mods), `src/app/events.ts`/`events.test.ts`, `odd/tasks/dashboard-api-surface.md`; issue #43 cerrada como `not planned` (superseded por spec v2). Working tree limpio sobre `master` → rama nueva `feat/ui-console`. `docs/` preexistente NO se tocó.

**Scope (autorizado):** `frontend/` completo (Astro 7 static + Svelte 5 islands + @xyflow/svelte), `frontend/astro.config.ts` (mantener proxy `/api,/v1,/ws` → 127.0.0.1:4317, solo dev), alias `@core` → `../src/` para reusar tipos de dominio. **No** tocar `src/` backend (contratos reales) ni agregar dependencias nuevas. Copia de UI: inglés consistente, tono técnico/concise, sin mezclar idiomas (§281).

**Constraints:**
- Superficie backend real (fuente de verdad): `GET /api/health`; `GET /api/models`, `GET /api/models/:id`, `POST .../activate`, `POST .../deactivate`; `GET/PUT/DELETE /api/workflows...`, `POST /api/workflows/:name/run`, `GET /api/workflows/:name/logs`; `WS /ws`; `GET /v1/models`, `POST /v1/chat/completions|completions|embeddings`. Gaps → "Coming from backend"/"Unavailable"; nunca simular.
- **Tokens Gentle-AI exactos** (sustituyen `#F095C8`): bg `#09090b`; card `#111113`; code `#18181c`; border `#ffffff12`, hover `#ea188959`; texto `#fafafa`; secondary `#a1a1aa`; muted `#52525b`; accent `#ea1889`, hover `#ff6db0`, subtle `#ea188926`. Radii controles 8px / cards 16px (nunca 5/11/13/22). Spacing 4/8/12/16/20/24/32/40/48. Inter + ui-monospace; máx 3 pesos por vista.
- Stack: Astro 7 static + Svelte 5 moderno ($state/$derived/$effect/$props) + @xyflow/svelte. NO React/SvelteKit/Bootstrap/MUI/Chakra/Ant. Iconos SVG inline. Sin i18n, sin `any`, sin eslint disables inline, sin `fetch()` arbitrario en componentes (API client tipado), tests `bun:test` al lado del código. Editor: Single Graph Model (Visual|YAML), guardar = serializeWorkflowGraph → PUT YAML canónico, validateGraph() backend = autoridad. Ejecución = WS /ws (nunca reinterpretar como SSE); executions = logs de workflow.
- Convenciones repo: Bun ≥ 1.4, ESM `.js` explícitos, Conventional Commits, ramas `^(feat|fix|...)\/[a-z0-9._-]+$`.

**Checklist (PHASE 1–14 de la spec §302; verificación por fase):**

- [x] **U01 (PHASE 1)** Design tokens + App shell + Navegación + Routing. `styles/tokens.css` + refactor `global.css` (quitar #F095C8) + `layouts/AppLayout.astro` (Sidebar/Topbar/Main/StatusBar) + `svelte/navigation/*` (Sidebar, Topbar, StatusBar, CommandPalette Ctrl/Cmd+K) + rutas placeholder (Overview), `/workflows[/name]`, `/models[/id|catalog|downloads]`, `/providers[/kind]`, `/executions`, `/api`, `/runtime`, `/settings`, `/about`; `lib/api/config.ts` mínimo (`getApiOrigin`/`getWsOrigin`); mount temporal de WorkflowEditor existente en `/workflows/[name]` (sin romper su funcionalidad; index deja de hardcodear qwen2.5-coder-3b-instruct/Q4_K_M/32768). ✅ commit `16b0871` — gate verde (typecheck ✓, lint ✓, 462 tests ✓, build:frontend ✓ 12 páginas). Extras: `lib/navigation.ts` (registro de nav + isRouteActive), `lib/ui-state.ts`, `lib/api/config.test.ts`, helpers `svelte/common/*` (Button/Icon/IconButton/StatusDot/EmptyState). Fixes post-agente: imports relativos en `executions/index.astro`, path de `package.json` raíz en `AppLayout.astro` y `about.astro`.
- [ ] **U02 (PHASE 2)** API layer tipado + básicos: clientes `health`, `models`, `workflows`, `providers`; `ApiError {status,code,message,details}`; estado runtime (auth WEAVELLM_AUTH, versión); no credenciales al frontend.
- [ ] **U03 (PHASE 3)** Overview (capabilities, modelos activos, workflows recientes, estado runtime, quick actions; métricas reales, placeholders "—" sin inventar).
- [ ] **U04 (PHASE 4)** Workflow library (lista CRUD + controles run/logs desde `/api/workflows`).
- [ ] **U05 (PHASE 5)** Workflow editor foundation: FlowEditor + 14 custom nodes + WorkflowEdge + NodePalette/paneles base sobre @xyflow/svelte; taxonomía única `frontend/src/lib/workflow-nodes.ts` + `src/orchestrator/graph.ts`.
- [ ] **U06 (PHASE 6)** Workflow semantics: inspector (config por tipo), AST lógico, Loop/Fan/Join, validateGraph() integrado, serialización YAML canónico (PUT /api/workflows/:name).
- [ ] **U07 (PHASE 7)** Workflow execution: run HTTP + live WS /ws (bind/run; eventos status|step_started|step_completed|token|error) en RunPanel; executions desde logs (no API global).
- [ ] **U08 (PHASE 8)** Models: registry (active|disabled|error reales), catálogo curated/hf/local, downloads con SHA-256 Verified/Failed; sin telemetría inventada (GPU/VRAM/tokens-sec).
- [ ] **U09 (PHASE 9)** Providers (openai/anthropic/openrouter; keys nunca al frontend; fallback visible).
- [ ] **U10 (PHASE 10)** Executions (por workflow, lecturas de logs).
- [ ] **U11 (PHASE 11)** API Playground (POST /v1/* con auth capturada del entorno del server, no credenciales).
- [ ] **U12 (PHASE 12)** Runtime (health/puerto/versión, estado auth, ws indicator).
- [ ] **U13 (PHASE 13)** Settings + About.
- [ ] **U14 (PHASE 14)** a11y (WCAG AA, focus, reduced motion), responsive (240/64/drawer), performance (lazy islands), tests de UI restantes, hardening.

**Acceptance criteria (por fase):** `bun run typecheck && bun run lint && bun test && bun run build:frontend` verdes; UI dev habla con backend real vía proxy; ningún endpoint ficticio; copia en inglés consistente; tokens aplicados sin excepciones #F095C8.

**Delivery strategy:** `ask-on-risk` (default) — forecast >> 400 líneas → antes del primer PR se pregunta estrategia de cadena (stacked-to-main | feature-branch-chain) y se registra aquí. Work-unit commits por fase/tarea en `feat/ui-console`; push/PR = decisión del usuario.

**Resolved mode:** TDD no configurado explícito en proyecto; checks por tarea: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build:frontend`.

**Progress/next step:** U01 completado. Siguiente: U02 (API layer tipado, estado runtime/auth) → U03 Overview.