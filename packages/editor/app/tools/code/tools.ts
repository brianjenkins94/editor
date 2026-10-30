/** What the code says: a change's problems against HEAD (code-problems.ts), what a way in reaches (code-reach.ts); and
 *  refactoring it — references, rename, a move with its imports (code-refactor.ts). */
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
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "code_references",
			"config": {
				"description": "Where a name is used, as TypeScript resolves it (not text search: a same-named thing elsewhere isn't it): each place's file, line, column and line of text, its declaration included. Give the file, the line it's on and the name. Returns { name, places: [{ file, line, column, text }], total }.",
				"inputSchema": {
					"path": z.string().describe("The file (relative to the workspace)."),
					"line": z.number().describe("The line the name is on (1-based)."),
					"name": z.string().describe("The name on that line: a variable, function, class, member, import…")
				}
			},
			"handler": async ({ path, line, name }, { signal }) => ok(request("code.references", { "path": path, "line": line, "name": name }, signal))
		})
	},
	{
		"timeoutMs": 300000,
		"tool": defineTool({
			"name": "code_rename",
			"config": {
				"description": "Rename a name everywhere it's used, as TypeScript renames it (its declaration, every use, imports and exports), as one edit the editor sees as typing, every file saved. Give the file, the line it's on, the name and the new name. Check with code_problems after. Returns { renamed, to, changes, files }.",
				"inputSchema": {
					"path": z.string().describe("The file (relative to the workspace)."),
					"line": z.number().describe("The line the name is on (1-based)."),
					"name": z.string().describe("The name on that line: a variable, function, class, member, import…"),
					"to": z.string().describe("The new name.")
				}
			},
			"handler": async ({ path, line, name, to }, { signal }) => ok(request("code.rename", { "path": path, "line": line, "name": name, "to": to }, signal))
		})
	},
	{
		"timeoutMs": 300000,
		"tool": defineTool({
			"name": "code_move",
			"config": {
				"description": "Move (or rename) a file with its imports kept right: every file importing it changed to its new path, and its own relative imports changed to match, as TypeScript works them out — one edit with the move, every file saved, nothing asked. `unchecked` says when no TypeScript project held it, so nothing importing it was changed. Check with code_problems after. Returns { moved, to, updated, unchecked? }.",
				"inputSchema": {
					"from": z.string().describe("The file now (relative to the workspace)."),
					"to": z.string().describe("Where it goes (relative to the workspace); nothing may be there.")
				}
			},
			"handler": async ({ from, to }, { signal }) => ok(request("code.move", { "from": from, "to": to }, signal))
		})
	}
];

export default code;
