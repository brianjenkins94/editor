import type { CommandDefinition } from "../../catalog";

export default {
	"name": "kill",
	"summary": "Stop a run by its id from `ps` (any unique beginning of it).",
	"usage": "kill <id>…"
} satisfies CommandDefinition;
