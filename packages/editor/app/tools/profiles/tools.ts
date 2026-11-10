/**
 * A CPU profile of a preview window's page (`preview.profile`, shell/preview-profile.ts), as its title bar's Profile button
 * takes one: kept with its server's run, each function's time shown on the code, in the editor too.
 */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const profiles: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "previews_profile",
			"config": {
				"description": "CPU-profile a PREVIEWED APP's page for a while (the JS Self-Profiling API, in that page's own realm), as the Profile button in its window's title bar does, and return where its time went: the busiest functions by self time (selfMs) and with what they called (totalMs), each with its script url and line, plus idleMs and durationMs. Each of the app's functions' time is kept with the dev server's run (its evidence, as the run ends), and the editor shows it on the code: its share and time at the end of the function's line. A preview shares the editor's thread, so editor functions can appear: the app's are the ones whose url is under /__virtual__/. Needs a preview window open (run the app first); a page from before the editor served the profiling policy needs a reload.",
				"inputSchema": {
					"durationMs": z.number().int().optional().describe("How long to sample (default 5000, at most 60000)."),
					"port": z.number().int().optional().describe("The preview's port (its window's title: Preview :5173): that server's window you used last. Omit for the window you used last.")
				}
			},
			"handler": async ({ durationMs, port }, { signal }) => ok(request("preview.profile", { "port": port, "durationMs": durationMs }, signal, (durationMs ?? 5000) + 30_000))
		})
	}
];

export default profiles;
