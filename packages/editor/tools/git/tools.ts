/** The workspace's git: status, diff and commit (git-service.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const git: ToolFamily = ({ request }) => [{
	"timeoutMs": 60000,
	"tool": defineTool({
		"name": "git",
		"config": {
			"description": "The workspace's git: status (each changed file — A, M or D — staged or not), diff (a unified diff of the working tree against the last commit: one file's, or every changed file's), or commit (a message, and every change, or the files given). Returns { files } for status, { diff } for diff, { oid } for commit.",
			"inputSchema": {
				"action": z.enum(["status", "diff", "commit"]).describe("What to do."),
				"path": z.string().optional().describe("diff: one file's (relative to the workspace)."),
				"message": z.string().optional().describe("commit: its message."),
				"files": z.array(z.string()).optional().describe("commit: only these files (relative to the workspace); default, every change.")
			}
		},
		"handler": async ({ action, path, message, files }, { signal }) => {
			if (action === "status") {
				return ok(request("git.status", undefined, signal));
			}

			if (action === "diff") {
				return ok(request("git.diff", { "path": path }, signal));
			}

			if (action === "commit") {
				return ok(request("git.commit", { "message": message, ...Array.isArray(files) ? { "files": files.map((file) => ({ "path": String(file) })) } : {} }, signal));
			}

			throw new Error(`unknown git action "${String(action)}" — status, diff or commit`);
		}
	})
}];

export default git;
