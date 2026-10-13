/** The workspace's git: status, diff and commit (git-service.ts). */
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
	}
];

export default git;
