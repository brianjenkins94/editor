/** What the code says of a change: the problems it added and cleared against HEAD (code-problems.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const code: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 300000,
		"tool": defineTool({
			"name": "code_problems",
			"config": {
				"description": "The problems a change made and the ones it fixed: TypeScript's and ESLint's diagnostics in the working tree's changed files (and, for TypeScript, the files importing them), compared with the same files at HEAD. A problem is the same one when its file, source, code and message are, wherever it moved. Use it after an edit instead of reading every problem: the program's old ones aren't the change's. `unchecked` says what wasn't looked at (importers over the limit or further out, files no TypeScript project holds), so an empty `added` is only as complete as it says. Returns { added: [{ file, line, column, source, code, severity, message }], cleared (lines at HEAD), counts: { added, cleared, unchanged }, checked: { changed, typescript, eslint }, unchecked: { importers, furtherImporters, noProject, typescript? } }.",
				"inputSchema": {
					"paths": z.array(z.string()).optional().describe("Only these changed files or folders (relative to the workspace); default, every change."),
					"depth": z.number().optional().describe("Importers checked besides the changed files: 1 (default) for the files importing them, 0 for none."),
					"limit": z.number().optional().describe("TypeScript files checked at most, per project (default 100).")
				}
			},
			"handler": async ({ paths, depth, limit }, { signal }) => ok(request("code.problems", { "paths": paths, "depth": depth, "limit": limit }, signal))
		})
	}
];

export default code;
