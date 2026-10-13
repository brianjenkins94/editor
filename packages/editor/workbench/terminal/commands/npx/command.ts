import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npx",
	"summary": "Run a command this shell has (npx vite); a package's own binary can't run here, and it says so.",
	"streaming": true, // it may run one that streams
	"stopEarly": true,
	"options": {
		"yes": { "format": Boolean, "default": false, "short": "y", "doc": "Accepted: nothing is installed to ask about." },
		"command": { "format": Array, "default": [], "positional": "rest", "doc": "The command, then its arguments." }
	}
} satisfies CommandDefinition;
