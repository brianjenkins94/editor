/**
 * The monitor: the metrics plane drawn the way Monitor Pro draws a machine — a few numbers in the status bar, and a view of
 * sparkline cards. It reads samples through the `editor.metrics.read` command (served by whatever is on the hub — the
 * worker pod), so it uses nothing but VS Code's API, once a second. The cards are its webview's: monitor-view.ts.
 */
import type { MetricsSample } from "@brianjenkins94/observability";
import type { MonitorMessage } from "./monitor-view";
import * as vscode from "vscode";

/** Points kept per series: two minutes at one a second. */
const KEEP = 120;

/** `source:name` → [t, value] points, oldest first. */
type Series = Map<string, [number, number][]>;

export function registerMonitor(context: vscode.ExtensionContext): void {
	const series: Series = new Map();
	let since: number | undefined;
	let view: vscode.WebviewView | undefined;

	const memory = vscode.window.createStatusBarItem("insights.memory", vscode.StatusBarAlignment.Right, 100);
	const workspace = vscode.window.createStatusBarItem("insights.workspace", vscode.StatusBarAlignment.Right, 99);
	const longFrames = vscode.window.createStatusBarItem("insights.longFrames", vscode.StatusBarAlignment.Right, 98);
	const spanErrors = vscode.window.createStatusBarItem("insights.spanErrors", vscode.StatusBarAlignment.Right, 97);

	for (const [item, name] of [[memory, "Memory"], [workspace, "Workspace"], [longFrames, "Long frames"], [spanErrors, "Span errors"]] as const) {
		item.name = "Insights: " + name;
		item.command = "insights.monitor.focus";
	}

	const latest = (key: string): number | undefined => series.get(key)?.at(-1)?.[1];

	const showStatus = (): void => {
		const total = latest("workbench:memory.total");

		if (total !== undefined) {
			const realms = [...series.keys()].filter((key) => key.startsWith("workbench:memory.") && key !== "workbench:memory.total").map((key) => [key.slice("workbench:memory.".length), latest(key) ?? 0] as const).sort((left, right) => right[1] - left[1]);

			memory.text = "$(pulse) " + formatMB(total);
			memory.tooltip = "Memory, the whole tab\n\n" + realms.map(([realm, mb]) => `${realm}: ${formatMB(mb)}`).join("\n");
			memory.show();
		}

		const used = latest("workbench:workspace.usedMB");
		const size = latest("workbench:workspace.totalMB");

		if (used !== undefined && size !== undefined) {
			workspace.text = "$(database) " + formatMB(used) + " / " + formatMB(size);
			workspace.tooltip = "Workspace file system: " + (latest("workbench:workspace.percent") ?? 0).toFixed(1) + "% full";
			workspace.show();
		}

		const busy = Math.max(latest("workbench:longFrames") ?? 0, latest("shell:longFrames") ?? 0);

		longFrames.text = "$(watch) " + busy.toFixed(0) + "%";
		longFrames.tooltip = "Time in long animation frames (over 50 ms) in the last second — workbench " + (latest("workbench:longFrames") ?? 0).toFixed(0) + "%, shell " + (latest("shell:longFrames") ?? 0).toFixed(0) + "%";
		longFrames.show();

		// Failing operations — a CDN fetch, a type acquisition, an LSP request — show up here only while they fail.
		const failing = [...series.keys()].filter((key) => key.startsWith("root:spans.") && key.endsWith(".errors")).map((key) => [key.slice("root:spans.".length, -".errors".length), latest(key) ?? 0] as const).filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]);

		if (failing.length > 0) {
			spanErrors.text = "$(error) " + failing.reduce((sum, [, count]) => sum + count, 0);
			spanErrors.tooltip = "Spans that ended with an error, last 10 s\n\n" + failing.map(([name, count]) => `${name}: ${count}`).join("\n");
			spanErrors.show();
		} else {
			spanErrors.hide();
		}
	};

	const poll = async (): Promise<void> => {
		let fresh: Record<string, MetricsSample[]> | undefined;

		try {
			fresh = await vscode.commands.executeCommand<Record<string, MetricsSample[]>>("editor.metrics.read", since);
		} catch {
			return; // nothing on the hub serves it (yet)
		}

		// A series with no reading in the window has gone (a span name idles out of the span metrics).
		for (const [key, points] of series) {
			if ((points.at(-1)?.[0] ?? 0) < Date.now() - KEEP * 1000) {
				series.delete(key);
			}
		}

		for (const samples of Object.values(fresh ?? {})) {
			for (const sample of samples) {
				since = Math.max(since ?? 0, sample.t);

				for (const [name, value] of Object.entries(sample.values)) {
					const key = sample.source + ":" + name;
					const points = series.get(key) ?? [];

					points.push([sample.t, value]);

					if (points.length > KEEP) {
						points.shift();
					}

					series.set(key, points);
				}
			}
		}

		showStatus();
		void view?.webview.postMessage({ "series": Object.fromEntries(series) } satisfies MonitorMessage);
	};

	const timer = setInterval(() => {
		void poll();
	}, 1000);

	context.subscriptions.push(memory, workspace, longFrames, spanErrors, { "dispose": () => {
		clearInterval(timer);
	} }, vscode.window.registerWebviewViewProvider("insights.monitor", {
		"resolveWebviewView": async (resolved) => {
			resolved.webview.options = { "enableScripts": true };
			resolved.webview.html = await page(context);
			view = resolved;
			resolved.onDidDispose(() => {
				view = undefined;
			});
			void resolved.webview.postMessage({ "series": Object.fromEntries(series) } satisfies MonitorMessage);
		}
	}));
}

function formatMB(mb: number): string {
	return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(mb >= 100 ? 0 : 1) + " MB";
}

/** The view's page: its script (monitor-view.ts, the cards) inline — a webview here can't load its resources by URL —
 *  behind a strict policy. */
async function page(context: vscode.ExtensionContext): Promise<string> {
	const script = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, "monitor-view.js")));
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const policy = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;

	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><script nonce="${nonce}">${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}
