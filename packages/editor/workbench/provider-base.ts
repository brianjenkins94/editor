import type { IFileChange } from "@brianjenkins94/monaco-vscode-api/main";
import { FileSystemProviderError, FileSystemProviderErrorCode } from "@brianjenkins94/monaco-vscode-api/main";

export function notFound(): FileSystemProviderError {
	return FileSystemProviderError.create("not found", FileSystemProviderErrorCode.FileNotFound);
}

export function readOnly(): FileSystemProviderError {
	return FileSystemProviderError.create("read-only", FileSystemProviderErrorCode.NoPermissions);
}

export type FileChangeListener = (e: readonly IFileChange[]) => unknown;

export function createChangeEvent(): { "listeners": Set<FileChangeListener>; "onDidChangeFile": never } {
	const listeners = new Set<FileChangeListener>();
	const onDidChangeFile = ((listener: FileChangeListener, thisArgs?: unknown, disposables?: { "dispose": () => void }[]) => {
		const bound = thisArgs === undefined || thisArgs === null ? listener : listener.bind(thisArgs);

		listeners.add(bound);
		const disposable = {
			"dispose": function() {
				listeners.delete(bound);
			}
		};

		if (Array.isArray(disposables)) {
			disposables.push(disposable);
		}

		return disposable;
	}) as never;

	return { "listeners": listeners, "onDidChangeFile": onDidChangeFile };
}

export function relUnder(mount: string): (path: string) => string | undefined {
	return (path) => {
		if (path === mount) {
			return "";
		}

		if (path.startsWith(mount + "/")) {
			return path.slice(mount.length + 1);
		}

		return undefined;
	};
}
