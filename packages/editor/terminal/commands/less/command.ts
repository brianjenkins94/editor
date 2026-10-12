import type { CommandDefinition } from "../../catalog";

export default {
	"name": "less",
	"summary": "Print files (or what's piped in) — the terminal scrolls, so there's nothing to page.",
	"usage": "less [file…]"
} satisfies CommandDefinition;
