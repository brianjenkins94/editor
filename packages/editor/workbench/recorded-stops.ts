import type { LiveValue } from "@brianjenkins94/editor-api";
import type { RecordedStop, Replay, StopHit } from "@brianjenkins94/editor-api/recorded";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { createRpcClient } from "@brianjenkins94/hub";

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

const latest = new Map<string, { "port": number; "stops": RecordedStop[] }>();

interface Steppable { "stop": RecordedStop; "hit": StopHit & { "replay": Replay }; "port": number }

function steppable(): Steppable[] {
	return [...latest.values()].flatMap(({ port, stops }) => stops.flatMap((stop) => stop.hits.filter((hit): hit is StopHit & { "replay": Replay } => hit.replay !== undefined).map((hit) => ({ "stop": stop, "hit": hit, "port": port })))).reverse();
}

function labelOf({ stop, hit }: Steppable): string {
	return `${stop.where === "" ? "(top level)" : stop.where}${hit.event === undefined ? "" : ` · ${hit.event}`} #${String(hit.n)}`;
}

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

			return vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `${labelOf(chosen)} (recorded)`, "program": chosen.stop.file, "replay": { ...chosen.hit.replay, "source": answer.source }, "__port": chosen.port });
		});
	});

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

		if (hub.interested("$rpc.call.preview.stops")) {
			void log.span("editor.workbench.recorded-stops.place", { "count": Object.values(stops).flat().length }, async () => rpc.request("preview.stops", { "stops": stops }, { "timeoutMs": 10_000 })).catch(() => undefined);
		}
	};

	vscode.debug.onDidChangeBreakpoints(place);
	hub.subscribe("preview.ready", place);
	place();
}

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

export function stopValues(stop: RecordedStop, source: string): LiveValue[] {
	const at: [number, number] = [offsetOf(source, stop.at[0], stop.at[1]), offsetOf(source, stop.at[2], stop.at[3])];
	const value = (name: string, shown: string, turn: number): LiveValue => ({ "line": stop.at[0], "name": name, "value": shown, "kind": "bind", "call": 0, "turns": [turn], "at": at });

	return stop.hits.flatMap((hit, turn) => [
		...hit.event === undefined ? [] : [value("during", hit.event, turn)],
		...hit.values.map(([name, shown]) => value(name, shown, turn))
	]);
}

export interface RecordedStops { "dispose": () => void }

export function recordedStops(hub: Hub, log: Logger, port: number, tell: (event: "values", body: unknown) => void): RecordedStops {
	const rpc = createRpcClient(hub);
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

		const byFile = new Map<string, RecordedStop[]>();

		for (const stop of stops as RecordedStop[]) {
			byFile.set(stop.file, [...byFile.get(stop.file) ?? [], stop]);
		}

		for (const [file, fileStops] of byFile) {
			void log.span("editor.workbench.recorded-stops.report", { "port": port, "path": file, "count": fileStops.length }, async (span) => {
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
