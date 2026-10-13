import type { CommandDefinition } from "../../catalog";

export default {
	"name": "make",
	"summary": "Not here.",
	// eslint-disable-next-line webawesome/no-html-in-strings -- "<script>" is the usage placeholder for a script's name, not markup
	"missing": "isn't here — put the steps in package.json's scripts and run them with `npm run <script>`."
} satisfies CommandDefinition;
