/**
 * Each bundled extension's commands, as the architecture view discovers them (DISCOVERED-ARCHITECTURE.md): the build hands
 * every extension a `vscode` whose `commands` are these (build.ts, commandTap), so what it registers and what it calls is
 * counted — by the extension, with nothing in its own code. Each extension host keeps one tally for every extension in
 * it, and sends its totals to worker-pod (`editor.arch.commands`) a moment after they change; worker-pod puts them on the
 * view as extensions and the commands between them.
 *
 * `typescript.tsserverRequest` is told with the request it carries (`_types.at`, `_eslint.fixAll`): a tsserver plugin's
 * requests are commands too, one level down.
 */
import type * as vscodeApi from "vscode";

/** worker-pod's command that takes a host's totals; never counted itself. */
export const ARCH_COMMANDS = "editor.arch.commands";

/** How long after a change a host's totals go out. */
const FLUSH_MS = 2000;

/** What a host has seen: each command's registrant, each (caller, command) pair's calls. */
export interface CommandTotals { "host": string; "registered": [string, string][]; "calls": [string, string, number][] }

interface Tally { "id": string; "registered": Map<string, string>; "calls": Map<string, number>; "timer": ReturnType<typeof setTimeout> | undefined }

/** This extension host's tally, shared by every extension in it (they share the realm). */
function tally(): Tally {
	const self = globalThis as { "__commandTap"?: Tally };

	self.__commandTap ??= { "id": `${typeof (globalThis as { "WorkerGlobalScope"?: unknown }).WorkerGlobalScope === "undefined" ? "LocalProcess" : "LocalWebWorker"}#${crypto.randomUUID()}`, "registered": new Map(), "calls": new Map(), "timer": undefined };

	return self.__commandTap;
}

/** `vscode.commands` for `extension`: the same commands, counted. */
export function tappedCommands(vscode: typeof vscodeApi, extension: string): typeof vscodeApi.commands {
	const real = vscode.commands;
	const mine = tally();
	const changed = (): void => {
		mine.timer ??= setTimeout(() => {
			mine.timer = undefined;

			const totals: CommandTotals = { "host": mine.id, "registered": [...mine.registered], "calls": [...mine.calls].map(([key, count]) => [...key.split("\0") as [string, string], count]) };

			void Promise.resolve(real.executeCommand(ARCH_COMMANDS, totals)).catch(() => undefined);
		}, FLUSH_MS);
	};
	const registered = (id: string): void => {
		if (id !== ARCH_COMMANDS) {
			mine.registered.set(id, extension);
			changed();
		}
	};

	return {
		...real,
		"registerCommand": (id, callback, thisArg) => { registered(id); return real.registerCommand(id, callback, thisArg); },
		"registerTextEditorCommand": (id, callback, thisArg) => { registered(id); return real.registerTextEditorCommand(id, callback, thisArg); },
		"executeCommand": async <T>(id: string, ...rest: unknown[]): Promise<T> => {
			if (id !== ARCH_COMMANDS) {
				const key = `${extension}\0${id === "typescript.tsserverRequest" && typeof rest[0] === "string" ? `${id} ${rest[0]}` : id}`;

				mine.calls.set(key, (mine.calls.get(key) ?? 0) + 1);
				changed();
			}

			return real.executeCommand<T>(id, ...rest);
		}
	};
}
