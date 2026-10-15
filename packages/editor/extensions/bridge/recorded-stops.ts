/**
 * Recorded stops (RUNNING.md, step 5): a breakpoint in a page's code records what's in scope each time its line runs —
 * a page can't stop, so it's a recorded stop, not a live one — and the notes margin shows it as it shows live values, a
 * column per time it ran. The editor's breakpoints go to every dev server (`preview.stops`: each re-instruments a file
 * whose stops changed, and hot-updates it); what a page reports (`stops.preview`) becomes the run contract's `values`
 * for the file, told by the preview's own run — its `production` session (production-adapter.ts) — each report every
 * hit so far (`replace`), anchored in the text of the version that ran (`preview.version`). The Margin shows them as
 * it shows any run's.
 *
 * The bridge's: a crossing, from the previews' hub to a debug session's events.
 */
import type { LiveValue } from "@brianjenkins94/editor-api";
import type { RecordedStop } from "@brianjenkins94/editor-api/recorded";
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { tellPreview } from "./production-adapter";

/** Each workspace file's breakpoints, enabled, as 1-based lines. */
function breakpointsOf(): Record<string, number[]> {
	const lines: Record<string, number[]> = {};

	for (const breakpoint of vscode.debug.breakpoints) {
		if (breakpoint instanceof vscode.SourceBreakpoint && breakpoint.enabled && breakpoint.location.uri.path.startsWith("/workspace/")) {
			const { path } = breakpoint.location.uri;

			lines[path] = [...lines[path] ?? [], breakpoint.location.range.start.line + 1];
		}
	}

	return lines;
}

/** The offset of a 0-based line and character in `source`. */
function offsetOf(source: string, line: number, character: number): number {
	let at = 0;

	for (let each = 0; each < line; each += 1) {
		const next = source.indexOf("\n", at);

		if (next === -1) {
			return source.length;
		}

		at = next + 1;
	}

	return at + character;
}

/** A stop's hits as the margin's values: each name in scope on the stop's line, a column (turn) per time it ran — what
 *  the page was handling first (`during`: an event's type), when it was. */
export function stopValues(stop: RecordedStop, source: string): LiveValue[] {
	const at: [number, number] = [offsetOf(source, stop.at[0], stop.at[1]), offsetOf(source, stop.at[2], stop.at[3])];

	return stop.hits.flatMap((hit, turn) => [
		...hit.event === undefined ? [] : [{ "line": stop.at[0], "name": "during", "value": hit.event, "kind": "bind" as const, "call": 0, "turns": [turn], "at": at }],
		...hit.values.map(([name, value]) => ({ "line": stop.at[0], "name": name, "value": value, "kind": "bind" as const, "call": 0, "turns": [turn], "at": at }))
	]);
}

export function registerRecordedStops(context: vscode.ExtensionContext, hub: Hub): void {
	const rpc = createRpcClient(hub);
	// The dev servers answer from the node worker, which may still be starting: asked again as the breakpoints change.
	const push = (): void => {
		void rpc.request("preview.stops", { "stops": breakpointsOf() }, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 }).catch(() => undefined);
	};

	push();
	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(push));

	// Each module version's text, asked of the dev server that instrumented it once (a hot update may replace it).
	const sources = new Map<string, Promise<string | undefined>>();
	const sourceOf = (port: number, version: string): Promise<string | undefined> => {
		let source = sources.get(version);

		if (source === undefined) {
			source = rpc.request("preview.version", { "port": port, "oid": version }, { "timeoutMs": 10_000, "waitForResponderMs": 5_000 }).then((answer) => (answer as { "source"?: string } | undefined)?.source, () => undefined);
			sources.set(version, source);
		}

		return source;
	};

	context.subscriptions.push({ "dispose": hub.subscribe("stops.preview", (data) => {
		const { window, stops } = (data ?? {}) as { "window"?: unknown; "stops"?: unknown };
		const port = Number(/^preview:(\d+)/u.exec(typeof window === "string" ? window : "")?.[1]);

		if (Number.isNaN(port) || !Array.isArray(stops)) {
			return;
		}

		// A report is the page's latest hits of every stop: each file's, in place of its last.
		const byFile = new Map<string, RecordedStop[]>();

		for (const stop of stops as RecordedStop[]) {
			byFile.set(stop.file, [...byFile.get(stop.file) ?? [], stop]);
		}

		for (const [file, fileStops] of byFile) {
			void (async () => {
				// The text of the version that ran last: its stops' (an earlier version's, from before a hot update, are
				// another text's).
				const { version } = fileStops.at(-1);
				const source = await sourceOf(port, version);

				if (source !== undefined) {
					tellPreview(port, "values", { "file": file, "source": source, "values": fileStops.filter((stop) => stop.version === version).flatMap((stop) => stopValues(stop, source)), "calls": [], "dropped": 0, "replace": true });
				}
			})();
		}
	}) });
}
