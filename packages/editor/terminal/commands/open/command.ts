import type { CommandDefinition } from "../../catalog";

export default {
	"name": "open",
	"summary": "Open files in the editor, a folder in the Explorer, or a URL in the browser.",
	"usage": "open <file>[:line[:column]]… | open <folder> | open <url>"
} satisfies CommandDefinition;
