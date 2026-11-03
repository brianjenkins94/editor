/**
 * The filesystems' calls one at a time, for a while, when asked (ARCHITECTURE.md, *Visibility*): the boundaries are
 * counted always (shared/fs-boundaries.ts, the metrics plane's `fs`), and a trace adds each call it sees — at one
 * boundary or all, of a path or every one — as a record in its span, `editor.workbench.fs-trace.window`, with its
 * operation, caller, path, time and bytes, and as a line in the Output channel "File Calls".
 *
 * - the command `editor.fs.trace` ("Trace File Calls…"): picks the boundary, a path to narrow it to and how long;
 * - `fs.trace` { boundary?, path?, seconds? }: the same, for agents' `files_trace`, answered at once.
 *
 * A call's own span isn't possible after the fact (a span starts when it's opened), so a call is a record in the
 * window's span; its time is the call's. One trace at a time, closing on its own.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { Call } from "../shared/fs-boundaries";
import { serve } from "@brianjenkins94/hub";
import { traceCalls } from "../shared/fs-boundaries";

/** How long a trace stays open, by default and at most. */
const TRACE_SECONDS = 30;
const TRACE_MOST = 300;

/** Calls written out per trace, at most: a load makes a hundred thousand; past it they're counted, not written. */
const MOST_CALLS = 10_000;

/** The boundaries, as the command offers them. */
const BOUNDARIES: Record<string, string> = {
	"provider": "VS Code's file service into the workspace",
	"node_modules": "VS Code's file service into node_modules",
	"zenfs": "the workspace's store",
	"zenfs-local": "the store's local folder",
	"indexeddb": "the write-back",
	"changes": "the change stream",
	"runtime-fs": "the workers' files, through the bridge"
};

/** What a trace is of: a boundary (every one, without), a path (every one, without) and how long. */
interface Asked { "boundary"?: string; "path"?: string; "seconds": number }

/** A call as its line in the Output channel. */
function lineOf(call: Call): string {
	const time = new Date().toISOString().slice(11, 23);

	return `${time} ${call.boundary} ${call.operation} ${call.caller} ${call.path ?? ""} ${call.ms.toFixed(1)} ms${call.bytes > 0 ? ` ${String(call.bytes)} B` : ""}`;
}

export function installFsTrace(hub: Hub, vscode: typeof vscodeApi, log: Logger): void {
	const output = vscode.window.createOutputChannel("File Calls");
	let open: { "until": number } | undefined;

	const trace = ({ boundary, path, seconds }: Asked): { "tracing": string; "until": string } => {
		if (open !== undefined) {
			throw new Error(`a trace is open until ${new Date(open.until).toISOString()}`);
		}

		const lasting = Math.min(seconds > 0 ? seconds : TRACE_SECONDS, TRACE_MOST);
		const until = Date.now() + lasting * 1000;
		const what = `${boundary ?? "every boundary"}${path === undefined ? "" : ", paths with " + path}`;
		const span = log.span("editor.workbench.fs-trace.window", { "boundary": boundary ?? "all", "path": path ?? "", "seconds": lasting });
		let calls = 0;
		// (what writing a call out does itself isn't the trace's)
		let seeing = false;

		open = { "until": until };
		output.appendLine(`— ${what}, for ${String(lasting)} s`);

		const stop = traceCalls((call) => {
			if (seeing || (boundary !== undefined && call.boundary !== boundary) || (path !== undefined && call.path?.includes(path) !== true)) {
				return;
			}

			calls += 1;

			if (calls > MOST_CALLS) {
				return;
			}

			seeing = true;

			try {
				span.info(call.boundary + " " + call.operation, { ...call });
				output.appendLine(lineOf(call));
			} finally {
				seeing = false;
			}
		});

		setTimeout(() => {
			stop();
			open = undefined;
			output.appendLine(`— ${String(calls)} calls${calls > MOST_CALLS ? `, the first ${String(MOST_CALLS)} written` : ""}`);
			span.end({ "count": calls });
		}, lasting * 1000);

		return { "tracing": what, "until": new Date(until).toISOString() };
	};

	vscode.commands.registerCommand("editor.fs.trace", async () => {
		const picked = await vscode.window.showQuickPick([
			{ "label": "every boundary", "boundary": undefined },
			...Object.keys(BOUNDARIES).map((name) => ({ "label": name, "description": BOUNDARIES[name], "boundary": name }))
		], { "title": "Trace File Calls", "placeHolder": "Which boundary's calls" });

		if (picked === undefined) {
			return;
		}

		const path = await vscode.window.showInputBox({ "title": "Trace File Calls", "prompt": "Only the calls whose path has this (empty: every path)" });

		if (path === undefined) {
			return;
		}

		const seconds = await vscode.window.showInputBox({ "title": "Trace File Calls", "prompt": `For how many seconds (at most ${String(TRACE_MOST)})`, "value": String(TRACE_SECONDS), "validateInput": (value) => (Number(value) > 0 ? undefined : "A number of seconds") });

		if (seconds === undefined) {
			return;
		}

		try {
			trace({ "boundary": picked.boundary, "path": path === "" ? undefined : path, "seconds": Number(seconds) });
			output.show(true);
		} catch (error) {
			void vscode.window.showWarningMessage("Trace File Calls: " + (error instanceof Error ? error.message : String(error)));
		}
	});

	serve(hub, "fs.trace", (args) => {
		const { boundary, path, seconds } = (args ?? {}) as { "boundary"?: unknown; "path"?: unknown; "seconds"?: unknown };

		if ((boundary !== undefined && typeof boundary !== "string") || (path !== undefined && typeof path !== "string")) {
			throw new TypeError("fs.trace takes { boundary?, path?, seconds? }: a boundary (provider, zenfs, runtime-fs…), text its paths have, how long");
		}

		return { ...trace({ "boundary": boundary, "path": path, "seconds": typeof seconds === "number" ? seconds : TRACE_SECONDS }), "read": "logs_query (source workbench): each call a record \"<boundary> <operation>\" in the span editor.workbench.fs-trace.window; or the Output channel \"File Calls\"" };
	});
}
