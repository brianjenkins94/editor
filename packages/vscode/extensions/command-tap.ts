/**
 * Each bundled extension's commands, as the architecture view discovers them (DISCOVERED-ARCHITECTURE.md): the build hands
 * every extension a `vscode` whose `commands` are these (build.ts, commandTap), so what it registers and what it calls is
 * counted — by the extension, with nothing in its own code. Each extension host keeps one tally for every extension in
 * it, and sends its totals to worker-pod (`editor.arch.commands`) a moment after they change; worker-pod puts them on the
 * view as extensions and the commands between them.
 *
 * `typescript.tsserverRequest` is told with the request it carries (`_types.at`, `_eslint.fixAll`): a tsserver plugin's
 * requests are commands too, one level down.
 *
 * Its `workspace.fs` is counted the same way, for the stores it reads and writes (a tool's dot-directory: storeShape) —
 * which extension keeps what, which reads what.
 */
import type * as vscodeApi from "vscode";
import { storeShape } from "../architecture-zenfs";

/** worker-pod's command that takes a host's totals; never counted itself. */
export const ARCH_COMMANDS = "editor.arch.commands";

/** How long after a change a host's totals go out. */
const FLUSH_MS = 2000;

/** What a host has seen: each command's registrant, each (caller, command) pair's calls, each (extension, operation,
 *  store) triple's operations. */
export interface CommandTotals { "host": string; "registered": [string, string][]; "calls": [string, string, number][]; "files": [string, string, string, number][] }

interface Tally { "id": string; "registered": Map<string, string>; "calls": Map<string, number>; "files": Map<string, number>; "timer": ReturnType<typeof setTimeout> | undefined }

/** This extension host's tally, shared by every extension in it (they share the realm). */
function tally(): Tally {
	const self = globalThis as { "__commandTap"?: Tally };

	self.__commandTap ??= { "id": `${typeof (globalThis as { "WorkerGlobalScope"?: unknown }).WorkerGlobalScope === "undefined" ? "LocalProcess" : "LocalWebWorker"}#${crypto.randomUUID()}`, "registered": new Map(), "calls": new Map(), "files": new Map(), "timer": undefined };

	return self.__commandTap;
}

/** Send the host's totals a moment after `mine` changed (one send for every change in the meantime). */
function changed(mine: Tally, vscode: typeof vscodeApi): void {
	mine.timer ??= setTimeout(() => {
		mine.timer = undefined;

		const split = <T extends unknown[]>(entries: Map<string, number>): [...T, number][] => [...entries].map(([key, count]) => [...key.split("\0") as unknown as T, count]);
		const totals: CommandTotals = { "host": mine.id, "registered": [...mine.registered], "calls": split<[string, string]>(mine.calls), "files": split<[string, string, string]>(mine.files) };

		void Promise.resolve(vscode.commands.executeCommand(ARCH_COMMANDS, totals)).catch(() => undefined);
	}, FLUSH_MS);
}

/** `vscode.commands` for `extension`: the same commands, counted. */
export function tappedCommands(vscode: typeof vscodeApi, extension: string): typeof vscodeApi.commands {
	const real = vscode.commands;
	const mine = tally();
	const registered = (id: string): void => {
		if (id !== ARCH_COMMANDS) {
			mine.registered.set(id, extension);
			changed(mine, vscode);
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
				changed(mine, vscode);
			}

			return real.executeCommand<T>(id, ...rest);
		}
	};
}

/** `vscode.workspace` for `extension`: the real one — its live getters included, by delegation — but for `fs`, whose
 *  every operation on a tool's store is counted. */
export function tappedWorkspace(vscode: typeof vscodeApi, extension: string): typeof vscodeApi.workspace {
	return Object.create(vscode.workspace, { "fs": { "value": tappedFs(vscode, extension), "enumerable": true } }) as typeof vscodeApi.workspace;
}

/** `vscode.workspace.fs` for `extension`: the same file system, each read, write and delete of a file in a tool's store
 *  counted (a directory's listing or a stat isn't a store's content). */
function tappedFs(vscode: typeof vscodeApi, extension: string): typeof vscodeApi.workspace.fs {
	const real = vscode.workspace.fs;
	const mine = tally();
	const counted = <A extends unknown[], R>(operation: string, run: (uri: vscodeApi.Uri, ...rest: A) => Thenable<R>) => (uri: vscodeApi.Uri, ...rest: A): Thenable<R> => {
		const shape = storeShape(vscode.workspace.asRelativePath(uri, false));

		if (shape !== undefined) {
			const key = `${extension}\0${operation}\0${shape}`;

			mine.files.set(key, (mine.files.get(key) ?? 0) + 1);
			changed(mine, vscode);
		}

		return run(uri, ...rest);
	};

	return {
		...real,
		"readFile": counted("read", (uri) => real.readFile(uri)),
		"writeFile": counted("write", (uri, content: Uint8Array) => real.writeFile(uri, content)),
		"delete": counted("delete", (uri, options?: { "recursive"?: boolean; "useTrash"?: boolean }) => real.delete(uri, options))
	};
}
