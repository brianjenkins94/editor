import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npm",
	"summary": "Run package.json scripts (run, start, test); install adds a dependency to package.json.",
	"streaming": true // a script may run `node` or `vite`
} satisfies CommandDefinition;
