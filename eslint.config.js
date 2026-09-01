// eslint.config.js
import { defineConfig } from "eslint/config";

export default defineConfig([
	// matches all files ending with .js
	{
		files: ["**/*.js"],
		rules: {
			semi: "error",
			"no-unused-vars": "error",
		},
		linterOptions: {
			noInlineConfig: true,
			reportUnusedDisableDirectives: "error",
		},
	},
]);
