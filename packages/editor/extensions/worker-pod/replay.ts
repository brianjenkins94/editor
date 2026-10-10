/**
 * Stepping a recorded handler (RUNNING.md): a page's code can't stop, but a call of the function a recorded stop is in is
 * recorded whole — what it read from outside itself, `this`, its arguments, what each of its calls returned
 * (page-evidence.ts) — and *Step a Recorded Stop* runs it again in the debugger: a tsval session on that call
 * (extensions/tsval/debug-worker.ts `launchReplay`), stopping at the stop, stepped back and forth while the page has gone on.
 *
 * The pod hears what the preview pages report (`stops.preview`, as the margin does: recorded-stops.ts) and keeps each
 * file's latest; the text of the version that ran comes from the dev server that served it (`preview.version`).
 */
import * as vscode from "vscode";
import { createRpcClient } from "@brianjenkins94/hub";
import type { RecordedStop, Replay, StopHit } from "./page-evidence";
import { podHub } from "./pod";

/** A hit that can be stepped: its stop, the hit, and the preview port it came from. */
interface Steppable { "stop": RecordedStop; "hit": StopHit & { "replay": Replay }; "port": number }

/** Each file's latest recorded stops, with the port of the preview that reported them. */
const latest = new Map<string, { "port": number; "stops": RecordedStop[] }>();

/** Every hit that can be stepped, newest first. */
function steppable(): Steppable[] {
	return [...latest.values()].flatMap(({ port, stops }) => stops.flatMap((stop) => stop.hits.filter((hit): hit is StopHit & { "replay": Replay } => hit.replay !== undefined).map((hit) => ({ "stop": stop, "hit": hit, "port": port })))).reverse();
}

/** A hit as the picker shows it: where, what it was handling, which time. */
function labelOf({ stop, hit }: Steppable): string {
	return `${stop.where === "" ? "(top level)" : stop.where}${hit.event === undefined ? "" : " · " + hit.event} #${hit.n}`;
}

export function registerReplay(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);

	context.subscriptions.push({ "dispose": podHub.subscribe("stops.preview", (data) => {
		const { window, stops } = (data ?? {}) as { "window"?: unknown; "stops"?: unknown };
		const port = Number(/^preview:(\d+)/u.exec(typeof window === "string" ? window : "")?.[1]);

		if (!Number.isNaN(port) && Array.isArray(stops)) {
			for (const file of new Set((stops as RecordedStop[]).map((stop) => stop.file))) {
				latest.set(file, { "port": port, "stops": (stops as RecordedStop[]).filter((stop) => stop.file === file) });
			}
		}
	}) });

	// `{ file, n }`: that file's stop hit `n` (a script, a test); none, a pick of every hit that can be stepped.
	context.subscriptions.push(vscode.commands.registerCommand("tsval.stepRecordedStop", async (which?: { "file"?: string; "n"?: number }) => {
		const all = steppable();
		const chosen = which?.file !== undefined
			? all.find((each) => each.stop.file === which.file && (which.n === undefined || each.hit.n === which.n))
			: (await vscode.window.showQuickPick(all.map((each) => ({ "label": labelOf(each), "description": `${vscode.workspace.asRelativePath(each.stop.file)}:${each.stop.at[0] + 1}`, "each": each })), { "placeHolder": all.length === 0 ? "No recorded stops to step — set a breakpoint in an app's code and use the app" : "A recorded stop to step" }))?.each;

		if (chosen === undefined) {
			if (which?.file !== undefined) {
				void vscode.window.showErrorMessage(`Couldn't step: no recorded stop with its call in ${vscode.workspace.asRelativePath(which.file)}`);
			}

			return false;
		}

		const answer = await rpc.request("preview.version", { "port": chosen.port, "oid": chosen.stop.version }, { "timeoutMs": 10_000, "waitForResponderMs": 5_000 }).catch(() => undefined) as { "source"?: string } | undefined;

		if (answer?.source === undefined) {
			void vscode.window.showErrorMessage("Couldn't step: the text that ran isn't to hand (its dev server has stopped)");

			return false;
		}

		return vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `${labelOf(chosen)} (recorded)`, "program": chosen.stop.file, "replay": { ...chosen.hit.replay, "source": answer.source } });
	}));
}
