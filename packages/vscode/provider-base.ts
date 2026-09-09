/**
 * Shared bones of the read-only, fetch-backed filesystem providers (node-modules-provider, and a
 * future FSA overlay): the errors they throw, an Event-conformant `onDidChangeFile`, and the
 * mount-relative path mapper.
 */
import type { IFileChange } from "@brianjenkins94/monaco-vscode-api/main";
import { FileSystemProviderError, FileSystemProviderErrorCode } from "@brianjenkins94/monaco-vscode-api/main";

export function notFound(): FileSystemProviderError {
	return FileSystemProviderError.create("not found", FileSystemProviderErrorCode.FileNotFound);
}

export function readOnly(): FileSystemProviderError {
	return FileSystemProviderError.create("read-only", FileSystemProviderErrorCode.NoPermissions);
}

export type FileChangeListener = (e: readonly IFileChange[]) => unknown;

/** A *real* onDidChangeFile event (a no-op no-firing emitter that still honours the Event contract:
 *  stores the listener, returns a disposable that removes it). A fake `() => disposable` that drops
 *  the listener makes the file service treat the provider as unwatchable and fall back to repeatedly
 *  re-resolving the whole tree — which leaked the renderer (~45MB/s → OOM). `listeners` is handed back
 *  so a provider that does want to fire (node_modules announces resolved files) can. */
export function createChangeEvent(): { "listeners": Set<FileChangeListener>; "onDidChangeFile": never } {
	const listeners = new Set<FileChangeListener>();
	const onDidChangeFile = ((listener: FileChangeListener, thisArgs?: unknown, disposables?: { "dispose": () => void }[]) => {
		const bound = thisArgs === undefined || thisArgs === null ? listener : listener.bind(thisArgs);

		listeners.add(bound);
		const disposable = { "dispose": function() { listeners.delete(bound); } };

		if (Array.isArray(disposables)) { disposables.push(disposable); }

		return disposable;
	}) as never;

	return { "listeners": listeners, "onDidChangeFile": onDidChangeFile };
}

/** Path under `mount` → "" (the mount itself) | "<rel>" | undefined (not ours — lets the overlay fall through). */
export function relUnder(mount: string): (path: string) => string | undefined {
	return (path) => (path === mount ? "" : path.startsWith(mount + "/") ? path.slice(mount.length + 1) : undefined);
}
