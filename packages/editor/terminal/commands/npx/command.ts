import type { CommandDefinition } from "../../catalog";

export default {
	"name": "npx",
	"summary": "Run a command this shell has (npx vite); a package's own binary can't run here, and it says so.",
	"usage": "npx <command> [args…]",
	"streaming": true // it may run one that streams
} satisfies CommandDefinition;
