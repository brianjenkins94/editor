import type { CommandDefinition } from "../../catalog";

export default {
	"name": "vite",
	"summary": "Serve the project from an in-browser dev server until stopped (Ctrl-C).",
	"streaming": true,
	"options": {
		"port": { "format": String, "default": "", "doc": "Accepted: each server takes the next free port from 5173." },
		"host": { "format": Boolean, "default": false, "doc": "Accepted: it's served in this browser." },
		"open": { "format": Boolean, "default": false, "doc": "Accepted: nothing opens yet." }
	}
} satisfies CommandDefinition;
