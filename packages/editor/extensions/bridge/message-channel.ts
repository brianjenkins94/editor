/**
 * The messages between the editor's contexts, as a person reads them (CLAUDE.md, *Agent tools*: what agents'
 * `payloads_capture` turns on and `architecture_state` reads from outside). *Developer: Show the Editor's Messages*
 * writes each message the architecture plane samples — between hubs, workers, windows, sockets, BroadcastChannels, Web
 * Locks, WebRTC — to the Output channel "Editor Messages" as it comes: when, its kind, from and to, what it was (a hub
 * message's subject), its size, and what it carried, cut short. The Output view's filter finds a context or a subject.
 * Not the extension host's writes to the Output and its logs: this channel's own lines go that way, and each would show
 * itself.
 *
 * Payload capture is on while it shows: what it carried is the app's data, so it's off by default, and it's turned on in
 * every context for MESSAGES_MINUTES from when it's asked (asked again, from then), or until *Developer: Stop the Editor's
 * Messages*, then off — the one switch, which an agent's `payloads_capture` turns too.
 */
import type { ArchReport } from "@brianjenkins94/observability";
import { collectArchReports, requestArchSync } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";
import { showUntilSeen } from "./output-shown";

const MESSAGES_MINUTES = 10;

/** The extension host's calls to the Output and its loggers, and their acks, by the label they're sampled under. */
const OUTPUT_ITSELF = /OutputService\.|MainThreadLogger\./u;

export function registerMessageChannel(context: vscode.ExtensionContext): void {
	let channel: vscode.LogOutputChannel | undefined;
	let collecting: (() => void) | undefined;
	let ending: ReturnType<typeof setTimeout> | undefined;

	const stop = (): void => {
		clearTimeout(ending);

		if (collecting !== undefined) {
			collecting();
			collecting = undefined;
			requestArchSync(bridgeHub, { "capture": false });
		}
	};

	context.subscriptions.push(
		{ "dispose": stop },
		vscode.commands.registerCommand("editor.messages.stop", () => {
			if (collecting !== undefined) {
				stop();
				channel?.info("Stopped, and payload capture with it.");
			}
		}),
		vscode.commands.registerCommand("editor.messages.show", () => {
			// (a log channel: the Output view's filter works on those)
			channel ??= vscode.window.createOutputChannel("Editor Messages", { "log": true });
			showUntilSeen(channel);

			if (collecting === undefined) {
				const to = channel;

				to.info(`Showing the messages between the editor's contexts, and what each carried, for ${String(MESSAGES_MINUTES)} minutes.`);
				collecting = collectArchReports(bridgeHub, (report: ArchReport) => {
					for (const sample of (report.samples ?? []).filter(({ label }) => !OUTPUT_ITSELF.test(label))) {
						const line = `[${sample.kind}] ${sample.from} → ${sample.to}: ${sample.label} (${String(sample.bytes)} B)${sample.payload === undefined
							? ""
							: ` ${sample.payload}`}`;

						if (sample.kind === "error") {
							to.error(line);
						} else {
							to.info(line);
						}
					}
				});
				// (the subscription's interest reaches the other hubs before they're asked: architecture-store.ts)
				setTimeout(() => {
					requestArchSync(bridgeHub, { "capture": true });
				}, 200);
			}

			clearTimeout(ending);
			ending = setTimeout(() => {
				stop();
				channel?.info(`Stopped after ${String(MESSAGES_MINUTES)} minutes, and payload capture with it: Developer: Show the Editor's Messages goes on.`);
			}, MESSAGES_MINUTES * 60_000);
		})
	);
}
