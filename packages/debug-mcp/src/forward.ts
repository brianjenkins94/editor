/**
 * Forwarding a tool call to ONE tab. Every connected tab serves its page tools under its own id (`tool.<name>.<tab>`,
 * see observability's servePageTools), so a call reaches exactly the tab it names — debug-mcp links every open tab, and
 * a call to a bare name would run in each of them.
 */
import type { RpcClient } from "@brianjenkins94/hub";
import type { DebugMcp } from "./server.ts";

// A tab that isn't connected fails fast instead of waiting out the whole timeout.
export const RESPONDER_MS = 3000;

/** The tab to act on: `tab` if given, else the only connected editor tab (an app in one of its previews is a tab
 *  too, but only when named — the editor tab stays the default). */
export async function resolveTab(debugMcp: DebugMcp, tab: string | undefined): Promise<string> {
	if (tab !== undefined) {
		return tab;
	}

	const tabs = await debugMcp.tabs();
	const editors = tabs.filter((entry) => entry.preview !== true);

	if (editors.length === 1) {
		return editors[0].tab;
	}

	throw new Error(editors.length === 0
		? "no editor tab is connected (the editor links to debug-mcp on localhost, or with ?debug)"
		: "several editor tabs are connected — pass tab: " + tabs.map((entry) => `${entry.tab} (${entry.title || entry.url}${entry.preview === true ? ", an app in a preview" : ""}${entry.focused ? ", focused" : entry.visible ? "" : ", hidden"})`).join("; "));
}

/** Call `name` with no ceiling but `timeoutMs`: past it the call is cancelled (the page stops waiting too). */
export async function callFor(rpc: RpcClient, name: string, args: unknown, timeoutMs: number, timeoutMessage = `no answer within ${timeoutMs}ms`): Promise<unknown> {
	try {
		return await rpc.request(name, args, { "timeoutMs": Infinity, "waitForResponderMs": RESPONDER_MS, "signal": AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(timeoutMessage, { "cause": error });
		}

		throw error;
	}
}

/** Call page tool `name` on tab `tab` (or the only connected tab). */
export async function callTab(debugMcp: DebugMcp, name: string, tab: string | undefined, args: unknown, timeoutMs: number): Promise<unknown> {
	return callFor(debugMcp.rpc, name + "." + await resolveTab(debugMcp, tab), args, timeoutMs);
}
