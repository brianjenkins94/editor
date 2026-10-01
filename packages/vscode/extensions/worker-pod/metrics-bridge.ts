/**
 * The metrics plane (observability's metrics.ts), readable from VS Code's side.
 *
 * The pod is on the hub tree, so it hears every context's `$sys.metrics.<source>` and keeps the last few minutes of each.
 * The `editor.metrics.read` command hands them to any extension — the insights monitor reads it, with nothing of the
 * hub's — as `{ [source]: MetricsSample[] }`, oldest first, only those newer than `since` when it's given.
 */
import type { MetricsSample } from "@brianjenkins94/observability";
import { METRICS_SUBJECT } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { podHub } from "./pod";

/** Samples kept per source: five minutes at the reporters' one a second. */
const KEEP = 300;

export function registerMetricsBridge(context: vscode.ExtensionContext): void {
	const history = new Map<string, MetricsSample[]>();

	context.subscriptions.push(
		{ "dispose": podHub.subscribe(METRICS_SUBJECT + ".>", (data) => {
			const sample = data as MetricsSample | null;

			if (typeof sample?.source !== "string" || typeof sample.t !== "number") {
				return;
			}

			const kept = history.get(sample.source) ?? [];

			kept.push(sample);

			if (kept.length > KEEP) {
				kept.shift();
			}

			history.set(sample.source, kept);
		}) },
		vscode.commands.registerCommand("editor.metrics.read", (since?: number) => {
			const out: Record<string, MetricsSample[]> = {};

			for (const [source, kept] of history) {
				out[source] = typeof since === "number" ? kept.filter((sample) => sample.t > since) : kept;
			}

			return out;
		})
	);
}
