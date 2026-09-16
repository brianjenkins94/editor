/**
 * Git service — exposes `git-engine` (+ the cosmetic classifier) over the hub, for the shell's GitHub-Desktop-style
 * review panel to consume. This is a SECOND binding onto the same engine (git-scm.ts is the vscode-SCM one), which
 * is exactly why the engine was kept vscode-free: the novel review UI reads it over the hub without knowing about
 * monaco. Runs in the workbench realm (where zen-fs + the vscode API live); the shell reaches it shell → app →
 * workbench across the hub tree.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { CosmeticClassifier } from "./cosmetic-classifier";
import { serve } from "@brianjenkins94/hub";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** One changed file as the review panel sees it. */
export interface GitFileChange {
	"path": string;
	"status": "A" | "M" | "D";
	"staged": boolean;
	"unstaged": boolean;
	/** True when a MODIFIED file's change is whitespace/comments only (BABLR verdict); false/undefined otherwise. */
	"cosmetic": boolean;
}

/** Serve `git.status` / `git.file` / `git.commit` and publish `git.changed` on the given hub. */
export function installGitService(vscode: typeof vscodeApi, hub: Hub, classifier: CosmeticClassifier, log: Logger): void {
	const readWorking = async (path: string): Promise<string> =>
		new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	serve(hub, "git.status", async () => {
		const status = await engine.status();
		const byPath = new Map<string, GitFileChange>();

		const record = (change: engine.GitChange, kind: "staged" | "unstaged"): void => {
			let entry = byPath.get(change.path);

			if (entry === undefined) {
				entry = { "path": change.path, "status": change.status, "staged": false, "unstaged": false, "cosmetic": false };
				byPath.set(change.path, entry);
			}

			entry[kind] = true;
			entry.status = change.status;
		};

		for (const change of status.staged) {
			record(change, "staged");
		}

		for (const change of status.unstaged) {
			record(change, "unstaged");
		}

		// Cosmetic verdict for modified, classifiable files (off-thread + cached in the classifier).
		await Promise.all([...byPath.values()].map(async (entry) => {
			if (entry.status === "M" && CLASSIFIABLE.test(entry.path)) {
				try {
					entry.cosmetic = (await classifier.classify(await engine.headContent(entry.path), await readWorking(entry.path))) === "cosmetic";
				} catch { /* unreadable / unparsable → no badge */ }
			}
		}));

		return { "files": [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
	});

	serve(hub, "git.file", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;

		if (typeof path !== "string") {
			return { "head": "", "working": "" };
		}

		let working = "";

		try {
			working = await readWorking(path);
		} catch { /* deleted in the working tree */ }

		return { "head": await engine.headContent(path), "working": working };
	});

	serve(hub, "git.commit", async (args) => {
		const message = (args as { "message"?: string } | null)?.message?.trim();

		if (message === undefined || message === "") {
			throw new Error("Enter a commit message first.");
		}

		const oid = await engine.commitAll(message);

		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": oid.slice(0, 7) });

		return { "oid": oid };
	});

	// Tell the shell to refresh when the working tree changes (saves, and picker-driven writes).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => { hub.publish("git.changed"); }, 300);
	};

	vscode.workspace.onDidSaveTextDocument(schedule);

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	watcher.onDidDelete(schedule);

	log.info("git service installed");
}
