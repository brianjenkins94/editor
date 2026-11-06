import type { CommandDefinition } from "../../catalog";

export default {
	"name": "history",
	"summary": "The lines this terminal's run, numbered; a number shows that many of the latest.",
	"options": {
		"clear": { "format": Boolean, "default": false, "short": "c", "doc": "Forget them." },
		"count": { "format": String, "default": "", "positional": true, "doc": "How many of the latest." }
	}
} satisfies CommandDefinition;
