# Feature: serve-ui — `start` sirve la UI final, `dev` corre backend + Astro dev

**Objective:** que `bun start` levante el producto final (backend + UI compilada servida desde el server) para testearla, y que `bun run dev` corra el backend con watch + `astro dev` en paralelo, con proxy para que la UI de dev hable con el backend.

**Problem:** la UI actual es un shell estático (no consume el backend) y el server (`buildFetchHandler`) solo sirve `/api/*` y `/v1/*`; `/`, `/ui`, `/favicon.ico` responden 404. El usuario no puede ver el producto final en el navegador.

**Why:** pedido explícito del usuario ("quiero que el comando start me muestre el producto final… y que el dev corra el backend y el astro dev").

**Scope (autorizado):** solo estos archivos:
- `src/app/config.ts` + `src/app/types.ts` (campo `uiDir` opcional + env `WEAVELLM_UI_DIR`)
- `src/app/static-ui.ts` (NUEVO — helper puro de serving estático) + `src/app/static-ui.test.ts`
- `src/app/server.ts` (rama estática en el handler) + `src/app/server.test.ts` (tests nuevos)
- `frontend/astro.config.ts` + `frontend/astro.config.test.ts` (proxy de dev)
- `scripts/dev.ts` (NUEVO — spawn backend + astro dev, señales)
- `package.json` (scripts `start` y `dev`)
- `AGENTS.md` (sección Stack commands)

**Constraints:** Bun ≥ 1.4, ESM con `.js` explícitos, TS strict sin `any`, sin eslint disables inline, tests `bun:test` al lado del código, strict TDD activo (`strict_tdd: true`, runner `bun test` — fuente: sdd-init/llm-proxy, obs engram #29). Sin commits en este cambio. Comentarios/artefactos en inglés.

**Checklist (TDD estricto: RED → GREEN → REFACTOR por tarea):**

- [ ] **T1** `AppConfig.uiDir?: string` (opcional, sin `uiDir` = server API-only como hoy) + `resolveAppConfig` lo resuelve: `WEAVELLM_UI_DIR` env override, default `path.join(process.cwd(), "frontend", "dist")`. Tests: default, override.
- [ ] **T2** `src/app/static-ui.ts`: `serveStaticUi(uiDir, pathname): Promise<Response | null>` —
      `/`, `/ui`, `/ui/` → `index.html` (200, `text/html`);
      `/ui/<rel>` → `<uiDir>/<rel>` (alias de raíz);
      otro path relativo normal;
      asset que existe → `Bun.file(fullPath)` (MIME inferido);
      path sin extensión inexistente → SPA fallback a `index.html` (200);
      path con extensión inexistente → `null` (caller 404);
      traversal (`..`, null bytes, decode) → nunca escapa de `uiDir` → `null`/404.
      Tests con fixture en `mkdtempSync` (index.html + asset.js + subdir).
- [ ] **T3** `buildFetchHandler`: en el `else` final, si `config.uiDir` set y method GET/HEAD → `serveStaticUi(...) ?? notFound()`; log igual (method/path/status). Tests: raíz, `/ui`, asset, SPA fallback, 404 asset, traversal, `uiDir` ausente → 404.
- [ ] **T4** `frontend/astro.config.ts`: `vite.server.proxy` (solo dev) → `/api` → `http://127.0.0.1:4317`, `/v1` → 4317, `/ws` → `ws://127.0.0.1:4317` con `ws: true`. Test en astro.config.test.ts.
- [ ] **T5** `scripts/dev.ts` (NUEVO): `Bun.spawn` backend (`bun run --watch src/main.ts`) + frontend (`bun run dev:frontend`), ambos `stdio: inherit`, propagar SIGINT/SIGTERM a ambos, salir con el código del primero que muera. `package.json`: `dev` = `bun run scripts/dev.ts`; `start` = `bun run build:frontend && bun run src/main.ts`.
- [ ] **T6** `AGENTS.md`: actualizar Stack commands (`start` compila UI + corre server; `dev` corre backend + astro dev).

**Acceptance criteria:**
- `bun run build:frontend && bun run src/main.ts` → `http://127.0.0.1:4317/` sirve la UI (index.html + `_astro/` assets), `/ui` y `/ui/` sirven lo mismo, `/api/health` 200 intacto, `/v1/*` intacto, sin traversal posible.
- `bun run dev` levanta backend (watch) + astro dev (4321) en paralelo; la UI en dev puede llamar `/api`, `/v1`, `/ws` vía proxy; Ctrl+C mata ambos.
- `bun run typecheck && bun run lint && bun test` verdes.

**Resolved mode:** TDD ON — test runner `bun test` (fuente: sdd-init/llm-proxy). **Checks:** `bun run typecheck`, `bun run lint`, `bun test`.

**Progress/next step:** pendiente de delegación al writer.