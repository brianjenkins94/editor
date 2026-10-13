import type { CommandDefinition } from "../../catalog";

export default {
	"name": "node",
	"summary": "Run a program in the debugger, its output and input here.",
	"streaming": true,
	// Node's options come before the file; the file and everything after it are the program's.
	"stopEarly": true,
	"options": {
		"eval": { "format": String, "default": "", "short": "e", "doc": "Run this code." },
		"print": { "format": String, "default": "", "short": "p", "doc": "Run this code and print its value." },
		"version": { "format": Boolean, "default": false, "short": "v", "doc": "The runtime's version." },
		"test": { "format": Boolean, "default": false, "doc": "Not here yet: this runtime has no node:test." },
		"inspect": { "format": Boolean, "default": false, "doc": "Accepted: every run is in the debugger." },
		"inspectBrk": { "format": Boolean, "default": false, "doc": "Accepted: set a breakpoint to stop at." },
		"enableSourceMaps": { "format": Boolean, "default": false, "doc": "Accepted." },
		"program": { "format": Array, "default": [], "positional": "rest", "doc": "The file, then its arguments." }
	}
} satisfies CommandDefinition;
