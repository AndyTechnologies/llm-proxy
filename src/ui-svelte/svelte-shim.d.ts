/**
 * Root-tsc shim for Svelte 5 components (svelte-ui, task 3.3).
 *
 * `bun run typecheck` runs the ROOT tsconfig (lib ES2022, includes
 * src/**\/*.ts) — and from task 3.3 on, component tests under
 * src/ui-svelte import `.svelte` files. Without this declaration tsc would
 * fail with "Cannot find module './App.svelte'". The runtime compilation is
 * handled by the Bun.plugin preload (test-setup/svelte-loader.ts); this shim
 * only satisfies the typecheck gate.
 */
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component;
  export default component;
}