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
