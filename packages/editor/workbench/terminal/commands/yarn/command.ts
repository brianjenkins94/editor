import type { CommandDefinition } from "../../catalog";

export default {
	"name": "yarn",
	"summary": "npm, in yarn's words: alone it installs; add, remove, a script by its name.",
	"streaming": true,
	"stopEarly": true,
	"options": { "args": { "format": Array, "default": [], "positional": "rest", "doc": "What it was given, passed on." } }
} satisfies CommandDefinition;
