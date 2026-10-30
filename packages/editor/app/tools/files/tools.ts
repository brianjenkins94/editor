/** The workspace, as an agent works in it — files read, written, edited, found and searched (`files.*`, workspace-tools.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const files: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 10000,
		"tool": defineTool({
			"name": "files_read",
			"config": {
				"description": "Read a workspace file, numbered as `cat -n` numbers it (`line<TAB>text`): what's open in an editor — unsaved edits included — else what's on disk. Returns { path, lines (in all), from, to, dirty (unsaved edits), content }. Read a long file in pieces with offset and limit.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace (src/index.ts) or absolute under it (/workspace/src/index.ts)."),
					"offset": z.number().optional().describe("The 1-based line to start at (default 1)."),
					"limit": z.number().optional().describe("Lines to read (default 2000).")
				}
			},
			"handler": async ({ path, offset, limit }, { signal }) => ok(request("files.read", { "path": path, "offset": offset, "limit": limit }, signal))
		})
	},
	{
		"timeoutMs": 15000,
		"tool": defineTool({
			"name": "files_write",
			"config": {
				"description": "Make a workspace file, or replace its whole text. An open editor shows the change and undo takes it back, as if it were typed; then it's saved (format on save runs). Prefer files_edit to change part of a file. Returns { path, created, lines }.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace or absolute under it. Its folders are made as needed."),
					"content": z.string().describe("The file's whole text.")
				}
			},
			"handler": async ({ path, content }, { signal }) => ok(request("files.write", { "path": path, "content": content }, signal))
		})
	},
	{
		"timeoutMs": 15000,
		"tool": defineTool({
			"name": "files_edit",
			"config": {
				"description": "Replace an exact string in a workspace file — found once (else it fails: give more of the text around it), or every time with all. Matched against the file as the editor has it (unsaved edits included), whitespace and all — not files_read's line numbers. An open editor shows the change, undo takes it back; then it's saved. Returns { path, replaced }.",
				"inputSchema": {
					"path": z.string().describe("The file, relative to the workspace or absolute under it."),
					"old": z.string().describe("The exact text to replace."),
					"new": z.string().describe("What replaces it."),
					"all": z.boolean().optional().describe("Replace every occurrence (default: there must be exactly one).")
				}
			},
			"handler": async ({ path, old, "new": replacement, all }, { signal }) => ok(request("files.edit", { "path": path, "old": old, "new": replacement, "all": all }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "files_replace",
			"config": {
				"description": "Replace exact strings across files, all or nothing: each replacement must be found as it says — once (the default), `count` times, or every time with `all` — and none may overlap another, or nothing changes and the answer says each one that didn't hold. Then it's one edit (an open editor shows it, one undo takes it back) and every file is saved. Use it for a change that spans files (a signature and its callers); for a rename or a move, code_rename and code_move. Returns { files: [{ path, replaced }], replaced }.",
				"inputSchema": {
					"edits": z.array(z.object({
						"path": z.string().describe("The file, relative to the workspace or absolute under it."),
						"old": z.string().describe("The exact text to replace."),
						"new": z.string().describe("What replaces it."),
						"all": z.boolean().optional().describe("Replace every occurrence, however many."),
						"count": z.number().optional().describe("How many times it must be found (default 1).")
					})).describe("The replacements, in any order.")
				}
			},
			"handler": async ({ edits }, { signal }) => ok(request("files.replace", { "edits": edits }, signal))
		})
	},
	{
		"timeoutMs": 15000,
		"tool": defineTool({
			"name": "files_glob",
			"config": {
				"description": "The workspace's files a glob matches, relative to the workspace, sorted — node_modules and .git left out unless the glob names them. Returns { files, truncated }.",
				"inputSchema": {
					"pattern": z.string().describe("A glob: src/**/*.ts, **/package.json, *.md."),
					"limit": z.number().optional().describe("At most this many (default 500).")
				}
			},
			"handler": async ({ pattern, limit }, { signal }) => ok(request("files.glob", { "pattern": pattern, "limit": limit }, signal))
		})
	},
	{
		"timeoutMs": 30000,
		"tool": defineTool({
			"name": "files_grep",
			"config": {
				"description": "Search the workspace's files for a regular expression (JavaScript syntax), line by line — open files as the editor has them. Returns { matches: [{ file, line (1-based), text }], total }.",
				"inputSchema": {
					"pattern": z.string().describe("A regular expression, e.g. `function \\w+Run`."),
					"glob": z.string().optional().describe("Only the files this glob matches (default: every file but node_modules and .git)."),
					"ignoreCase": z.boolean().optional().describe("Match regardless of case."),
					"limit": z.number().optional().describe("At most this many matches (default 200); total says how many there are.")
				}
			},
			"handler": async ({ pattern, glob, ignoreCase, limit }, { signal }) => ok(request("files.grep", { "pattern": pattern, "glob": glob, "ignoreCase": ignoreCase, "limit": limit }, signal))
		})
	}
];

export default files;
