import type * as vscodeApi from "vscode";
import { storeShape } from "../shared/architecture-zenfs";

export const ARCH_COMMANDS = "editor.arch.commands";

const FLUSH_MS = 2000;

export interface CommandTotals { "host": string; "registered": [string, string][]; "calls": [string, string, number][]; "files": [string, string, string, number][] }

interface Tally { "id": string; "registered": Map<string, string>; "calls": Map<string, number>; "files": Map<string, number>; "timer": ReturnType<typeof setTimeout> | undefined }

function tally(): Tally {
	// eslint-disable-next-line ts/naming-convention -- the global every extension in this host shares the tally through
	const self = globalThis as { "__commandTap"?: Tally };

	// eslint-disable-next-line ts/naming-convention -- WorkerGlobalScope is the DOM's global, named by spec
	self.__commandTap ??= { "id": `${typeof (globalThis as { "WorkerGlobalScope"?: unknown }).WorkerGlobalScope === "undefined" ? "LocalProcess" : "LocalWebWorker"}#${crypto.randomUUID()}`, "registered": new Map(), "calls": new Map(), "files": new Map(), "timer": undefined };

	return self.__commandTap;
}

function changed(mine: Tally, vscode: typeof vscodeApi): void {
	mine.timer ??= setTimeout(() => {
		mine.timer = undefined;

		const split = <T extends unknown[]>(entries: Map<string, number>): [...T, number][] => [...entries].map(([key, count]) => [...key.split("\0") as unknown as T, count]);
		const totals: CommandTotals = { "host": mine.id, "registered": [...mine.registered], "calls": split<[string, string]>(mine.calls), "files": split<[string, string, string]>(mine.files) };

		void Promise.resolve(vscode.commands.executeCommand(ARCH_COMMANDS, totals)).catch(() => undefined);
	}, FLUSH_MS);
}

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
		"registerCommand": (id, callback, thisArg) => {
			registered(id);

			return real.registerCommand(id, callback, thisArg);
		},
		"registerTextEditorCommand": (id, callback, thisArg) => {
			registered(id);

			return real.registerTextEditorCommand(id, callback, thisArg);
		},
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

export function tappedWorkspace(vscode: typeof vscodeApi, extension: string): typeof vscodeApi.workspace {
	return Object.create(vscode.workspace, { "fs": { "value": tappedFs(vscode, extension), "enumerable": true } }) as typeof vscodeApi.workspace;
}

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
