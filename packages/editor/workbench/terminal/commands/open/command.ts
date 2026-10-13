import type { CommandDefinition } from "../../catalog";

export default {
	"name": "open",
	"summary": "Open files in the editor, a folder in the Explorer, or a URL in the browser.",
	"options": {
		"targets": { "format": Array, "default": [], "positional": "rest", "doc": "Files (file:line[:column]), folders and URLs." }
	}
} satisfies CommandDefinition;
