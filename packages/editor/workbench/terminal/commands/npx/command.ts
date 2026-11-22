import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npx",
	"summary": "Run a command this shell has (npm exec).",
	"streaming": true,
	"stopEarly": true,
	"options": { "args": { "format": Array, "default": [], "positional": "rest", "doc": "What it was given, passed on." } }
} satisfies CommandDefinition;
