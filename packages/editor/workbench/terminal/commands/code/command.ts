import type { CommandDefinition } from "../../catalog";

export default {
	"name": "code",
	"summary": "Open files in the editor, as VS Code's code does: one that isn't there yet opens to be written, a folder shows in the Explorer.",
	"options": {
		"goto": { "format": Boolean, "default": false, "short": "g", "doc": "Each is file:line[:column]." },
		"paths": { "format": Array, "default": [], "positional": "rest", "doc": "The files." }
	}
} satisfies CommandDefinition;
