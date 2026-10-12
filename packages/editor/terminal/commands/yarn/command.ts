import type { CommandDefinition } from "../../catalog";

export default {
	"name": "yarn",
	"summary": "This shell's npm, as yarn says it: yarn (install), yarn add, yarn dev (a script by name), yarn dlx.",
	"streaming": true,
	"stopEarly": true,
	"options": {
		"version": { "format": Boolean, "default": false, "short": "v", "doc": "Which npm it is." },
		"words": { "format": Array, "default": [], "positional": "rest", "doc": "What to do: install, add, remove, ls, run, dlx — or a script's name." }
	}
} satisfies CommandDefinition;
