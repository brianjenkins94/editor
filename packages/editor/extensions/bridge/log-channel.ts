/**
 * The editor's own log, as a person reads it (CLAUDE.md, *Spans*; *Agent tools*: what agents' `logs_query`, `logs_wait`
 * and `spans_query` read from outside). *Developer: Show the Editor's Log* writes every context's records — the shell's,
 * the workbench's, the extensions', the workers' — to the Output channel "Editor Log" as they come: a span as its
 * `→ name` when it opens and `← name (Xms)` when it ends, a record at its level, each under its source. The Output
 * view's filter finds a source or a name, its log level hides the quieter ones (a span's open is a trace).
 *
 * Only for LOG_MINUTES from when it's asked (asked again, from then), or until *Developer: Stop the Editor's Log*: every
 * record would otherwise cross into this extension host for nobody.
 */
import { installHubCollector } from "@brianjenkins94/observability";
import { renderRecord } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";

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
			channel.show(true);

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
