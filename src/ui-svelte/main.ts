/**
 * Svelte 5 UI entry — build placeholder (Unit 1, svelte-ui).
 *
 * Phase 2 (`svelte-ui`) wires the toolchain end-to-end: `bun run build:ui`
 * must produce a real, servable bundle under `dist/ui` with hashed
 * `assets/*` chunks so the static-serving work is verifiable. This module
 * gives the build a minimal entry now; the full app shell (App.svelte and
 * the five views) lands in Phase 3 and mounts here in place of the styles
 * import. Nothing in this file is runtime behavior — it exists so the
 * pipeline is real.
 */
import "./styles.css";