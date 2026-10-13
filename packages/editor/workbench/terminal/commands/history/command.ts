import type { CommandDefinition } from "../../catalog";

export default {
	"name": "history",
	"summary": "The command lines typed at this terminal, numbered.",
	"options": {
		"count": { "format": String, "default": "", "positional": true, "doc": "Only the last this many." }
	}
} satisfies CommandDefinition;
