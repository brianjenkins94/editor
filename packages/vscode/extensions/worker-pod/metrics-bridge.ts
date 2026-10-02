/**
 * The metrics plane (observability's metrics.ts), readable from VS Code's side.
 *
 * The pod is on the hub tree, so it hears every context's `$sys.metrics.<source>` and keeps the last few minutes of each.
 * The `editor.metrics.read` command hands them to any extension — the insights monitor reads it, with nothing of the
 * hub's — as `{ [source]: MetricsSample[] }`, oldest first, only those newer than `since` when it's given.
 */
import { METRICS_SUBJECT, MetricsHistory } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { podHub } from "./pod";

export function registerMetricsBridge(context: vscode.ExtensionContext): void {
	const history = new MetricsHistory();

	context.subscriptions.push(
		{ "dispose": podHub.subscribe(METRICS_SUBJECT + ".>", (data) => { history.add(data); }) },
		vscode.commands.registerCommand("editor.metrics.read", (since?: number) => history.read(typeof since === "number" ? since : undefined))
	);
}
