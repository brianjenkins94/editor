import type { CommandDefinition } from "../../catalog";

export default {
	"name": "history",
	"summary": "The command lines typed at this terminal, numbered.",
	"usage": "history [n]"
} satisfies CommandDefinition;
