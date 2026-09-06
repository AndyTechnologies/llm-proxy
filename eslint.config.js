// eslint.config.js
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const sharedLinterOptions = {
  noInlineConfig: true,
  reportUnusedDisableDirectives: "error",
};

export default defineConfig([
	// matches all files ending with .js
	{
		files: ["**/*.js"],
		rules: {
			semi: "error",
			"no-unused-vars": "error",
		},
		linterOptions: sharedLinterOptions,
	},
	// TypeScript files: TS-aware parser/plugin so the lint gate can actually
	// run on the TS codebase (previously the gate failed to parse every .ts).
	// The `_`-prefix convention (signature-parity params) is honored via
	// argsIgnorePattern; inline disable directives stay banned (noInlineConfig).
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: {
			semi: "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
		linterOptions: sharedLinterOptions,
	},
	// MINOR-A framework-freedom invariant (svelte-ui design): the pure TS
	// layer under src/ui-svelte/lib/ must never import the framework — it is
	// unit-testable with `bun test` and swappable across renderers. Any
	// `svelte`/`@sveltejs` import in lib/ fails the lint gate.
	{
		files: ["src/ui-svelte/lib/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["svelte", "svelte/*", "@sveltejs/*"],
							message:
								"lib/ is framework-free (MINOR-A): graph-model and pure helpers must not import svelte or @sveltejs modules.",
						},
					],
				},
			],
		},
		linterOptions: sharedLinterOptions,
	},
	// Generated build output is not linted (dist/ is gitignored).
	{
		ignores: [
			"dist/**",
			"test-results/**",
			"playwright-report/**",
			"blob-report/**",
			"playwright/.cache/**",
		],
	},
]);