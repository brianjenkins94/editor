import type { CommandDefinition } from "../../catalog";

export default {
	"name": "ps",
	"summary": "What's running — programs, dev servers, tasks — with the id kill takes.",
	"options": {
		"all": { "format": Boolean, "default": false, "short": "a", "doc": "What's ended too." }
	}
} satisfies CommandDefinition;
