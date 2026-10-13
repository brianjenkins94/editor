import type { CommandDefinition } from "../../catalog";

export default {
	"name": "bun",
	"summary": "Not here.",
	// eslint-disable-next-line webawesome/no-html-in-strings -- "<script>" is the usage placeholder for a script's name, not markup
	"missing": "isn't here — run JavaScript and TypeScript with `node <file>`, and scripts with `npm run <script>`."
} satisfies CommandDefinition;
