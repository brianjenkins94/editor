/** The tabs connected now. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";

/** How long a listing waits for every linked tab to answer: a page that's busy (loading, a long task) answers late. */
const TABS_MS = 5000;
/** How long a tab that went stays listed. */
const GONE_LISTED_MS = 10 * 60_000;

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "tabs_list",
	"config": {
		"title": "List tabs",
		"description": "The editor tabs connected right now: [{ tab, url, title, visible, focused }]. The page and debugger tools act on one tab — pass its `tab` when several are connected. A tab linked that didn't answer within 5 s (its page busy: loading, a long task) is { silent: true } rather than left out: ask again. Then the tabs that went in the last 10 minutes, newest last: { tab, url, title, gone: \"left\" (reloaded, closed or navigated: its page said so) | \"crashed\" (its link dropped without a word: its renderer died — out of memory, say — or it was closed without running its unload, as Playwright's page.close() does) | \"unknown\" (a page too old to say), ago }; a reloaded tab is back under a new id.",
		"inputSchema": {}
	},
	"handler": async () => {
		const tabs = await debugMcp.tabs(TABS_MS);
		// (each link is an editor tab; an app in one of its previews answers over its tab's link)
		const silent = Math.max(0, debugMcp.linkCount() - tabs.filter((tab) => tab.preview !== true).length);

		const now = Date.now();
		const gone = debugMcp.gone().filter((went) => now - went.at <= GONE_LISTED_MS).map((went) => ({ "tab": went.tab, "url": went.url, "title": went.title, "gone": went.how, "ago": `${String(Math.round((now - went.at) / 1000))} s` }));

		return ok([...tabs, ...Array.from({ "length": silent }, () => ({ "silent": true, "said": `linked, and didn't answer within ${String(TABS_MS / 1000)} s: its page is busy (loading, a long task) — ask again` })), ...gone]);
	}
})];
