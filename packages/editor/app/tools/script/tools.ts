/** JavaScript for the computation a script is for, the workspace read-only, in the capability-gated realm (script-run.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const script: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 130000,
		"tool": defineTool({
			"name": "script_run",
			"config": {
				"description": "Run JavaScript for what a script is for — counting, joining JSON, a table out of many files — with the workspace read-only, and get its answer as data. `code` is an async function's body: `return` the answer (JSON-like: functions dropped). It reads with `await workspace.read(path)` (text), `await workspace.json(path)` and `await workspace.glob(\"**/*.ts\", limit?)` (paths, files.exclude applying, 1000 by default); `console.log` is kept. It runs in the capability-gated realm: no network, no require, nothing that writes, no worker — a refused capability is listed, not a way round. Returns { value (or valueText and truncated past 100 000 characters of JSON), logs, touched: { read, bytes, globs, refused }, ms } or { error }.",
				"inputSchema": {
					"code": z.string().describe("An async function's body, e.g. `const files = await workspace.glob(\"**/package.json\"); return files.length;`"),
					"timeoutMs": z.number().int().positive().optional().describe("How long it may take (default 30 000, at most 120 000); past it the realm is stopped.")
				}
			},
			"handler": async ({ code, timeoutMs }, { signal }) => ok(request("script.run", { "code": code, "timeoutMs": timeoutMs }, signal))
		})
	}
];

export default script;
