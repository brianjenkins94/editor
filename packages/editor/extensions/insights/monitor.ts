import type { MetricsSample } from "@brianjenkins94/observability";
import * as vscode from "vscode";

const KEEP = 120;

const DRAWN = 40;

const BARS = "▁▂▃▄▅▆▇";

type Series = Map<string, [number, number][]>;

function formatMB(mb: number): string {
	if (mb >= 1024) {
		return `${(mb / 1024).toFixed(2)} GB`;
	}

	return `${mb.toFixed(mb >= 100
		? 0
		: 1)} MB`;
}

function sparkline(points: [number, number][] | undefined, fromLowest = false): string {
	const values = (points ?? []).slice(-DRAWN).map(([, value]) => value);

	if (values.length === 0) {
		return "";
	}

	const high = Math.max(...values);
	const lowest = Math.min(...values);
	const range = fromLowest
		? Math.max(high - lowest, high * 0.2)
		: high;
	const low = fromLowest
		? (high + lowest - range) / 2
		: 0;

	return values.map((value) => BARS[range <= 0
		? 0
		: Math.round(((value - low) / range) * (BARS.length - 1))]).join("");
}

export function registerMonitor(context: vscode.ExtensionContext): void {
	const series: Series = new Map();
	let since: number | undefined;

	const memory = vscode.window.createStatusBarItem("insights.memory", vscode.StatusBarAlignment.Right, 100);
	const workspace = vscode.window.createStatusBarItem("insights.workspace", vscode.StatusBarAlignment.Right, 99);
	const longFrames = vscode.window.createStatusBarItem("insights.longFrames", vscode.StatusBarAlignment.Right, 98);
	const spanErrors = vscode.window.createStatusBarItem("insights.spanErrors", vscode.StatusBarAlignment.Right, 97);

	for (const [item, name] of [
		[memory, "Memory"],
		[workspace, "Workspace"],
		[longFrames, "Long frames"],
		[spanErrors, "Failing spans"]
	] as const) {
		item.name = `Performance: ${name}`;
	}

	const latest = (key: string): number | undefined => series.get(key)?.at(-1)?.[1];
	const hover = (title: string, key: string, lines: string[] = [], fromLowest = false): vscode.MarkdownString => {
		const markdown = new vscode.MarkdownString(`**${title}**\n\n`);

		markdown.appendCodeblock(sparkline(series.get(key), fromLowest), "text");
		markdown.appendMarkdown(`*the last ${String(Math.min(DRAWN, series.get(key)?.length ?? 0))} readings*${lines.length === 0
			? ""
			: `\n\n${lines.join("  \n")}`}`);

		return markdown;
	};

	const showStatus = (): void => {
		const total = latest("workbench:memory.total");

		if (total !== undefined) {
			const realms = [
				...series.keys()
			].filter((key) => key.startsWith("workbench:memory.") && key !== "workbench:memory.total").map((key) => [
				key.slice("workbench:memory.".length),
				latest(key) ?? 0
			] as const).toSorted((left, right) => right[1] - left[1]);

			memory.text = `$(pulse) ${formatMB(total)}`;
			memory.tooltip = hover(`Memory, the whole tab: ${formatMB(total)}`, "workbench:memory.total", realms.map(([realm, mb]) => `${realm}: ${formatMB(mb)}`), true);
			memory.show();
		}

		const used = latest("workbench:workspace.usedMB");
		const size = latest("workbench:workspace.totalMB");

		if (used !== undefined && size !== undefined) {
			workspace.text = `$(database) ${formatMB(used)} / ${formatMB(size)}`;
			workspace.tooltip = hover(`Workspace file system: ${(latest("workbench:workspace.percent") ?? 0).toFixed(1)}% full`, "workbench:workspace.usedMB", [], true);
			workspace.show();
		}

		const workbench = latest("workbench:longFrames") ?? 0;
		const shell = latest("shell:longFrames") ?? 0;

		longFrames.text = `$(watch) ${Math.max(workbench, shell).toFixed(0)}%`;
		longFrames.tooltip = hover("Time in long frames (over 50 ms), each second", workbench >= shell
			? "workbench:longFrames"
			: "shell:longFrames", [`workbench: ${workbench.toFixed(0)}%`, `shell (the preview windows): ${shell.toFixed(0)}%`]);
		longFrames.show();

		const failing = [
			...series.keys()
		].filter((key) => key.startsWith("root:spans.") && key.endsWith(".errors")).map((key) => [
			key,
			key.slice("root:spans.".length, -".errors".length),
			latest(key) ?? 0
		] as const).filter(([, , count]) => count > 0).toSorted((left, right) => right[2] - left[2]);

		if (failing.length > 0) {
			spanErrors.text = `$(error) ${String(failing.reduce((sum, [, , count]) => sum + count, 0))}`;
			spanErrors.tooltip = hover("Spans that ended with an error, last 10 s", failing[0][0], failing.map(([, name, count]) => `${name}: ${String(count)}`));
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
			return; // nothing serves it (yet)
		}

		for (const [key, points] of series) {
			if ((points.at(-1)?.[0] ?? 0) < Date.now() - KEEP * 1000) {
				series.delete(key);
			}
		}

		for (const samples of Object.values(fresh ?? {})) {
			for (const sample of samples) {
				since = Math.max(since ?? 0, sample.t);

				for (const [name, value] of Object.entries(sample.values)) {
					const key = `${sample.source}:${name}`;
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
	};

	const timer = setInterval(() => {
		void poll();
	}, 1000);

	context.subscriptions.push(memory, workspace, longFrames, spanErrors, {
		"dispose": () => {
			clearInterval(timer);
		}
	});
}
