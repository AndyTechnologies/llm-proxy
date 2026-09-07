# Quest: svelte-ui

## Approval: approved

## RFC

### Goals / Non-goals

**Goals**
- Re-platform the static `/ui` SPA (plain HTML/CSS/JS) to **Svelte** (user-confirmed stack), compiled to static assets served by the embedded Bun backend, as a pure client-side-rendered (CSR) single-page application.
- **Behavioral parity** with the current UI (5 views: Editor, Pipelines, Modelos, Ejecuciones, Agentes; visual graph editor with drag & drop, zoom, keyboard, port-to-port connections, dialogs, validate/apply) **plus** the user-selected improvements: graph editor (undo/redo, connection handling), executions/metrics, models/backend panel, visible trace logging, and a debug/verbose mode.
- Release binary is **self-contained**: static assets embedded (Bun.embed/`--compile`); development serves the compiled build from disk.
- Maintain the current visual identity (dark theme, tokens) — refinements only, no redesign.
- Keep the existing dashboard API contract (REST `/api/ui/*` + SSE `/api/ui/events`) unchanged.

**Non-goals**
- No SSR, no prerendering.
- No changes to the dashboard API contract. The ONLY backend surface change permitted is extending static serving for compiled assets (subdirectories) plus an SPA fallback to `index.html` for client-side routes — delivery infrastructure for the compiled output, not a behavior change.
- No i18n: UI copy stays in Rioplatense Spanish (voseo), as today.
- No visual redesign; no new runtime dependencies beyond Svelte (testing tooling is devDependencies only).
- No backend feature changes: debug/verbose and trace logging are presentation-layer only (the backend already exposes sufficient data).
- No cloud/external platforms; app remains local.

### Domain Terminology & Business Rules

- Existing domain rules from `dashboard-ui` / `dashboard-api` / `graph-engine` specs remain authoritative (pipeline graph, node types, validation invariants, SSE event names, apply semantics).
- **Parity rule**: every user-facing interaction present today must remain present; improvements are additive on top of parity, never a regression of an existing interaction.
- **Presentation-layer debug rule**: debug/verbose shows more detail of data already present in REST/SSE payloads; it must not require backend changes or invent data the backend does not send.
- The graph editor is the highest-risk surface; its interaction set (drag from palette, numeric-key add, zoom, pan, select, delete, connect ports, dialogs, validate, apply, flow animation) is a parity checklist.
- Trace logging exposes a clear, debuggable trail of client events (SSE receipt, store transitions, fetch errors, editor actions) in the UI.

### Contracts (Inputs / Outputs / Events / External)

**Frontend consumes (unchanged contract)**:
- REST `/api/ui/*`: pipelines list, models list (+ lifecycle TTL/VRAM controls), executions list, validate, apply, step retry, agents config.
- SSE `/api/ui/events`: `execution:started`, `step:started`, `step:completed`, `step:failed`, `execution:completed`, `pipeline:reloaded`, `models:changed`.

**Output / delivery**:
- Compiled SPA output (index.html + assets) served under `/ui` with correct content types; static serving MAY be extended to allow asset subdirectories (hashed chunks) and MUST fall back to `index.html` for unknown `/ui/*` paths (client-side route reloads).
- Development: the compiled build is served from disk by the Bun backend (no separate frontend server required in the normal flow).
- Release: the binary embeds the compiled assets; it must work from any working directory, self-contained.
- Bundle size: total app JS ≤ 100 KB gzip (measured on the production build).
- View navigation: hash-based SPA without an external router.

### Invariants & Validation

- ARIA + keyboard navigation + WCAG AA contrast maintained (existing SPA requirement).
- `graph-model` logic migrates to framework-free TypeScript, keeping its test suite and behavior.
- High-frequency metrics must not block the main thread (throttle/batch SSE-driven updates; coordinate drawing via `requestAnimationFrame`).
- Canvas/SVG handling: drawing logic isolated and testable, `devicePixelRatio` aware, cleanup on unmount (ResizeObserver, animation frames, listeners).
- Unchanged invariants from existing specs (atomic apply, atomic registry reload, validation rules, no code evaluation).

### Failure Cases & Edge Cases

- SSE disconnect/reconnect: UI handles connection states (connecting/connected/disconnected/error) with the same resilience as today.
- Reload on a client-side view (e.g. `#editor`) must serve the SPA fallback, not a 404.
- Missing/partial REST responses: bounded error surfaces, no crash, retry-able.
- Undo/redo across editor mutations: bounded history, no memory blow-up on long sessions.
- Bundler limits: if the chosen toolchain lacks source maps (bun-plugin-svelte), debug experience degrades — trace logging compensates; no silent build misbehavior.

### Security / Privacy / Performance / Operational

- No new attack surface: same auth (BEARER_TOKEN) for `/api/ui/*` + SSE; Svelte compiles templates (no eval); rendering stays client-side with the same trust boundary as today.
- Performance: ≤ 100 KB gzip JS; fluent editor interactions; no main-thread jank under SSE load.
- Operational: reproducible build with clear scripts (`install`, `dev`, `build:ui`, `preview`, integration with the Bun server); single compilable server output stays.

### Alternatives & Trade-offs

- **Svelte (confirmed)** vs SolidJS/Preact — user chose Svelte after research (bundle size, Bun integration, CSR fit).
- **Toolchain** — `bun-plugin-svelte` (single Bun toolchain, plugin 0.0.x maturity, no component sourcemaps) vs `SvelteKit + adapter-static` (mature, Vite-based dev, output uses asset subdirectories requiring the static-serving extension). Resolved in explore/design with the collected evidence.
- **Editor rendering** — declarative Svelte SVG vs isolated imperative renderer for canvas/SVG hot paths. Resolved in design; imperative drawing isolated and testable per the research guidance.
- **Parity + improvements (accepted)** vs strict parity-only — user accepted additive improvements scoped to editor, executions/metrics, models/backend panel, trace logging, debug mode.
- **Self-contained binary (accepted)** vs disk-served assets — user accepted embedding for release robustness.

### Acceptance Criteria (measurable)

1. `/ui` serves a working Svelte SPA from the Bun backend in production build.
2. Behavioral parity checklist passes for all 5 views and the full editor interaction set (drag, numeric keys, zoom, pan, select, delete, connect, dialogs, validate, apply, flow).
3. Approved improvements implemented: editor undo/redo + connection handling; executions/metrics detail; models/backend panel; visible trace logging; debug/verbose mode (presentation only).
4. Release binary is self-contained (embedded static assets) and works from any cwd; dev serves the compiled build from disk.
5. Total app JS ≤ 100 KB gzip on the production build (measured, recorded in verify).
6. Contract unchanged: REST + SSE endpoints and payloads identical (only static serving extended).
7. Repo suite green: `bun test` (incl. migrated TS logic + component tests), `tsc --noEmit`, `eslint`, updated Playwright e2e.
8. ARIA/keyboard/WCAG AA behavior maintained; UI copy remains Rioplatense Spanish.
9. Reproducible build scripts documented; modular structure (components/stores/services/canvas/svg/utils) allowing future growth.
10. No runtime dependencies beyond Svelte; testing tooling devDependencies only.

### Unresolved Questions (blocking)

- None. Exact toolchain (SvelteKit + adapter-static vs Svelte + bun-plugin-svelte) and editor rendering strategy are design-phase decisions to be resolved with the collected evidence (explore/design), not blocking the approvals.