/** Experiments that undo themselves: Save Checkpoint and Restore Checkpoint, as a person runs them (checkpoints.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const workspace: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "workspace_checkpoint",
			"config": {
				"description": "Save a checkpoint, as Workspace: Save Checkpoint does: every file git sees that differs from HEAD, and which files aren't there, to put back with workspace_restore. Try a change, see what it breaks (code_problems, runs_tests), and undo it whole if it doesn't hold. Returns { id, files, checkpoints }.",
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
				"description": "Restore a checkpoint, as Workspace: Restore Checkpoint… does: every file changed since put back as it was (a file made since deleted, one deleted since made again), one edit an open editor and undo see, every file saved. It refuses when HEAD has moved since (a commit), as undoing that is git's. Returns { checkpoint, restored, removed }.",
				"inputSchema": { "id": z.string().describe("The checkpoint's id, from workspace_checkpoint.") }
			},
			"handler": async ({ id }, { signal }) => ok(request("workspace.restore", { "id": id }, signal))
		})
	}
];

export default workspace;
