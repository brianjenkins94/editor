/**
 * The metrics plane (observability's metrics.ts), readable from VS Code's side.
 *
 * The bridge is on the hub tree, so it hears every context's `$sys.metrics.<source>` and keeps the last few minutes of each.
 * The `editor.metrics.read` command hands them to any extension — the insights extension's status bar reads it, with
 * nothing of the hub's — as `{ [source]: MetricsSample[] }`, oldest first, only those newer than `since` when it's given.
 * (Read once a second: counted by the plane, not spanned.)
 */
import { METRICS_SUBJECT, MetricsHistory } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";

export function registerMetricsBridge(context: vscode.ExtensionContext): void {
	const history = new MetricsHistory();

	context.subscriptions.push(
		{
			"dispose": bridgeHub.subscribe(METRICS_SUBJECT + ".>", (data) => { history.add(data); })
		},
		vscode.commands.registerCommand("editor.metrics.read", (since?: unknown) => history.read(typeof since === "number"
			? since
			: undefined))
	);
}
