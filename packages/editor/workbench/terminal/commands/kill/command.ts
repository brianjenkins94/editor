import type { CommandDefinition } from "../../catalog";

export default {
	"name": "kill",
	"summary": "Stop runs by their id from ps (any unique beginning of it).",
	"options": {
		"force": { "format": Boolean, "default": false, "short": "9", "doc": "Accepted, and the same: a run is stopped however it's asked." },
		"ids": { "format": Array, "default": [], "positional": "rest", "doc": "The runs, by id." }
	}
} satisfies CommandDefinition;
