import * as vscode from "vscode";

const SHOW_AGAIN_MS = 1000;
const SHOW_FOR_MS = 60_000;

export function showUntilSeen(channel: vscode.OutputChannel): void {
	const seen = (): boolean => vscode.window.visibleTextEditors.some(({ document }) => document.uri.scheme === "output" && decodeURIComponent(document.uri.toString()).includes(channel.name));
	const until = Date.now() + SHOW_FOR_MS;

	channel.show(true);

	const again = setInterval(() => {
		if (seen() || Date.now() > until) {
			clearInterval(again);
		} else {
			channel.show(true);
		}
	}, SHOW_AGAIN_MS);
}
