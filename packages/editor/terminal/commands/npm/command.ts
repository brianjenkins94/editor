import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npm",
	// eslint-disable-next-line webawesome/no-html-in-strings -- "<script>" is the usage placeholder for a script's name, not markup
	"usage": "npm install [package…] | npm run <script> [args…] | npm start | npm test",
	"summary": "Run package.json scripts (run, start, test); install adds a dependency to package.json.",
	"streaming": true // a script may run `node` or `vite`
} satisfies CommandDefinition;
