/**
 * The monitor: the metrics plane drawn the way Monitor Pro draws a machine — a few numbers in the status bar, and a view of
 * sparkline cards. It reads samples through the `editor.metrics.read` command (served by whatever is on the hub — the
 * worker pod), so it uses nothing but VS Code's API, once a second.
 */
import type { MetricsSample } from "@brianjenkins94/observability";
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

	for (const [item, name] of [[memory, "Memory"], [workspace, "Workspace"], [longFrames, "Long frames"]] as const) {
		item.name = "Insights: " + name;
		item.command = "insights.monitor.focus";
	}

	const latest = (key: string): number | undefined => series.get(key)?.at(-1)?.[1];

	const showStatus = (): void => {
		const total = latest("workbench:memory.total");

		if (total !== undefined) {
			const realms = [...series.keys()].filter((key) => key.startsWith("workbench:memory.") && key !== "workbench:memory.total")
				.map((key) => [key.slice("workbench:memory.".length), latest(key) ?? 0] as const)
				.sort((a, b) => b[1] - a[1]);

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
	};

	const poll = async (): Promise<void> => {
		let fresh: Record<string, MetricsSample[]> | undefined;

		try {
			fresh = await vscode.commands.executeCommand<Record<string, MetricsSample[]>>("editor.metrics.read", since);
		} catch {
			return; // nothing on the hub serves it (yet)
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
		void view?.webview.postMessage({ "series": Object.fromEntries(series) });
	};

	const timer = setInterval(() => { void poll(); }, 1000);

	context.subscriptions.push(memory, workspace, longFrames, { "dispose": () => { clearInterval(timer); } }, vscode.window.registerWebviewViewProvider("insights.monitor", {
		"resolveWebviewView": (resolved) => {
			view = resolved;
			resolved.webview.options = { "enableScripts": true };
			resolved.webview.html = monitorHtml();
			resolved.onDidDispose(() => { view = undefined; });
			void resolved.webview.postMessage({ "series": Object.fromEntries(series) });
		}
	}));
}

function formatMB(mb: number): string {
	return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(mb >= 100 ? 0 : 1) + " MB";
}

/** The cards: plain SVG polylines over the last two minutes, coloured with the theme's chart colours. */
function monitorHtml(): string {
	const nonce = crypto.randomUUID().replaceAll("-", "");

	/* eslint-disable webawesome/no-html-in-strings, webawesome/no-css-in-strings -- a webview's own document, not the editor's chrome */
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { padding: 8px; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); }
.card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px 8px; margin-bottom: 8px; }
.head { display: flex; justify-content: space-between; text-transform: uppercase; letter-spacing: .04em; opacity: .85; margin-bottom: 4px; }
svg { width: 100%; height: 56px; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 4px; opacity: .9; }
.empty { opacity: .6; }
</style></head>
<body><div id="cards"><p class="empty">Waiting for metrics…</p></div>
<script nonce="${nonce}">
const COLORS = ["--vscode-charts-blue", "--vscode-charts-orange", "--vscode-charts-green", "--vscode-charts-purple", "--vscode-charts-red", "--vscode-charts-yellow"];
const CARDS = [
	{ "title": "Memory · MB", "match": /^workbench:memory\\.(.+)$/, "top": 6 },
	{ "title": "Workspace · MB used", "match": /^workbench:workspace\\.(usedMB)$/, "name": () => "used" },
	{ "title": "Long frames · %", "match": /^(\\w+):longFrames$/, "max": 100 },
	{ "title": "Hub · messages/s", "match": /^workbench:(hub)$/, "name": () => "workbench hub" },
	{ "title": "Storage · MB", "match": /^workbench:(storage)$/, "name": () => "origin" }
];
const fmt = (v) => v >= 100 ? v.toFixed(0) : v.toFixed(1);
function render(series) {
	const now = Math.max(0, ...Object.values(series).map((points) => points.at(-1)?.[0] ?? 0));
	const from = now - 120000;
	const html = CARDS.map((card) => {
		let lines = Object.entries(series).flatMap(([key, points]) => { const m = card.match.exec(key); return m ? [{ "name": card.name ? card.name(m[1]) : m[1], points }] : []; });
		lines.sort((a, b) => (b.points.at(-1)?.[1] ?? 0) - (a.points.at(-1)?.[1] ?? 0));
		if (card.top) lines = lines.slice(0, card.top);
		if (lines.length === 0) return "";
		const max = card.max ?? Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p[1]))) * 1.1;
		const paths = lines.map((line, i) => {
			const pts = line.points.filter((p) => p[0] >= from).map((p) => ((p[0] - from) / 1200).toFixed(1) + "," + (56 - (p[1] / max) * 54).toFixed(1)).join(" ");
			return '<polyline fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke="var(' + COLORS[i % COLORS.length] + ')" points="' + pts + '"/>';
		}).join("");
		const legend = lines.map((line, i) => '<span style="color: var(' + COLORS[i % COLORS.length] + ')">' + line.name + " " + fmt(line.points.at(-1)?.[1] ?? 0) + "</span>").join("");
		return '<div class="card"><div class="head"><span>' + card.title + '</span><span>max ' + fmt(max / (card.max ? 1 : 1.1)) + '</span></div><svg viewBox="0 0 100 56" preserveAspectRatio="none">' + paths + '</svg><div class="legend">' + legend + "</div></div>";
	}).join("");
	document.getElementById("cards").innerHTML = html || '<p class="empty">Waiting for metrics…</p>';
}
window.addEventListener("message", (event) => { if (event.data && event.data.series) render(event.data.series); });
</script></body></html>`;
	/* eslint-enable webawesome/no-html-in-strings, webawesome/no-css-in-strings */
}
