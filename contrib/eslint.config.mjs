import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	// (markdown too: its code blocks have no tsconfig for the typed rules)
	{ "ignores": ["dist/**", "**/*.md"] }
];
