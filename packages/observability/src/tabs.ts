/**
 * Tab discovery — so a relay linked to several tabs at once (debug-mcp links every open tab, each as its own tree) can
 * learn which tabs are there and address one. A tab serves its page tools under its id (`page_eval.<tab>`, see
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

export interface TabInfo {
	"tab": string;
	/** The address bar's URL (the top window's, when this tab's hub lives in a frame). */
	"url": string;
	"title": string;
	"visible": boolean;
	"focused": boolean;
	/** An app running in an editor preview: its own page (these are its URL and title), riding the editor tab's link. */
	"preview"?: boolean;
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
