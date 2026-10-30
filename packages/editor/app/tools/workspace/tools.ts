/** Experiments that undo themselves: the working tree noted, and put back as it was (checkpoints.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const workspace: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "workspace_checkpoint",
			"config": {
				"description": "Note the working tree as it stands (every file git sees that differs from HEAD, and which files aren't there), to put it back with workspace_restore: try a change, see what it breaks (code_problems, runs_tests), and undo it whole if it doesn't hold. Kept in this page, the last 10; a reload loses them. Files git ignores (node_modules) aren't in it, nor `.silo/`, where the editor keeps its records as it goes. Returns { id, files, checkpoints }.",
				"inputSchema": { "label": z.string().optional().describe("A name for it, to tell it apart.") }
			},
			"handler": async ({ label }, { signal }) => ok(request("workspace.checkpoint", { "label": label }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "workspace_restore",
			"config": {
				"description": "Put the working tree back as a checkpoint had it: every file changed since restored (a file made since deleted, one deleted since made again), as one edit an open editor and undo see, every file saved. It refuses when HEAD has moved since (a commit): undoing a commit is git's. Returns { checkpoint, restored, removed }.",
				"inputSchema": { "id": z.string().describe("The checkpoint's id, from workspace_checkpoint.") }
			},
			"handler": async ({ id }, { signal }) => ok(request("workspace.restore", { "id": id }, signal))
		})
	}
];

export default workspace;
