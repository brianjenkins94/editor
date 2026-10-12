/**
 * The preview windows (`preview.windows`, shell-preview.ts), one Chrome DevTools Protocol command to a preview's page
 * (`preview.cdp`, preview-devtools.ts), a CPU profile of it (`preview.profile`, preview-profile.ts), and its cold-start
 * transform race, provoked on demand (the node worker's `preview.provoke`).
 */
import type { ToolFamily, ToolHost } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const WINDOW = z.string().optional().describe("The preview window, by its id from previews_list (preview:5173, preview:5173~2 — a port's second). Omit when one is open.");

/** The window a tool acts on, as the shell keys it (`5173~2`): `window` if given, else the only one open. */
async function windowKey({ request }: ToolHost, window: unknown, signal: AbortSignal): Promise<string> {
	if (typeof window === "string") {
		return window.replace(/^preview:/u, "");
	}

	const open = await request("preview.windows", undefined, signal) as { "id": string; "page"?: string }[];

	if (open.length === 1) {
		return open[0]!.id.replace(/^preview:/u, "");
	}

	throw new Error(open.length === 0
		? "no preview window is open — run the app first (vite, npm run dev)"
		: "several preview windows are open — pass window: " + open.map((entry) => entry.id + (entry.page === undefined ? "" : ` (${entry.page})`)).join("; "));
}

const previews: ToolFamily = (host) => [{
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "previews_list",
		"config": {
			"description": "The preview windows open: each one's id (the window every previews_* tool and page_eval / page_query take), its server's port and address, the page it's on, whether its page is popped out into a browser window of its own or has DevTools open, and when it was last used.",
			"inputSchema": {}
		},
		"handler": async (_args, { signal }) => ok(host.request("preview.windows", undefined, signal))
	})
}, {
	"timeoutMs": 300000,
	"tool": defineTool({
		"name": "previews_provoke",
		"config": {
			"description": "Force the preview's in-browser Vite dev server through the cold-start transform race on demand, and report any transform that lost (came back 500). Requires a preview already started (run the terminal `vite` command once). Two modes: default (warm) restarts the in-process server each round — fast, but the worker's typescript stays hot; hardReset spawns a fresh CHILD worker per round (cold almostnode + ts) to reproduce the true first-load window — slower (a cold ts chunk per round, so use fewer rounds), needs cross-origin isolation. Returns { rounds, hardReset, provoked, failures[], transformErrors[] }. Use this instead of hand-driving cold boots to hunt the race.",
			"inputSchema": {
				"rounds": z.number().optional().describe("Cold-restart + concurrent-transform cycles to run (default 10; use ~5 for hardReset, it's slower)."),
				"modules": z.array(z.string()).optional().describe("Module URLs to hammer each round, e.g. ['/src/App.tsx']. Default: the whole src/ graph."),
				"hardReset": z.boolean().optional().describe("Spawn a fresh cold child worker per round (cold ts realm — the true first-load race) instead of an in-process warm restart. Default false.")
			}
		},
		"handler": async ({ rounds = 10, modules, hardReset = false }, { signal }) => ok(host.request("preview.provoke", { "rounds": rounds, "modules": modules, "hardReset": hardReset }, signal))
	})
}, {
	"timeoutMs": 30000,
	"tool": defineTool({
		"name": "previews_cdp",
		"config": {
			"description": "Send one Chrome DevTools Protocol command to the PREVIEWED APP's page (not the editor's — that's page_eval) and return its result. The editor answers through chobitsu, a JavaScript CDP implementation it adds to the preview's page on first use, so it runs in the app's own realm: Runtime.evaluate (params { expression, returnByValue: true }), DOM.getDocument / DOM.querySelector / DOM.getOuterHTML, CSS.*, DOMStorage.*, Storage.*, Page.*. Events (console messages, network activity) aren't returned — only the command's reply. The Debugger domain lists scripts but can't pause. Requires that preview to be open (run the app first).",
			"inputSchema": {
				"method": z.string().describe("The CDP method, e.g. 'Runtime.evaluate' or 'DOM.getDocument'."),
				"params": z.record(z.string(), z.unknown()).optional().describe("The method's params, e.g. { expression: 'document.title', returnByValue: true }."),
				"window": WINDOW
			}
		},
		"handler": async ({ method, params, window }, { signal }) => {
			const reply = await host.request("preview.cdp", { "window": await windowKey(host, window, signal), "message": JSON.stringify({ "id": 1, "method": method, "params": params ?? {} }) }, signal);
			const { result, error } = JSON.parse(String(reply)) as { "result"?: unknown; "error"?: { "message"?: string } };

			if (error !== undefined) {
				throw new Error(String(method) + ": " + (error.message ?? JSON.stringify(error)));
			}

			return ok(result);
		}
	})
}, {
	"timeoutMs": 120000,
	"tool": defineTool({
		"name": "previews_profile",
		"config": {
			"description": "CPU-profile the PREVIEWED APP's page for a while (the JS Self-Profiling API, in that page's own realm) and return where its time went: the busiest functions by self time (selfMs) and with what they called (totalMs), each with its script url and line, plus idleMs and durationMs. A docked preview shares the editor's thread, so editor functions can appear too — the app's are the ones whose url is under /__virtual__/. Set `full` for the whole Chrome .cpuprofile as well (it can be large). Requires that preview to be open (run the app first); a page from before the editor served the profiling policy needs a reload.",
			"inputSchema": {
				"durationMs": z.number().optional().describe("How long to sample (default 5000, at most 60000)."),
				"sampleIntervalMs": z.number().optional().describe("How often to sample, in ms (default 10; the browser may round it up)."),
				"top": z.number().optional().describe("How many functions to list (default 25)."),
				"full": z.boolean().optional().describe("Include the whole .cpuprofile (Chrome DevTools' format) in the result."),
				"window": WINDOW
			}
		},
		"handler": async ({ durationMs, sampleIntervalMs, top, full, window }, { signal }) => {
			const result = await host.request("preview.profile", { "window": await windowKey(host, window, signal), "durationMs": durationMs, "sampleIntervalMs": sampleIntervalMs, "top": top }, signal, (Number(durationMs) || 5000) + 30_000) as { "profile": unknown; "summary": unknown };

			return ok(full === true ? result : result.summary);
		}
	})
}];

export default previews;
