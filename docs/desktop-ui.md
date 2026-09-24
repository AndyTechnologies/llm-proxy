# Desktop UI & frontend

The user interface is a **compiled Astro static site** (Svelte 5 islands,
`@xyflow/svelte` for the workflow editor) served by the proxy **from the same
origin** as the API — no separate dev server in production, no CORS.

Related: [architecture.md](./architecture.md) (static UI + request flow),
[api.md](./api.md) (serving rules and `/ws`).

## Serving model

`serveStaticUi` (`src/app/static-ui.ts`) is wired into the fetch handler:

- **GET/HEAD only.** Assets, `/`, `/ui`, `/ui/`, and extensionless SPA paths
  resolve to `index.html`.
- Existing assets are served with content type inferred by Bun; malformed
  paths (bad encoding, null bytes, `..`) resolve to `null` → 404.
- **`/v1`, `/api`, `/ws` are reserved namespaces** — they always reach their
  handlers, never static files.
- The compiled build comes from `frontend/dist` (astro build) or
  `WEAVELLM_UI_DIR` when set — the desktop path uses a bundled `ui/`.

## Page map

| Route | Page |
| --- | --- |
| `/` | Overview |
| `/models` | Model management (list / activate / deactivate) |
| `/models/catalog` | GGUF catalog |
| `/models/downloads` | Model downloads |
| `/models/[id]` | Model detail + configuration |
| `/playground` | Playground (chat with any model) |
| `/api` | Legacy playground alias |
| `/workflows` | Workflow list + editor entry |
| `/workflows/[name]` | Visual workflow editor |
| `/executions` | Execution history |
| `/providers` | External provider list |
| `/providers/[kind]` | Provider detail (base URL, fallback, key) |
| `/runtime` | Local runtime state |
| `/settings` | Settings (auth key, embedding model, UI dir) |
| `/about` | About |

## Client architecture

- **Astro 7 static output** + **Svelte 5 islands**; the workflow editor is
  `@xyflow/svelte`; YAML parsing via `yaml`.
- `frontend/src/lib/` holds the typed client layer used by the islands:
  - `api/` — typed fetch clients (`http.ts`, `v1.ts`, `models.ts`,
    `workflows.ts`, `health.ts`, `runtime.ts`, `config.ts`, `types.ts`)
  - `ws.ts` — WebSocket client for live workflow runs (`bind`/`run`)
  - `sse.ts` — SSE parsing for streaming chat
  - `run-transcript.ts` — transcript assembly from relayed events
  - `workflow-*.ts` — validation, flow layout, node definitions
  - `*-ui.ts` — per-page state helpers
- The dev proxy (`astro.config.ts`) also maps `@core` to the shared
  `../src/` backend sources.

## Development

```bash
bun run dev            # backend (bun --watch src/main.ts) + astro dev in
                       # parallel, shared terminal; Ctrl+C kills both
bun run dev:frontend   # astro dev --root frontend only
bun run build:frontend # astro build --root frontend
```

In dev, Astro proxies to the running backend:

| Frontend path | Proxy target |
| --- | --- |
| `/api`, `/v1` | `http://127.0.0.1:4317` |
| `/ws` | `ws://127.0.0.1:4317` |

Routing up front avoids stale registrations going to static files; every
request to the app in dev reaches the backend exactly like production.

## Desktop shell

`bun run start` builds the frontend, then launches the desktop bundle:

- `scripts/start-desktop.ts` invokes the **real Hutch CLI** at
  `~/.hutch/bin/hutch` (it is not on PATH; `bunx hutch` resolves the wrong
  npm package) with `electrobun build` + `electrobun run --env=dev`.
- The deployed binary is an **Electrobun bundle** (webview window + Bun main
  process); `build.mainProcess: "bun"` and `src/main.ts` is the entrypoint —
  when running inside the bundle, `import("electrobun/main")` opens the
  `BrowserWindow` pointing at `http://127.0.0.1:<port>/`.
- Schnell builds are **host-only** (no cross-compile); `--env=dev` produces a
  runnable bundle with diagnostics. Flip to `--env=stable` once verified on a
  signed host.
- On Linux/Xwayland + NVIDIA, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set by
  default for the webview (GBM buffer failure renders a black window); an
  explicit env override still wins.
- `bun run build:binary` / `bun run build:binaries` produce the distributable
  bundles via `scripts/build-binary.ts` / `scripts/build-binaries.ts`.

## Verification

```bash
bun run typecheck:frontend  # astro check --root frontend
bun test frontend/src/lib   # 24 colocated tests
bun run build:frontend      # reproducible static build
```