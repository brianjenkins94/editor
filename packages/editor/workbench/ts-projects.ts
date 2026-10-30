/**
 * The TypeScript server's projects, kept to the workspace's files. In the browser the server never hears that a file
 * was made or deleted on disk — by an agent's write, a checkout, a pull, the terminal: VS Code's TypeScript extension
 * builds the watchers the server asks for from `Uri.file` of the server's names, which are URIs here
 * (`/file/ts-nul-authority/workspace/…`), so they watch nothing. Until a project reads its files again, a new
 * file isn't in it: no importers, no references across it, nothing History reads.
 *
 * So a code file made or deleted tells the server's projects to read their root files again (history's tsserver plugin,
 * `_history.files`, as the server's own watcher would), once a burst of them has settled: the program updates as for an
 * edit, not from scratch (`typescript.reloadProjects` would rebuild every project). Whoever reads across files
 * (code-refactor.ts, code-problems.ts) tells them first (`refresh()`): a file just written may not have reached the
 * watcher yet, and telling costs a rescan of the file names at the next request.
 */
import type * as vscodeApi from "vscode";

/** The files the TypeScript server reads. */
const CODE = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** How long after the last file made or deleted the projects are told (a checkout makes many at once). */
const SETTLE_MS = 500;

export interface TypeScriptProjects {
	/** Tell the projects now (a telling that was due included), so the next request reads them with every file there. */
	"refresh": () => Promise<void>;
}

export function keepTypeScriptProjects(vscode: typeof vscodeApi): TypeScriptProjects {
	const watcher = vscode.workspace.createFileSystemWatcher(CODE, false, true, false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const tell = async (): Promise<void> => {
		clearTimeout(timer);
		timer = undefined;
		await Promise.resolve(vscode.commands.executeCommand("typescript.tsserverRequest", "_history.files", {})).catch(() => undefined);
	};
	const changed = (uri: vscodeApi.Uri): void => {
		if (/\/(?:node_modules|\.git|\.silo)\//u.test(uri.path)) {
			return;
		}

		clearTimeout(timer);
		timer = setTimeout(() => {
			void tell();
		}, SETTLE_MS);
	};

	watcher.onDidCreate(changed);
	watcher.onDidDelete(changed);

	return { "refresh": tell };
}
