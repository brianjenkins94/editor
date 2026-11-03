/** Notes on code, as an agent adds them — what Add Note does from a selection (the notes extension; `notes.add`, workspace-tools.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const notes: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "notes_add",
			"config": {
				"description": "Put a note on code, as Add Note does on a selection: kept beside the code, not in it (.silo/notes/<you>/<file>.jsonl), and following the code as it moves and changes — for a why, a gotcha or a history the code can't say. `at` is the code it's about, exactly as written in the file (a statement or an expression; found once, else give more of it). Shown in the editor as a comment thread. Returns { path, line }.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace."),
					"at": z.string().describe("The code the note is about, exactly as written: a statement or an expression."),
					"text": z.string().describe("The note.")
				}
			},
			"handler": async ({ path, at, text }, { signal }) => ok(request("notes.add", { "path": path, "at": at, "text": text }, signal))
		})
	}
];

export default notes;
