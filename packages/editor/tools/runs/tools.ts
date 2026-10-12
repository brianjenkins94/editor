/** What's running and what ran (`runs.list` / `runs.stop`, runs.ts) and the run ledger (`runs.ledger`, evidence.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const runs: ToolFamily = ({ request }) => [{
	"tool": defineTool({
		"name": "runs",
		"config": {
			"description": "What's running in the editor, and what ran lately: every terminal's runs — a SERVICE runs until stopped (a dev server: `vite`, `npm run dev`, with its preview port), a TASK runs to completion (a `node` script) — each with its id, title, cwd, the terminal it came from, state (running / exited / failed / stopped), start and end times and exit code. Pass `stop` with a run's id to stop it.",
			"inputSchema": { "stop": z.string().optional().describe("A running run's id, to stop it.") }
		},
		"handler": async ({ stop }, { signal }) => {
			if (typeof stop === "string") {
				return ok({ "stopped": await request("runs.stop", { "id": stop }, signal) });
			}

			return ok(request("runs.list", undefined, signal));
		}
	})
}, {
	"timeoutMs": 15000,
	"tool": defineTool({
		"name": "run_ledger",
		"config": {
			"description": "The run ledger (.silo/runs/<user>.jsonl, kept in git): every run that ended — terminal tasks and services, debug sessions, previews — each with its id, title, entry, start/end, exit, who and where it ran, the commit and the blob oid of each file it ran, and its effects: each gated call (capability fs:read / fs:write / net / exec / …, the resource it reached) with how it went — made, denied, skipped or given (a rule's result in its place) — and how many calls. Ask it what touched what: the runs with such an effect, and their effects added up ({ capability, resource, how, calls, runs, first, last }). Returns { total, runs (newest first), effects }.",
			"inputSchema": {
				"file": z.string().optional().describe("Runs that ran this file — their entry, or any file they ran (repo-relative, e.g. src/index.ts)."),
				"capability": z.string().optional().describe("Effects of this capability: fs:read, fs:write, net, exec, eval, net.ws, net.webrtc — or a family (fs)."),
				"resource": z.string().optional().describe("Effects whose resource (a path, a host, a command) contains this."),
				"how": z.enum(["made", "denied", "skipped", "given"]).optional().describe("Effects that went this way."),
				"since": z.string().optional().describe("Runs that ended at or after this ISO time."),
				"user": z.string().optional().describe("One user's runs (the slug of their git identity)."),
				"limit": z.number().optional().describe("Runs to return (default 20); the effects add up every run that matched.")
			}
		},
		"handler": async (query, { signal }) => ok(request("runs.ledger", query, signal))
	})
}];

export default runs;
