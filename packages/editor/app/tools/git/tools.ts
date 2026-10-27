/** The workspace's git: status, diff, commit, branches, and a push to GitHub (git-service.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const git: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
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
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "git_commit",
			"config": {
				"description": "Commit every change, or the files given, with a message. Returns { oid }.",
				"inputSchema": {
					"message": z.string().describe("The commit message."),
					"files": z.array(z.string()).optional().describe("Only these files (relative to the workspace); default, every change.")
				}
			},
			"handler": async ({ message, files }, { signal }) => ok(request("git.commit", { "message": message, ...Array.isArray(files) ? { "files": files.map((file) => ({ "path": String(file) })) } : {} }, signal))
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
