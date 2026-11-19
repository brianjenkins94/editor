/**
 * What this editor has done to itself since it came up (RUNNING.md, *Tests*: specs share an editor): the workspace's
 * files made, changed or removed, git's branch and HEAD if they moved, runs still going (and the ports they serve) and the
 * editors left open. A test that drove it says so as it lets its window go — what it leaves, which a test after it in the
 * same editor would meet — asked on `editor.effects` by this editor's instance, as a page's realms are asked what they ran
 * (build/coverage.ts's `editor.coverage`). And, asked to on the same channel, it puts itself back as it came up with the next
 * test's files: a shared editor's reset (shell/preview-windows.tsx hands it from test to test).
 */
import type { Leaves } from "@brianjenkins94/editor-api";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { RunRegistry } from "./runs";
import { fs as zenfs } from "@zenfs/core";
import { instance } from "../shared/instance";
import { branches, headCommit } from "./git-engine";
import { waitFor } from "./readiness";

/** The workspace's root. */
const ROOT = "/workspace";

/** The channel a page asks on (shell/preview-windows.tsx), and answers come back on. */
const CHANNEL = "editor.effects";

/** Files that aren't the program's own: packages type acquisition writes, and git's. */
const NOT_THE_WORKSPACE = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/u;

/** How long the editor may take to come up before what it's left with is counted from then anyway. */
const UP_MS = 120_000;
/** How long a reset's own writes take to be told (a watcher's events come a little after), before counting starts again. */
const SETTLE_MS = 500;
/** How often whether git's repository is there yet is asked, as the editor comes up. */
const REPO_POLL_MS = 250;

export function installEffects(vscode: typeof vscodeApi, runs: RunRegistry, log: Logger): void {
	if (instance === undefined || typeof BroadcastChannel === "undefined") {
		return;
	}

	/** Each file touched since the editor came up, and how: a file made and then removed was never there. What it writes as
	 *  it comes up (its seed, git's repository and .gitignore, the packages' versions) isn't a test's. */
	const files = new Map<string, Leaves["files"][number]["how"]>();
	let up = false;
	const at = (uri: vscodeApi.Uri): string | undefined => {
		const path = vscode.workspace.asRelativePath(uri, false);

		return path === uri.path || NOT_THE_WORKSPACE.test(path) ? undefined : path;
	};
	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidCreate((uri) => {
		const path = up ? at(uri) : undefined;

		if (path !== undefined) {
			files.set(path, files.get(path) === "removed" ? "changed" : "made");
		}
	});
	watcher.onDidChange((uri) => {
		const path = up ? at(uri) : undefined;

		if (path !== undefined && files.get(path) !== "made") {
			files.set(path, "changed");
		}
	});
	watcher.onDidDelete((uri) => {
		const path = up ? at(uri) : undefined;

		if (path !== undefined) {
			if (files.get(path) === "made") {
				files.delete(path);
			} else {
				files.set(path, "removed");
			}
		}
	});

	/** The workspace as the editor came up — every file, `.git` and `.silo` among them (not packages): what a reset puts back. */
	let snapshot: Map<string, Uint8Array> | undefined;
	const where = (): Promise<[string | undefined, string | undefined]> => Promise.all([branches().then(({ current }) => current, () => undefined), headCommit().catch(() => undefined)]);

	// Up: its workspace mounted, its API handed over and its packages' versions pinned (readiness.ts; not the debugger, which
	// is up only once a run's worker links to it — never, in an editor nothing's run in yet), and git's repository there — the
	// git service makes it as the editor comes up (git-engine.ts `ensureRepo`), waited for rather than made again beside it. Git's branch and HEAD then are where it started.
	let before = (async (): Promise<[string | undefined, string | undefined]> => {
		const deadline = Date.now() + UP_MS;

		await waitFor(["workspace", "api", "versions"], UP_MS);

		while (Date.now() < deadline && await branches().then(({ current }) => current === undefined, () => true)) {
			await new Promise((resolve) => { setTimeout(resolve, REPO_POLL_MS); });
		}

		snapshot = await filesUnder(ROOT);
		up = true;

		return where();
	})();
	const leaves = async (): Promise<Leaves> => {
		const [[branchThen, headThen], [branchNow, headNow]] = await Promise.all([before, where()]);

		return {
			"files": [...files].map(([path, how]) => ({ "path": path, "how": how })).toSorted((left, right) => left.path.localeCompare(right.path)),
			...branchThen === branchNow && headThen === headNow ? {} : { "git": { "branch": [branchThen, branchNow], "head": [headThen, headNow] } },
			"running": runs.list().filter((run) => run.state === "running").map((run) => ({ "title": run.title, ...run.port === undefined ? {} : { "port": run.port } })),
			"editors": vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0)
		};
	};

	/**
	 * The editor as it came up, for the next test that shares it (RUNNING.md, *Tests*), with `seed`'s
	 * files on it: its runs and debug sessions stopped, its breakpoints removed, its terminals, editors, panel, quick input and
	 * notifications closed, Problems' filter cleared, the Explorer shown (a test may have left another view in the side bar), and the workspace written
	 * back as it was — a file made since removed, one changed or removed since as it was, git's
	 * refs and `.silo`'s records among them (not a checkpoint's, which leaves those).
	 */
	const reset = async (seed: Record<string, string>): Promise<void> => {
		await before;
		// (its own writes aren't the next test's: not counted, and their events — told a little after — let pass)
		up = false;

		for (const run of runs.list().filter((each) => each.state === "running")) {
			runs.stop(run.id);
		}

		await vscode.debug.stopDebugging();
		// (breakpoints are the editor's, by a file's path, not the workspace's: the next test's F9 on the same line would take one away)
		vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

		// (each terminal disposed and its close waited for: one still going away hands the focus back to itself as a box closes)
		await Promise.all(vscode.window.terminals.map(async (terminal) => new Promise<void>((resolve) => {
			const closing = vscode.window.onDidCloseTerminal((closed) => {
				if (closed === terminal) {
					closing.dispose();
					resolve();
				}
			});

			terminal.dispose();
			setTimeout(() => { closing.dispose(); resolve(); }, 5000);
		})));

		// (Problems' filter too, which stays with its view: one a test typed — features-view.spec's "No test run" — hides every
		// row the next test looks for in Problems. It clears only with Problems showing.)
		for (const command of ["workbench.action.closeQuickOpen", "editor.git.closeRefs", "workbench.action.files.saveAll", "workbench.action.closeAllEditors", "workbench.actions.view.problems", "problems.action.clearFilterText", "workbench.action.closePanel", "notifications.clearAll", "workbench.view.explorer"]) {
			await Promise.resolve(vscode.commands.executeCommand(command)).catch(() => undefined);
		}

		const now = await filesUnder(ROOT);

		let tsconfigRemoved = false;

		for (const path of now.keys()) {
			if (!snapshot!.has(path)) {
				await zenfs.promises.unlink(`${ROOT}/${path}`).catch(() => undefined);
				tsconfigRemoved ||= /(?:^|\/)tsconfig[^/]*\.json$/u.test(path);
			}
		}

		for (const [path, bytes] of snapshot!) {
			const there = now.get(path);

			if (there === undefined || !same(there, bytes)) {
				await write(`${ROOT}/${path}`, bytes);
			}
		}

		await removeEmptyFolders(ROOT, new Set([...snapshot!.keys()].flatMap((path) => folders(path))));

		for (const [path, text] of Object.entries(seed)) {
			await write(`${ROOT}/${path}`, new TextEncoder().encode(text));
		}

		await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });

		// (TypeScript's server doesn't hear a tsconfig removed, and keeps its project's problems on it — a reload doesn't
		// drop them, a restart does: NEXT.md's known issues. Every editor's closed, so no open is in flight to orphan.)
		if (tsconfigRemoved) {
			await Promise.resolve(vscode.commands.executeCommand("typescript.restartTsServer")).catch(() => undefined);
		}

		files.clear();
		up = true;
		before = where();
		await before;
	};

	/** Each reset asked, by its asking (asked again until heard: one reset however often). */
	const resets = new Map<string, Promise<void>>();
	const channel = new BroadcastChannel(CHANNEL);

	channel.onmessage = ({ data }: MessageEvent<{ "ask"?: string; "instance"?: string; "nonce"?: string; "seed"?: Record<string, string> }>) => {
		if (data.instance !== instance) {
			return;
		}

		if (data.ask === "leaves") {
			void log.span("editor.workbench.effects.leaves", {}, async (span) => {
				const told = await leaves();

				channel.postMessage({ "answer": data.nonce, "leaves": told });
				span.end({ "count": told.files.length, "running": told.running.length });
			}).catch(() => undefined);
		} else if (data.ask === "reset" && data.nonce !== undefined) {
			let resetting = resets.get(data.nonce);

			if (resetting === undefined) {
				resetting = log.span("editor.workbench.effects.reset", { "count": Object.keys(data.seed ?? {}).length }, async () => reset(data.seed ?? {}));
				resets.set(data.nonce, resetting);
			}

			void resetting.then(() => {
				channel.postMessage({ "answer": data.nonce, "reset": true });
			}, (error: unknown) => {
				channel.postMessage({ "answer": data.nonce, "error": String(error) });
			});
		}
	};
}

/** Every file under `root` (not packages), by its path from it, with its bytes. */
async function filesUnder(root: string): Promise<Map<string, Uint8Array>> {
	const found = new Map<string, Uint8Array>();
	const walk = async (folder: string): Promise<void> => {
		for (const entry of await zenfs.promises.readdir(`${root}${folder}`, { "withFileTypes": true }).catch(() => [])) {
			const path = `${folder}/${entry.name}`;

			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") {
					await walk(path);
				}
			} else {
				found.set(path.slice(1), new Uint8Array(await zenfs.promises.readFile(`${root}${path}`)));
			}
		}
	};

	await walk("");

	return found;
}

/** The folders `path` is in, from the outermost. */
function folders(path: string): string[] {
	const parts = path.split("/").slice(0, -1);

	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Folders under `root` that `kept` doesn't name and that nothing is in, removed, deepest first. */
async function removeEmptyFolders(root: string, kept: Set<string>): Promise<void> {
	const walk = async (folder: string): Promise<boolean> => {
		let empty = true;

		for (const entry of await zenfs.promises.readdir(`${root}/${folder}`, { "withFileTypes": true }).catch(() => [])) {
			const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

			if (!entry.isDirectory() || entry.name === "node_modules" || !await walk(path) || kept.has(path)) {
				empty = false;
			}
		}

		if (empty && folder !== "" && !kept.has(folder)) {
			await zenfs.promises.rmdir(`${root}/${folder}`).catch(() => undefined);
		}

		return empty && !kept.has(folder);
	};

	await walk("");
}

async function write(path: string, bytes: Uint8Array): Promise<void> {
	await zenfs.promises.mkdir(path.slice(0, path.lastIndexOf("/")), { "recursive": true });
	await zenfs.promises.writeFile(path, bytes);
}

function same(one: Uint8Array, other: Uint8Array): boolean {
	return one.length === other.length && one.every((byte, index) => byte === other[index]);
}
