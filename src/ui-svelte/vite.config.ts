import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

/**
 * Build-only Vite config for the Svelte 5 CSR UI.
 *
 * The UI is an inert static bundle: no dev server, no SSR. `vite build`
 * emits the compiled output at `<repo>/dist/ui` (hashed `assets/*` chunks +
 * `index.html`), which the Bun backend serves under `/ui` (task 2.3: the
 * `uiDir` default resolves `./dist/ui` from the repo root). The `outDir` is
 * resolved absolutely from this config file's own location so the result
 * lands at the repo-root `dist/ui` regardless of how Vite resolves `root`.
 */
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL("../../dist/ui", import.meta.url)),
    emptyOutDir: true,
    // Everything is a client bundle — code-split chunks are fine for the
    // hashed `assets/*` subdirectory contract.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
