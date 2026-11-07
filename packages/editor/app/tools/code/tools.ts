/** What the code says: a change's problems against HEAD (code-problems.ts), as the review panel shows each changed
 *  file's; which files BABLR parses (bablr.ts). And refactoring as a person does it (code-refactor.ts): Find All References,
 *  Rename Symbol, and the Explorer's move with its imports kept right. */
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
		"timeoutMs": 1_800_000,
		"tool": defineTool({
			"name": "code_parses",
			"config": {
				"description": "BABLR: Check Which Files Parse (the command): every code file under a folder parsed by BABLR, one at a time, and how much its grammar takes — files and lines — with each file it can't parse and why (a warning on it in Problems too: nothing attaches to code BABLR can't parse). About 14 ms a line the first time; a file is kept by its content, so asking again is quick. A folder opened with git_open (.refs/<name>/…) can be checked too. Returns { path, files, parsed, lines, parsedLines, ms, cached, cancelled?, unparsable: [{ file, lines, why }] }.",
				"inputSchema": {
					"path": z.string().describe("The folder, from the workspace's root (\"\" for all of it)."),
					"exclude": z.string().optional().describe("A glob of files to leave out, from the folder (node_modules always is): \"**/test/**\", say.")
				}
			},
			"handler": async ({ path, exclude }, { signal }) => ok(request("bablr.check", { "path": path, "exclude": exclude }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "code_references",
			"config": {
				"description": "Where a name is used, as Find All References shows it: TypeScript's answer, not a text search (a same-named thing elsewhere isn't it). Each place's file, line, column and text, its declaration included. Give the file, the line it's on and the name. Returns { name, places, total }.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace."),
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
				"description": "Rename a name everywhere it's used, as Rename Symbol (F2) does: its declaration, every use, imports and exports, as TypeScript renames it, one edit the editor sees as typing, every file saved. Give the file, the line it's on, the name and the new name.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace."),
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
				"description": "Move or rename a file or folder as the Explorer does, its imports kept right: every file importing it changed to the new path, and its own relative imports to match, as TypeScript works them out, in one edit with the move, every file it touched saved. Returns { moved, to, updated }.",
				"inputSchema": {
					"from": z.string().describe("The file or folder now, relative to the workspace."),
					"to": z.string().describe("Where it goes, relative to the workspace; nothing may be there.")
				}
			},
			"handler": async ({ from, to }, { signal }) => ok(request("code.move", { "from": from, "to": to }, signal))
		})
	}
];

export default code;
