/**
 * Recorded stops (RUNNING.md, *Apps: recorded stops, not live ones*): a breakpoint in a page's code records what's in
 * scope each time its line runs (a page can't stop), and the Margin shows it as it shows a run's live values, a column per
 * time it ran.
 *
 * The editor's breakpoints go to every dev server as they change and as each comes up (`preview.stops`, the node worker:
 * each re-instruments a file whose stops changed, and hot-updates it). Read from VS Code, not given by DAP: a dev server's
 * session is a no-debug one, which isn't given breakpoints. What its pages report (`stops.preview`, each report every hit
 * so far) the dev server's session in Run and Debug (preview-session.ts) tells the Margin as its `values` for the file
 * (`replace`), anchored in the text of the version that ran (`preview.version`).
 *
 * And a recorded call stepped again (RUNNING.md: stepping a recorded handler): the page records, with a stop's latest hits,
 * the call of the function it's in, whole (page-evidence.ts), and *Step a Recorded Stop* (`tsval.stepRecordedStop`, in
 * the lightbulb on the stop's line too) runs it in the tsval debugger (extensions/tsval/replay-run.ts), stopping at the stop,
 * stepped back and forth while the page has gone on.
 */
import type { LiveValue } from "@brianjenkins94/editor-api";
import type { RecordedStop, Replay, StopHit } from "@brianjenkins94/editor-api/recorded";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { createRpcClient } from "@brianjenkins94/hub";

/** Each workspace file's breakpoints, enabled, as 1-based lines. */
function breakpointsOf(vscode: typeof vscodeApi): Record<string, number[]> {
	const lines: Record<string, number[]> = {};

	for (const breakpoint of vscode.debug.breakpoints) {
		if (breakpoint instanceof vscode.SourceBreakpoint && breakpoint.enabled && breakpoint.location.uri.path.startsWith("/workspace/")) {
			const { path } = breakpoint.location.uri;

			lines[path] = [...lines[path] ?? [], breakpoint.location.range.start.line + 1];
		}
	}

	return lines;
}

/** Each file's latest recorded stops, with the port of the dev server whose page reported them. */
const latest = new Map<string, { "port": number; "stops": RecordedStop[] }>();

/** A hit that can be stepped: its stop, the hit, and the port of the dev server whose page it came from. */
interface Steppable { "stop": RecordedStop; "hit": StopHit & { "replay": Replay }; "port": number }

/** Every hit that can be stepped (the latest few of each stop keep their call), newest first. */
function steppable(): Steppable[] {
	return [...latest.values()].flatMap(({ port, stops }) => stops.flatMap((stop) => stop.hits.filter((hit): hit is StopHit & { "replay": Replay } => hit.replay !== undefined).map((hit) => ({ "stop": stop, "hit": hit, "port": port })))).reverse();
}

/** A hit as it's offered: where, what it was handling, which time. */
function labelOf({ stop, hit }: Steppable): string {
	return `${stop.where === "" ? "(top level)" : stop.where}${hit.event === undefined ? "" : ` · ${hit.event}`} #${String(hit.n)}`;
}

/** The editor's breakpoints, to every dev server: now, as they change, and as each comes up (`preview.ready`). And
 *  *Step a Recorded Stop*. */
export function installRecordedStops(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);

	hub.subscribe("stops.preview", (data) => {
		const { port, stops } = (data ?? {}) as { "port"?: unknown; "stops"?: unknown };

		if (typeof port === "number" && Array.isArray(stops)) {
			for (const file of new Set((stops as RecordedStop[]).map((stop) => stop.file))) {
				latest.set(file, { "port": port, "stops": (stops as RecordedStop[]).filter((stop) => stop.file === file) });
			}
		}
	});

	// `{ file, n }`: that file's stop hit `n` (the lightbulb's, a script's); none, a pick of every hit that can be stepped.
	vscode.commands.registerCommand("tsval.stepRecordedStop", async (which?: { "file"?: string; "n"?: number }) => {
		const all = steppable();
		const chosen = which?.file === undefined
			? (await vscode.window.showQuickPick(all.map((each) => ({ "label": labelOf(each), "description": `${vscode.workspace.asRelativePath(each.stop.file)}:${String(each.stop.at[0] + 1)}`, "each": each })), { "placeHolder": all.length === 0 ? "No recorded stops to step: set a breakpoint in an app's code, and use the app" : "A recorded stop to step" }))?.each
			: all.find((each) => each.stop.file === which.file && (which.n === undefined || each.hit.n === which.n));

		if (chosen === undefined) {
			if (which?.file !== undefined) {
				void vscode.window.showErrorMessage(`Couldn't step: no recorded stop with its call in ${vscode.workspace.asRelativePath(which.file)}`);
			}

			return false;
		}

		return log.span("editor.workbench.recorded-stops.step", { "path": chosen.stop.file, "count": chosen.hit.replay.calls.length }, async () => {
			const answer = await rpc.request("preview.version", { "port": chosen.port, "oid": chosen.stop.version }, { "timeoutMs": 10_000, "waitForResponderMs": 5000 }).catch(() => undefined) as { "source"?: string } | undefined;

			if (answer?.source === undefined) {
				void vscode.window.showErrorMessage("Couldn't step: the text that ran isn't to hand (its dev server has stopped)");

				return false;
			}

			return vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `${labelOf(chosen)} (recorded)`, "program": chosen.stop.file, "replay": { ...chosen.hit.replay, "source": answer.source } });
		});
	});

	// On the stop's line, its latest call to step.
	vscode.languages.registerCodeActionsProvider({ "scheme": "file" }, {
		"provideCodeActions": (document, range) => {
			const here = steppable().find(({ stop }) => stop.file === document.uri.path && stop.at[0] === range.start.line);

			if (here === undefined) {
				return [];
			}

			const action = new vscode.CodeAction(`Step the call this stop recorded (${labelOf(here)})`, vscode.CodeActionKind.Empty);

			action.command = { "title": action.title, "command": "tsval.stepRecordedStop", "arguments": [{ "file": here.stop.file, "n": here.hit.n }] };

			return [action];
		}
	});
	const place = (): void => {
		const stops = breakpointsOf(vscode);

		// (the node worker starts with the first dev server: before then, nobody to tell, and it's told as one comes up)
		if (hub.interested("$rpc.call.preview.stops")) {
			void log.span("editor.workbench.recorded-stops.place", { "count": Object.values(stops).flat().length }, async () => rpc.request("preview.stops", { "stops": stops }, { "timeoutMs": 10_000 })).catch(() => undefined);
		}
	};

	vscode.debug.onDidChangeBreakpoints(place);
	hub.subscribe("preview.ready", place);
	place();
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

/** A stop's hits as the Margin's values: each name in scope on the stop's line, a column (turn) per time it ran, and
 *  what the page was handling first (`during`: an event's type). */
export function stopValues(stop: RecordedStop, source: string): LiveValue[] {
	const at: [number, number] = [offsetOf(source, stop.at[0], stop.at[1]), offsetOf(source, stop.at[2], stop.at[3])];
	const value = (name: string, shown: string, turn: number): LiveValue => ({ "line": stop.at[0], "name": name, "value": shown, "kind": "bind", "call": 0, "turns": [turn], "at": at });

	return stop.hits.flatMap((hit, turn) => [
		...hit.event === undefined ? [] : [value("during", hit.event, turn)],
		...hit.values.map(([name, shown]) => value(name, shown, turn))
	]);
}

export interface RecordedStops { "dispose": () => void }

/** The recorded stops of the dev server on `port`: what its pages report, told as `values` (`tell`). */
export function recordedStops(hub: Hub, log: Logger, port: number, tell: (event: "values", body: unknown) => void): RecordedStops {
	const rpc = createRpcClient(hub);
	// Each module version's text, asked of the dev server that instrumented it once (a hot update may replace it).
	const sources = new Map<string, Promise<string | undefined>>();
	const sourceOf = (version: string): Promise<string | undefined> => {
		let source = sources.get(version);

		if (source === undefined) {
			source = rpc.request("preview.version", { "port": port, "oid": version }, { "timeoutMs": 10_000, "waitForResponderMs": 5000 }).then((answer) => (answer as { "source"?: string } | undefined)?.source, () => undefined);
			sources.set(version, source);
		}

		return source;
	};

	const off = hub.subscribe("stops.preview", (data) => {
		const { "port": from, stops } = (data ?? {}) as { "port"?: unknown; "stops"?: unknown };

		if (from !== port || !Array.isArray(stops)) {
			return;
		}

		// A report is the page's latest hits of every stop: each file's, in place of its last.
		const byFile = new Map<string, RecordedStop[]>();

		for (const stop of stops as RecordedStop[]) {
			byFile.set(stop.file, [...byFile.get(stop.file) ?? [], stop]);
		}

		for (const [file, fileStops] of byFile) {
			void log.span("editor.workbench.recorded-stops.report", { "port": port, "path": file, "count": fileStops.length }, async (span) => {
				// The text of the version that ran last: its stops' (an earlier version's, from before a hot update, are
				// another text's).
				const { version } = fileStops.at(-1)!;
				const source = await sourceOf(version);

				if (source !== undefined) {
					const values = fileStops.filter((stop) => stop.version === version).flatMap((stop) => stopValues(stop, source));

					tell("values", { "file": file, "source": source, "values": values, "calls": [], "dropped": 0, "replace": true });
					span.end({ "values": values.length });
				}
			});
		}
	});

	return { "dispose": off };
}
