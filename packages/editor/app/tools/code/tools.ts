/** What the code says: a change's problems against HEAD (code-problems.ts), and what a way in reaches (code-reach.ts). */
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
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "code_reach",
			"config": {
				"description": "What a way into the program reaches — a command, hub request, agent tool, core module, setting, view… (silo's ways in) — before you change, move or remove it: the manifest feature that owns it, where it's registered, what removing it would free (declarations, whole files, lines) and what would be left to take out by hand, the docs naming it, and every place in code and tests that names it (a hub request's requesters, a command's callers). Give its key (`hub request|code.problems`) or its id (`code.problems`); an id more than one way in has, or none, answers with matches to choose from. It's read from the program as it is now, edits included. Returns { way: { key, facet, id, sides }, features, registered, frees: { declarations, files, lines, bytes }, byHand, docs, named: [{ file, line, text }], tests, counts } or { matches }.",
				"inputSchema": { "target": z.string().describe("A way in's key (facet|id) or its id.") }
			},
			"handler": async ({ target }, { signal }) => ok(request("code.reach", { "target": target }, signal))
		})
	}
];

export default code;
