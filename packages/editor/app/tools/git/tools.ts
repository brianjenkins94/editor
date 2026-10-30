/** The workspace's git: status, diff, the changes as hunks, commit and discard (whole files or hunks), branches, a push
 *  to GitHub, and history — log, a file at a revision, blame (git-service.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const git: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_log",
			"config": {
				"description": "The commits from HEAD back, newest first: every one, or only those that changed a file (its renames followed). Each with its oid, short oid, first line of its message, author and date. A shallow clone's history ends where it ends: `shallow` says so. Returns { commits: [{ oid, short, message, author, date }], shallow? }.",
				"inputSchema": {
					"path": z.string().optional().describe("Only the commits that changed this file (relative to the workspace)."),
					"limit": z.number().optional().describe("How many, at most (default 20, at most 500).")
				}
			},
			"handler": async ({ path, limit }, { signal }) => ok(request("git.log", { "path": path, "limit": limit }, signal))
		})
	},
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_show",
			"config": {
				"description": "A file as it was at a revision: a commit's oid (or its beginning), a branch, or HEAD. Returns { path, rev, lines, content, truncated? }.",
				"inputSchema": {
					"path": z.string().describe("The file (relative to the workspace)."),
					"rev": z.string().describe("The commit (oid or its beginning), branch or HEAD.")
				}
			},
			"handler": async ({ path, rev }, { signal }) => ok(request("git.show", { "path": path, "rev": rev }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "git_blame",
			"config": {
				"description": "Which commit last changed each line of a file, as runs of lines: each run's lines (1-based), the commit (`working` for an uncommitted change), its message's first line, author and date. A run marked boundary is as old as the oldest version this clone has, or older. Returns { path, runs: [{ from, to, commit, message?, author?, date?, boundary? }], versions, shallow? }.",
				"inputSchema": {
					"path": z.string().describe("The file (relative to the workspace)."),
					"from": z.number().optional().describe("The first line to say (1-based)."),
					"to": z.number().optional().describe("The last line to say.")
				}
			},
			"handler": async ({ path, from, to }, { signal }) => ok(request("git.blame", { "path": path, "from": from, "to": to }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "git_status",
			"config": {
				"description": "The workspace's changed files, each A, M or D, staged or not. Returns { files }.",
				"inputSchema": {}
			},
			"handler": async (_args, { signal }) => ok(request("git.status", undefined, signal))
		})
	},
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_diff",
			"config": {
				"description": "A unified diff of the working tree against the last commit: one file's, or every changed file's. Returns { diff }.",
				"inputSchema": { "path": z.string().optional().describe("Only this file's (relative to the workspace).") }
			},
			"handler": async ({ path }, { signal }) => ok(request("git.diff", { "path": path }, signal))
		})
	},
	{
		"timeoutMs": 600000,
		"tool": defineTool({
			"name": "git_review",
			"config": {
				"description": "The working tree's changes as hunks, each with an id that git_commit and git_discard take: per file its status and hunks (the HEAD and working lines each replaces, removed and added). With verdicts, BABLR's verdict on each modified code file and whether each hunk is cosmetic (formatting or comments only; slow, about a second per thousand characters); with owners, the features (from .silo/manifest.json) whose code each hunk is in. Returns { files: [{ path, status, hunks: [{ id, head, working, removed, added, cosmetic?, owners? }], verdict? }], head }.",
				"inputSchema": {
					"paths": z.array(z.string()).optional().describe("Only these files (relative to the workspace); default, every change."),
					"verdicts": z.boolean().optional().describe("Ask BABLR which changes are cosmetic."),
					"owners": z.boolean().optional().describe("Say which features each hunk's code is in.")
				}
			},
			"handler": async ({ paths, verdicts, owners }, { signal }) => ok(request("git.review", { "paths": paths, "verdicts": verdicts === true, "owners": owners === true }, signal))
		})
	},
	{
		"timeoutMs": 600000,
		"tool": defineTool({
			"name": "git_commit",
			"config": {
				"description": "Commit every change, or the files given — each whole, or only some of its hunks (ids from git_review) — with a message. The working tree keeps what isn't committed. Returns { oid }.",
				"inputSchema": {
					"message": z.string().describe("The commit message."),
					"files": z.array(z.union([z.string(), z.object({ "path": z.string(), "hunks": z.array(z.string()).optional() })])).optional().describe("Only these files (relative to the workspace), a path for the whole file's change or { path, hunks } for some of it; default, every change.")
				}
			},
			"handler": async ({ message, files }, { signal }) => ok(request("git.commit", { "message": message, ...Array.isArray(files) ? { "files": files.map((file) => (typeof file === "string" ? { "path": file } : file)) } : {} }, signal))
		})
	},
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_discard",
			"config": {
				"description": "Throw away a file's uncommitted change, back to HEAD (an added file is deleted): all of it, or only the hunks given (ids from git_review). Can't be undone. Returns { ok }.",
				"inputSchema": {
					"path": z.string().describe("The file (relative to the workspace)."),
					"hunks": z.array(z.string()).optional().describe("Only these hunks; default, the whole change.")
				}
			},
			"handler": async ({ path, hunks }, { signal }) => ok(request("git.discard", { "path": path, ...Array.isArray(hunks) ? { "hunks": hunks } : {} }, signal))
		})
	},
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_branch",
			"config": {
				"description": "The branches and which one HEAD is on; with a name, one made at HEAD first (without switching to it). Returns { current, all }.",
				"inputSchema": { "name": z.string().optional().describe("A branch to make.") }
			},
			"handler": async ({ name }, { signal }) => ok(request("git.branch", { "name": name }, signal))
		})
	},
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_checkout",
			"config": {
				"description": "Switch to a branch; with create, make it at HEAD first, keeping the working tree's changes (git switch -c). Returns { current, all }.",
				"inputSchema": {
					"name": z.string().describe("The branch."),
					"create": z.boolean().optional().describe("Make it first.")
				}
			},
			"handler": async ({ name, create }, { signal }) => ok(request("git.checkout", { "name": name, "create": create === true }, signal))
		})
	},
	{
		"timeoutMs": 300000,
		"tool": defineTool({
			"name": "git_pull",
			"config": {
				"description": "Bring a branch (the current one, by default) up to the GitHub repository's when that's a fast-forward (git pull --ff-only), through the editor's sign-in: the commits GitHub has that the workspace hasn't, their files written, the working tree's own changes kept. Nothing is touched when it can't: outcome \"diverged\" (each has commits the other hasn't) or \"conflicts\" (GitHub changed files changed here, listed). Returns { ref, outcome: \"up to date\" | \"ahead\" | \"fast-forwarded\" | \"diverged\" | \"conflicts\", from?, to?, files?, conflicts?, url }.",
				"inputSchema": { "ref": z.string().optional().describe("The branch; default, the current one.") }
			},
			"handler": async ({ ref }, { signal }) => ok(request("git.pull", { "ref": ref }, signal))
		})
	},
	{
		"timeoutMs": 300000,
		"tool": defineTool({
			"name": "git_push",
			"config": {
				"description": "Push a branch (the current one, by default) to the GitHub repository the workspace was loaded from, as the same branch — through the editor's sign-in, so the page must be signed in with GitHub. A rejected update (not a fast-forward, a protected branch) comes back as ok: false. Returns { ref, ok, error?, url }.",
				"inputSchema": {
					"ref": z.string().optional().describe("The branch; default, the current one."),
					"force": z.boolean().optional().describe("Even when it isn't a fast-forward.")
				}
			},
			"handler": async ({ ref, force }, { signal }) => ok(request("git.push", { "ref": ref, "force": force === true }, signal))
		})
	}
];

export default git;
