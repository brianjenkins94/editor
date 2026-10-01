/**
 * Tab discovery — so a relay linked to several tabs at once (debug-mcp links every open tab, each as its own tree) can
 * learn which tabs are there and address one. A tab serves its page tools under its id (`tool.<name>.<tab>`, see
 * servePageTools), and answers a discovery query with who it is:
 *
 *   relay → `tab.discover` { query }
 *   tab   → `tab.here` { query, tab, url, title, visible, focused }
 *
 * Plain pub/sub, not RPC: an RPC takes the FIRST reply, and a discovery wants every tab's. This module is the protocol
 * and the relay side (Node-safe); the tab side is `answerTabDiscovery` in index.ts.
 */
import type { Hub } from "@brianjenkins94/hub";

export const TAB_DISCOVER = "tab.discover";
export const TAB_HERE = "tab.here";

/**
 * What a page expects of the relay it's linked to, as one number, sent with every tab answer. Bump it when pages start
 * relying on something an older debug-mcp doesn't do (page tools, preview apps as tabs, preview windows were each such
 * a step): a debug-mcp keeps running across upgrades, and an older one would otherwise ignore what it doesn't know
 * silently. It compares a page's number with its own and says when it's behind.
 *
 *   1 — the handshake itself.
 *   2 — a preview app's tab names its `scope` (its records are filed by window).
 *   3 — everything a tab exposes is a page tool (`page_eval`, `page_query` and the editor's debugger tools too): an
 *       older debug-mcp, with those as its own tools, can't reach them.
 */
export const OBSERVABILITY_PROTOCOL = 3;

export interface TabInfo {
	"tab": string;
	/** The address bar's URL (the top window's, when this tab's hub lives in a frame). */
	"url": string;
	"title": string;
	"visible": boolean;
	"focused": boolean;
	/** An app running in an editor preview: its own page (these are its URL and title), riding the editor tab's link. */
	"preview"?: boolean;
	/** For a preview app: the scope the editor files its records under — its preview window's id (`preview:5173~2`;
	 *  records from `preview:5173~2` and `preview:5173~2/<hub>`). Protocol 2. */
	"scope"?: string;
	/** The observability protocol the page speaks (OBSERVABILITY_PROTOCOL); absent from pages older than it. */
	"protocol"?: number;
	/** Set by the relay when the page speaks a newer protocol than it knows: what to do about it. */
	"outdated"?: string;
}

/** `tab`, marked `outdated` when it speaks a newer protocol than `known` (the relay's own). */
export function markOutdated(tab: TabInfo, known = OBSERVABILITY_PROTOCOL): TabInfo {
	return (tab.protocol ?? 0) > known
		? { ...tab, "outdated": `this page speaks observability protocol ${tab.protocol}; this debug-mcp knows ${known} — restart it (Claude Code restarts the one it runs) to see all the page offers` }
		: tab;
}

/**
 * The relay side: collect the tabs linked to `hub`. Resolves once `expected` tabs have answered (the relay knows how
 * many it's linked to), or after `timeoutMs` with whoever did — a linked page that isn't a tab never answers. Apps in
 * editor previews (`preview: true`) ride their editor tab's link, so they don't count towards `expected`; once it's
 * met, answers keep being collected for `graceMs` more, for them.
 */
export function discoverTabs(hub: Hub, expected: number, timeoutMs = 1000, graceMs = 0): Promise<TabInfo[]> {
	const query = Math.random().toString(36).slice(2);
	const found = new Map<string, TabInfo>();

	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			unsubscribe();
			resolve([...found.values()]);
		};
		let timer = setTimeout(finish, timeoutMs);
		const unsubscribe = hub.subscribe(TAB_HERE, (data) => {
			const { query: answering, ...info } = data as TabInfo & { "query"?: string };

			if (answering === query) {
				found.set(info.tab, info);

				if ([...found.values()].filter((tab) => tab.preview !== true).length >= expected) {
					clearTimeout(timer);
					timer = setTimeout(finish, graceMs);
				}
			}
		});

		if (expected === 0) {
			finish();

			return;
		}

		hub.publish(TAB_DISCOVER, { "query": query });
	});
}
