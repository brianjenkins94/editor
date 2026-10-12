/**
 * What debug-mcp's own tools (one file per family here; index.ts lists them) are given: the collector and its store, and
 * the helpers a tool that takes a tab (`from`, its filter; `tab`, its target) needs — which link a tab's records arrive on, each row named by its tab, a preview
 * app narrowed to its own records — with the input schemas they share.
 */
import type { ok } from "@brianjenkins94/util/mcp/tool";
import type { DebugMcp } from "../server.ts";
import { fail } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

export const LEVEL = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const KIND = z.enum(["log", "span-open", "span-close"]);

export type ToolsContext = ReturnType<typeof createToolsContext>;

export function createToolsContext(debugMcp: DebugMcp) {
	const { store } = debugMcp;
	const FROM = z.string().optional().describe("Only this tab's records (a tab from tabs_list); omitted, every tab's. Each row names its tab: several tabs can have contexts of the same name.");

	/** The link a tab's records arrive on — asking the tabs if it isn't known yet. Throws for a tab that never connected. */
	async function linkFor(tab: string | undefined): Promise<string | undefined> {
		if (tab === undefined) {
			return undefined;
		}

		if (debugMcp.linkOf(tab) === undefined) {
			// Not learned yet (tabs map to links as they answer discovery): ask.
			await debugMcp.tabs();
		}

		const link = debugMcp.linkOf(tab);

		if (link === undefined) {
			throw new Error(`no tab "${tab}" has connected (tabs_list shows the ones that are)`);
		}

		return link;
	}

	/** Swap each row's link for its tab's id (asking the tabs once if a link's tab isn't known yet). */
	async function named<T extends { "link"?: string }>(rows: T[]): Promise<(Omit<T, "link"> & { "tab"?: string })[]> {
		if (rows.some((row) => row.link !== undefined && debugMcp.tabOf(row.link) === undefined)) {
			await debugMcp.tabs();
		}

		return rows.map(({ link, ...row }) => ({ ...row, ...link === undefined ? {} : { "tab": debugMcp.tabOf(link) ?? link } }));
	}

	/** Run a tool body that takes a `tab`, answering an unknown tab as the tool's error. */
	/** A preview app's tab rides its editor tab's link, so the link alone would give the editor's records too: narrow
	 *  to the app's own, by the scope it named (its window). */
	function scoped(tab: string | undefined): { "scope"?: string } {
		const scope = tab === undefined ? undefined : debugMcp.scopeOf(tab);

		return scope === undefined ? {} : { "scope": scope };
	}

	async function withTab(tab: string | undefined, body: (link: string | undefined) => ReturnType<typeof ok>): ReturnType<typeof ok> {
		let link: string | undefined;

		try {
			link = await linkFor(tab);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}

		return body(link);
	}

	return { "debugMcp": debugMcp, "store": store, "FROM": FROM, "linkFor": linkFor, "named": named, "scoped": scoped, "withTab": withTab };
}
