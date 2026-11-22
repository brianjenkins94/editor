import { installHubCollector } from "@brianjenkins94/observability";
import { renderRecord } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";
import { showUntilSeen } from "./output-shown";

const LOG_MINUTES = 10;

export function registerLogChannel(context: vscode.ExtensionContext): void {
	let channel: vscode.LogOutputChannel | undefined;
	let collecting: (() => void) | undefined;
	let ending: ReturnType<typeof setTimeout> | undefined;

	const stop = (): void => {
		clearTimeout(ending);
		collecting?.();
		collecting = undefined;
	};

	context.subscriptions.push(
		{ "dispose": stop },
		vscode.commands.registerCommand("editor.log.stop", () => {
			if (collecting !== undefined) {
				stop();
				channel?.info("Stopped.");
			}
		}),
		vscode.commands.registerCommand("editor.log.show", () => {
			channel ??= vscode.window.createOutputChannel("Editor Log", { "log": true });
			showUntilSeen(channel);

			if (collecting === undefined) {
				const to = channel;

				to.info(`Showing every context's records for ${String(LOG_MINUTES)} minutes, as they come.`);
				collecting = installHubCollector(bridgeHub, (record) => {
					const source = typeof record.context?.["source"] === "string"
						? record.context["source"]
						: "?";
					const line = `[${source}] ${renderRecord({ ...record, "attrs": record.attrs ?? {} })}`;

					if (record.level === "fatal") {
						to.error(line);
					} else {
						to[record.level](line);
					}
				});
			}

			clearTimeout(ending);
			ending = setTimeout(() => {
				stop();
				channel?.info(`Stopped after ${String(LOG_MINUTES)} minutes: Developer: Show the Editor's Log goes on.`);
			}, LOG_MINUTES * 60_000);
		})
	);
}
