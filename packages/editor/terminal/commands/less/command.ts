import type { CommandDefinition } from "../../catalog";

export default {
	"name": "less",
	"summary": "Print files (or what's piped in) — the terminal scrolls, so there's nothing to page.",
	"options": {
		"raw": { "format": Boolean, "default": false, "short": "R", "doc": "Accepted: colors pass through anyway." },
		"files": { "format": Array, "default": [], "positional": "rest", "doc": "The files (none: what's piped in)." }
	}
} satisfies CommandDefinition;
