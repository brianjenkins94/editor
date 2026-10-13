import type { CommandDefinition } from "../../catalog";

export default {
	"name": "vite",
	"summary": "Serve the project in a preview window until stopped (Ctrl-C).",
	"streaming": true,
	"options": {
		"port": { "format": String, "default": "", "doc": "Accepted: each preview takes the next free port from 5173." },
		"host": { "format": Boolean, "default": false, "doc": "Accepted: the preview is in this window." },
		"open": { "format": Boolean, "default": false, "doc": "Accepted: the preview opens anyway." }
	}
} satisfies CommandDefinition;
