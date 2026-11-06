import type { CommandDefinition } from "../../catalog";

export default {
	"name": "open",
	"summary": "Open files in the editor, or an address in the browser.",
	"options": { "targets": { "format": Array, "default": [], "positional": "rest", "doc": "Files, folders or addresses." } }
} satisfies CommandDefinition;
