/**
 * Forwarding a tool call to ONE tab. Every connected tab serves its page tools under its own id (`tool.<name>.<tab>`,
 * see observability's servePageTools), so a call reaches exactly the tab it names — debug-mcp links every open tab, and
 * a call to a bare name would run in each of them.
 */
import type { RpcClient } from "@brianjenkins94/hub";
import type { DebugMcp } from "./server.ts";
import { rpcCallSubject } from "@brianjenkins94/hub";

// A tab that isn't connected fails fast instead of waiting out the whole timeout.
export const RESPONDER_MS = 3000;
/** How often a call checks its tab is still there to answer it. */
const GONE_MS = 2000;

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

/** Call `name` with no ceiling but `timeoutMs`: past it the call is cancelled (the page stops waiting too) — or
 *  `cancel`, which aborts with its reason. */
export async function callFor(rpc: RpcClient, name: string, args: unknown, timeoutMs: number, timeoutMessage = `no answer within ${timeoutMs}ms`, cancel?: AbortSignal): Promise<unknown> {
	try {
		return await rpc.request(name, args, { "timeoutMs": Infinity, "waitForResponderMs": RESPONDER_MS, "signal": cancel === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) });
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(timeoutMessage, { "cause": error });
		}

		if (cancel?.aborted === true) {
			throw cancel.reason instanceof Error ? cancel.reason : new Error(String(cancel.reason), { "cause": error });
		}

		throw error;
	}
}

/** Call page tool `name` on tab `tab` (or the only connected tab). */
export async function callTab(debugMcp: DebugMcp, name: string, tab: string | undefined, args: unknown, timeoutMs: number): Promise<unknown> {
	const target = await resolveTab(debugMcp, tab);
	const subject = rpcCallSubject(name + "." + target);
	// A tab that goes away mid-call (reloaded, closed, crashed) never answers: the call fails as it goes, rather than
	// waiting out a timeout that can be half an hour.
	const gone = new AbortController();
	const watch = setInterval(() => {
		if (!debugMcp.hub.interested(subject)) {
			gone.abort(new Error(`tab ${target} went away during the call (reloaded, closed or crashed): it may or may not have done it`));
		}
	}, GONE_MS);

	try {
		return await callFor(debugMcp.rpc, name + "." + target, args, timeoutMs, undefined, gone.signal);
	} finally {
		clearInterval(watch);
	}
}
