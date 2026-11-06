import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npx",
	"summary": "Run a command this shell has (npm exec).",
	"streaming": true, // what it runs may run node or vite
	"stopEarly": true,
	"options": { "args": { "format": Array, "default": [], "positional": "rest", "doc": "What it was given, passed on." } }
} satisfies CommandDefinition;
