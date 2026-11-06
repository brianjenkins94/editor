import type { CommandDefinition } from "../../catalog";

export default {
	"name": "less",
	"summary": "Show files or what's piped in, whole: a terminal here scrolls, and there's no pager.",
	"options": { "files": { "format": Array, "default": [], "positional": "rest", "doc": "The files." } }
} satisfies CommandDefinition;
