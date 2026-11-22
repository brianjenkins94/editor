import type { ArchReport } from "@brianjenkins94/observability";
import { collectArchReports, requestArchSync } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";
import { showUntilSeen } from "./output-shown";

const MESSAGES_MINUTES = 10;

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
