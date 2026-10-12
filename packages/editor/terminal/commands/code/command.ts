import type { CommandDefinition } from "../../catalog";

export default {
	"name": "code",
	"summary": "Open files in the editor (at a line with file:line[:column]), or show a folder in the Explorer.",
	"options": {
		"goto": { "format": Boolean, "default": false, "short": "g", "doc": "Accepted: file:line[:column] opens at the line anyway." },
		"reuseWindow": { "format": Boolean, "default": false, "short": "r", "doc": "Accepted: there's one window." },
		"newWindow": { "format": Boolean, "default": false, "short": "n", "doc": "Accepted: there's one window." },
		"targets": { "format": Array, "default": [], "positional": "rest", "doc": "Files (file:line[:column]) and folders." }
	}
} satisfies CommandDefinition;
