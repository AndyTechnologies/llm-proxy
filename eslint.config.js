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