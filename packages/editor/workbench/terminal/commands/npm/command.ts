import type { CommandDefinition } from "../../catalog";

/** A command line's rest, passed on as it is. */
const REST = { "format": Array, "default": [], "positional": "rest" } as const;

export default {
	"name": "npm",
	"summary": "Run package.json scripts; install adds a dependency to package.json (the preview resolves it).",
	"streaming": true, // a script may run node or vite
	"subcommands": {
		"install": {
			"summary": "Add packages to package.json (resolved from esm.sh by the preview — there's no install step).",
			"aliases": ["i", "add", "ci"],
			"options": {
				"saveDev": { "format": Boolean, "default": false, "short": "D", "doc": "To devDependencies." },
				"save": { "format": Boolean, "default": false, "short": "S", "doc": "Accepted: they're saved anyway." },
				"packages": { ...REST, "doc": "name, name@version, @scope/name@version." }
			}
		},
		"uninstall": {
			"summary": "Take packages out of package.json.",
			"aliases": ["remove", "rm", "un"],
			"options": { "packages": { ...REST, "doc": "The packages, by name." } }
		},
		"ls": { "summary": "What package.json declares.", "aliases": ["list"] },
		"run": {
			"summary": "Run a package.json script (none: list them).",
			"aliases": ["run-script"],
			"stopEarly": true,
			"options": {
				"script": { "format": String, "default": "", "positional": true, "doc": "The script." },
				"args": { ...REST, "doc": "Its arguments (after --, as npm takes them)." }
			}
		},
		"start": { "summary": "npm run start.", "stopEarly": true, "options": { "args": REST } },
		"stop": { "summary": "npm run stop.", "stopEarly": true, "options": { "args": REST } },
		"test": { "summary": "npm run test.", "stopEarly": true, "options": { "args": REST } },
		"restart": { "summary": "npm run restart.", "stopEarly": true, "options": { "args": REST } },
		"exec": { "summary": "Run a command this shell has (npx).", "aliases": ["x"], "stopEarly": true, "options": { "command": REST } },
		"version": { "summary": "The npm this shell's is.", "aliases": ["-v", "--version"] }
	}
} satisfies CommandDefinition;
