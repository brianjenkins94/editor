/** What's in front of you in the editor, its Problems and its notifications, as data (editor-state.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const editor: ToolFamily = ({ request }) => [{
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "editor",
		"config": {
			"description": "What's in front of you in the editor, as data: the active file (its language, line count, whether it's unsaved), the cursor, any selections with their text, and the lines in view — all 1-based — and every editor tab open, by group.",
			"inputSchema": {}
		},
		"handler": async (_args, { signal }) => ok(request("editor.state", undefined, signal))
	})
}, {
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "problems",
		"config": {
			"description": "The Problems view, as data: each diagnostic's file, 1-based range, severity, source (ts, eslint, notes, a capability tripwire) and message — errors first. `total` says how many there are in all.",
			"inputSchema": {
				"file": z.string().optional().describe("Only this file's (absolute or relative to the workspace)."),
				"limit": z.number().optional().describe("At most this many (default 200).")
			}
		},
		"handler": async ({ file, limit }, { signal }) => ok(request("problems.list", { "file": file, "limit": limit }, signal))
	})
}, {
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "notifications",
		"config": {
			"description": "The notifications showing now — the toasts and the notification center's: each one's severity, message, source and buttons. (Errors like \"Couldn't run: …\" appear only there.)",
			"inputSchema": {}
		},
		"handler": async (_args, { signal }) => ok(request("notifications.list", undefined, signal))
	})
}];

export default editor;
