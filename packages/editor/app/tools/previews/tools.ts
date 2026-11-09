/**
 * A preview window's page, as its DevTools has it: one Chrome DevTools Protocol command to it (`preview.cdp`,
 * shell/preview-devtools.ts), what the DevTools button in its title bar docks under it.
 */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const PORT = z.number().int().optional().describe("The preview's port (its window's title: Preview :5173): that server's window you used last. Omit for the window you used last.");

const previews: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 30000,
		"tool": defineTool({
			"name": "previews_cdp",
			"config": {
				"description": "Send one Chrome DevTools Protocol command to a PREVIEWED APP's page (not the editor's: that's page_eval) and return its result, as the DevTools docked under a preview window does. The editor answers through chobitsu, a JavaScript CDP implementation it adds to the preview's page on first use, so it runs in the app's own realm: Runtime.evaluate (params { expression, returnByValue: true }), DOM.getDocument / DOM.querySelector / DOM.getOuterHTML, CSS.*, DOMStorage.*, Storage.*, Page.*. Events (console messages, network activity) aren't returned, only the command's reply. The Debugger domain lists scripts but can't pause. Needs a preview window open (run the app first).",
				"inputSchema": {
					"method": z.string().describe("The CDP method, e.g. 'Runtime.evaluate' or 'DOM.getDocument'."),
					"params": z.record(z.string(), z.unknown()).optional().describe("The method's params, e.g. { expression: 'document.title', returnByValue: true }."),
					"port": PORT
				}
			},
			"handler": async ({ method, params, port }, { signal }) => {
				const reply = await request("preview.cdp", { "port": port, "message": JSON.stringify({ "id": 1, "method": method, "params": params ?? {} }) }, signal);
				const { result, error } = JSON.parse(reply as string) as { "result"?: unknown; "error"?: { "message"?: string } };

				if (error !== undefined) {
					throw new Error(`${method}: ${error.message ?? JSON.stringify(error)}`);
				}

				return ok(result);
			}
		})
	}
];

export default previews;
