import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";

/**
 * WeaveLLM renderer shell — Astro 7 native static output.
 * adapter-static is removed in Astro 7; `output: "static"` is the built-in
 * path. The SPA hydrates Svelte 5 islands (workflow editor, catalog, models).
 */
export default defineConfig({
  output: "static",
  integrations: [svelte()],
  vite: {
    resolve: {
      // Shared pure workflow modules live in the repo's src/ tree.
      alias: {
        "@core": new URL("../src/", import.meta.url).pathname,
      },
    },
    server: {
      // Dev-only: Astro dev talks to the local backend through these routes.
      proxy: {
        "/api": "http://127.0.0.1:4317",
        "/v1": "http://127.0.0.1:4317",
        "/ws": { target: "ws://127.0.0.1:4317", ws: true },
      },
    },
  },
});