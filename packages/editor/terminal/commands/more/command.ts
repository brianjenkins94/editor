import type { CommandDefinition } from "../../catalog";

export default {
	"name": "more",
	"summary": "Print files (or what's piped in) — the terminal scrolls, so there's nothing to page.",
	"usage": "more [file…]"
} satisfies CommandDefinition;
