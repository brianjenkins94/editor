/**
 * An output channel shown, and shown again until it's on screen (log-channel.ts, message-channel.ts). In an editor that's
 * still starting, a slow machine's first seconds, the show is lost: the Output opens on nothing, or doesn't open, and
 * nothing asks again (found 2026-11-20 in fresh editors on CI and with the CPU four times slower here; a person asking
 * that early meets the same). Its editor among the visible ones (`output:` and the channel's name) says it's there; asked
 * again each SHOW_AGAIN_MS until then, for SHOW_FOR_MS at most, and not after: a person who looks elsewhere isn't followed.
 */
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
