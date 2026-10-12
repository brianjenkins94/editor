import type { CommandDefinition } from "../../catalog";

export default {
	"name": "code",
	"summary": "Open files in the editor (at a line with file:line[:column]), or show a folder in the Explorer.",
	"usage": "code <file>[:line[:column]]… | code <folder>"
} satisfies CommandDefinition;
