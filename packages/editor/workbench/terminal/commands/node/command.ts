import type { CommandDefinition } from "../../catalog";

export default {
	"name": "node",
	"summary": "Run a program in the debugger, its output and input here.",
	"streaming": true,
	"stopEarly": true,
	"options": {
		"eval": { "format": String, "default": "", "short": "e", "doc": "Run this code." },
		"print": { "format": String, "default": "", "short": "p", "doc": "Run this code and print its value." },
		"version": { "format": Boolean, "default": false, "short": "v", "doc": "The runtime's version." },
		"test": { "format": Boolean, "default": false, "doc": "Run test files (node:test), one after another in the debugger: those given (a glob too, as node's), else the ones under this directory." },
		"import": { "format": Array, "default": [], "doc": "Load this module before the program, as node's --import does (a loader's module.registerHooks, say); again for another." },
		"testForceExit": { "format": Boolean, "default": false, "doc": "Accepted: a test file's run ends when its tests do." },
		"inspect": { "format": Boolean, "default": false, "doc": "Accepted: every run is in the debugger." },
		"inspectBrk": { "format": Boolean, "default": false, "doc": "Accepted: set a breakpoint to stop at." },
		"enableSourceMaps": { "format": Boolean, "default": false, "doc": "Accepted." },
		"program": { "format": Array, "default": [], "positional": "rest", "doc": "The file, then its arguments." }
	}
} satisfies CommandDefinition;
