/**
 * Bun test preload: Svelte 5 compiler plugin (svelte-ui task 3.7 infra).
 *
 * `bun test` cannot parse `.svelte` files natively (it treats the import as
 * plain text), so this Bun.plugin compiles them through `svelte/compiler`:
 * - `.svelte` components        → `compile(source, { generate: "client" })`
 * - `.svelte.js` / `.svelte.ts` → `compileModule(...)` (runes modules)
 *
 * It also redirects the root `svelte` package to the CLIENT build
 * (`index-client.js`): bun test is not a browser, so the default exports
 * condition resolves to `index-server.js`, whose `mount()` throws "not
 * available on the server". Only the one entry file is overridden; internal
 * imports (`svelte/internal/client`, …) resolve unchanged.
 *
 * Loaded via `[test] preload` in bunfig.toml — applies to every `bun test`
 * run, but the hooks only fire for imports that match (backend suites never
 * import `.svelte`/`svelte`), so they are no-ops there.
 */
import { compile, compileModule } from "svelte/compiler";
import { dirname, join } from "node:path";

Bun.plugin({
  name: "svelte-loader",
  setup(builder) {
    builder.onLoad(
      { filter: /node_modules[\\/]svelte[\\/]src[\\/]index-server\.js$/ },
      async ({ path }) => {
        // Root "svelte" import → client build (see header comment).
        const clientEntry = join(dirname(path), "index-client.js");
        return { contents: `export * from ${JSON.stringify(clientEntry)};`, loader: "js" };
      },
    );

    // One filter for every svelte-suffixed path. bun's onLoad filter engine
    // silently drops anchored alternatives like `/\.svelte(\.(js|ts))?$/`
    // and `/\.svelte\.js$/` (observed with .svelte.js files), so match the
    // common `.svelte` prefix and branch in the handler.
    const isRunesModule = (path: string): boolean => /\.svelte\.(js|ts)$/.test(path);
    const compileSource = async (
      path: string,
    ): Promise<{ contents: string; loader: "js" }> => {
      const source = await Bun.file(path).text();
      const options = { generate: "client" as const, runes: true, filename: path };
      const js = isRunesModule(path) ? compileModule(source, options).js : compile(source, options).js;
      return { contents: js.code, loader: "js" };
    };

    builder.onLoad({ filter: /\.svelte/ }, ({ path }) => compileSource(path));
  },
});