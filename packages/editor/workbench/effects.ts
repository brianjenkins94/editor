/**
 * What this editor has done to itself since it came up (NEXT.md item 2, *Specs share an editor, by design*): the workspace's
 * files made, changed or removed, git's branch and HEAD if they moved, runs still going (and the ports they serve) and the
 * editors left open. A test that drove it says so as it lets its window go — what it leaves, which a test after it in the
 * same editor would meet — asked on `editor.effects` by this editor's instance, as a page's realms are asked what they ran
 * (build/coverage.ts's `editor.coverage`).
 */
import type { Leaves } from "@brianjenkins94/editor-api";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { RunRegistry } from "./runs";
import { instance } from "../shared/instance";
import { branches, headCommit } from "./git-engine";
import { STAGES, waitFor } from "./readiness";

/** The channel a page asks on (shell/preview-windows.tsx), and answers come back on. */
const CHANNEL = "editor.effects";

/** Files that aren't the program's own: packages type acquisition writes, and git's. */
const NOT_THE_WORKSPACE = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/u;

/** How long the editor may take to come up before what it's left with is counted from then anyway. */
const UP_MS = 120_000;
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

	// Up: every stage reached (readiness.ts), and git's repository there — the git service makes it as the editor comes up
	// (git-engine.ts `ensureRepo`), waited for rather than made again beside it. Git's branch and HEAD then are where it started.
	const before = (async (): Promise<[string | undefined, string | undefined]> => {
		const deadline = Date.now() + UP_MS;

		await waitFor(STAGES, UP_MS);

		while (Date.now() < deadline && await branches().then(({ current }) => current === undefined, () => true)) {
			await new Promise((resolve) => { setTimeout(resolve, REPO_POLL_MS); });
		}

		up = true;

		return Promise.all([branches().then(({ current }) => current, () => undefined), headCommit().catch(() => undefined)]);
	})();
	const leaves = async (): Promise<Leaves> => {
		const [[branchThen, headThen], branchNow, headNow] = await Promise.all([before, branches().then(({ current }) => current, () => undefined), headCommit().catch(() => undefined)]);

		return {
			"files": [...files].map(([path, how]) => ({ "path": path, "how": how })).toSorted((left, right) => left.path.localeCompare(right.path)),
			...branchThen === branchNow && headThen === headNow ? {} : { "git": { "branch": [branchThen, branchNow], "head": [headThen, headNow] } },
			"running": runs.list().filter((run) => run.state === "running").map((run) => ({ "title": run.title, ...run.port === undefined ? {} : { "port": run.port } })),
			"editors": vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0)
		};
	};
	const channel = new BroadcastChannel(CHANNEL);

	channel.onmessage = ({ data }: MessageEvent<{ "ask"?: string; "instance"?: string; "nonce"?: string }>) => {
		if (data.ask === "leaves" && data.instance === instance) {
			void log.span("editor.workbench.effects.leaves", {}, async (span) => {
				const told = await leaves();

				channel.postMessage({ "answer": data.nonce, "leaves": told });
				span.end({ "count": told.files.length, "running": told.running.length });
			}).catch(() => undefined);
		}
	};
}
