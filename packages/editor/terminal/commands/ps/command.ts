import type { CommandDefinition } from "../../catalog";

export default {
	"name": "ps",
	"summary": "What's running — programs, dev servers, tasks — with the id `kill` takes; -a includes what's ended.",
	"usage": "ps [-a]"
} satisfies CommandDefinition;
