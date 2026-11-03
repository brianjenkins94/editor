/**
 * A project loaded into the live workbench — a repository from GitHub (repo-load.tsx), or a sample: its files written
 * into the workspace's store all at once and its editors opened, without a reboot. A `replace` clears the workspace
 * first — the workspace becomes the repository — keeping the editor's scaffolding and reconciling the configs the
 * editor provides as defaults. A load arrives as `workbench.openProject` (followProjectSwitches); the boot opens its
 * first editors the same way.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { WorkspaceFs } from "./workspace-fs";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { serve } from "@brianjenkins94/hub";
import { fs as workspaceStore } from "@zenfs/core";
import * as gitEngine from "./git-engine";

/** A project to open: its files (text or bytes), the editors to open, and whether it replaces what's there. */
export interface Project { "files"?: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[]; "openEditors"?: string[]; "replace"?: boolean }

// Editor-owned paths at the workspace root: the shim .d.ts (when the demo needs one), the capability ledger,
// acquired deps, git meta. They survive a `replace` (the editor needs them) and are never sent back to a repo on commit.
const SCAFFOLDING = new Set(["editor-ambient.d.ts", ".silo", "node_modules", ".git"]);

// Root-level managed configs are OVERRIDABLE DEFAULTS: writable in zen-fs (see workspace-fs.ts), and writable in the
// priority-1 base too (see the boot below) — the file service refuses a write to a path whose stat says read-only, so a
// read-only base would make a deleted default impossible to write again. A write goes to the highest writable overlay,
// zen-fs: the base never changes, and the new file is the workspace's (copy-up). A loaded repo's own copy overwrites in
// place, because clearWorkspace keeps these. When a repo ships NONE, the reconciliation differs by how the config is read:
//   FALLTHROUGH_DEFAULTS — TS project configs, read by tsserver via the COMPOSITE file service: DELETE the writable
//     copy so the priority-1 base shows through.
//   .gitignore — read straight off zen-fs by isomorphic-git (a priority-1 base would be invisible to it): MATERIALIZE
//     the git default (gitEngine.DEFAULT_GITIGNORE) into zen-fs.
//   ESLINT_CONFIGS — kept overridable so a repo's own is writable; eslint's worker lints with it (else the preset)
//     (extensions/eslint/worker.ts), so there's nothing to materialize; on omit we just drop a stale one. Variants are
//     one concept — a repo providing ANY counts.
// Keep OVERRIDABLE_DEFAULTS in sync with workspace-fs.ts.
const FALLTHROUGH_DEFAULTS = new Set(["tsconfig.json", "jsconfig.json"]);
const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
export const OVERRIDABLE_DEFAULTS = new Set([...FALLTHROUGH_DEFAULTS, ...ESLINT_CONFIGS, ".gitignore"]);

/** Delete every workspace entry except the editor scaffolding — the "workspace = the repo" reset before a load. */
async function clearWorkspace(vscode: typeof vscodeApi, root: string): Promise<void> {
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
	const kept = (name: string): boolean => SCAFFOLDING.has(name) || OVERRIDABLE_DEFAULTS.has(name);

	// Close the editors on the files about to go first. VS Code closes an editor whose file is deleted from inside the
	// app, but a moment later — after a load has reopened the same file in that editor, which then closes instead.
	// Unsaved editors stay, as VS Code keeps them.
	const going = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
		const path: string | undefined = tab.input instanceof vscode.TabInputText ? tab.input.uri.path : undefined;

		return path?.startsWith(root + "/") === true && !tab.isDirty && !kept(path.slice(root.length + 1).split("/")[0]);
	});

	await vscode.window.tabGroups.close(going);

	for (const [name] of entries) {
		// Keep scaffolding always; keep overridable-default configs so a repo that ships its own can OVERWRITE them
		// in place (openProject prunes the ones the repo omits afterwards, so those fall through to the base).
		if (!kept(name)) {
			await vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": true, "useTrash": false }).then(undefined, () => { /* already gone */ });
		}
	}
}

/** Fire change events for the files in `<workspace>/.vscode/` so the configuration service re-reads them (see the
 *  call site). A no-op when the folder doesn't exist. */
export async function announceWorkspaceSettings(vscode: typeof vscodeApi, root: string, store: WorkspaceFs | undefined): Promise<void> {
	const dir = root + "/.vscode";
	const entries: [string, unknown][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)).then((list) => list, () => []);
	// The extension API's Uri IS vscode's URI class in this (local-process) host — the type the provider fires.
	const uris = entries.map(([name]) => vscode.Uri.file(dir + "/" + name)) as unknown as Parameters<WorkspaceFs["announce"]>[0];

	store?.announce(uris);
}

export async function openProject(vscode: typeof vscodeApi, root: string, log: Logger, { files = [], openEditors = [], replace = false }: Project): Promise<void> {
	const encoder = new TextEncoder();
	const madeDirs = new Set<string>();

	if (replace) {
		await clearWorkspace(vscode, root);

		// The workspace's `.git` goes too, though clearWorkspace keeps it as scaffolding: the workspace is becoming
		// something else. A clone (git-clone.ts) brings its own, history and all; anything else (a sample, a playground, a
		// repo read through the API) gets a fresh one below — kept, the last repo's origin would still be where a commit
		// pushes, and what the shell takes the workspace for (`git.origin`).
		await vscode.workspace.fs.delete(vscode.Uri.file(root + "/.git"), { "recursive": true, "useTrash": false }).then(undefined, () => { /* none yet */ });
	}

	// Written straight into the workspace's store, all at once: its change watcher (workspace-changes.ts) reports them
	// to VS Code as one batch, as it does isomorphic-git's and the terminal's writes. Through VS Code's file service each
	// file cost a stat to validate it, two mkdirp walks of its folders and a listing of its folder — each a path walk in
	// zen-fs, the listings quadratic in a folder's size (288 files in one of this repository's): the page was busy for
	// minutes loading a repository of ~2,000 files.
	for (const file of files) {
		const dir = file.path.slice(0, file.path.lastIndexOf("/"));

		if (dir.length > 0 && !madeDirs.has(dir)) {
			madeDirs.add(dir);
			workspaceStore.mkdirSync(dir, { "recursive": true });
		}

		// Binary files (from a GitHub repo) arrive as bytes; text samples as a string to encode.
		workspaceStore.writeFileSync(file.path, file.bytes ?? encoder.encode(file.contents ?? ""));
	}

	if (replace) {
		// Reconcile overridable-default configs the loaded repo did NOT provide (the write loop above already
		// overwrote any it DID ship; clearWorkspace kept these so those were in-place overwrites).
		const provided = new Set(files.map((file) => file.path));
		const providedAtRoot = (name: string): boolean => provided.has(root + "/" + name);
		const dropWritable = async (name: string): Promise<void> => {
			await Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": false, "useTrash": false })).catch(() => { /* not present */ });
		};

		// TS project configs: DELETE so tsserver falls through to the read-only base via the composite file service.
		for (const name of FALLTHROUGH_DEFAULTS) {
			if (!providedAtRoot(name)) {
				await dropWritable(name);
			}
		}

		// .gitignore: isomorphic-git reads zen-fs directly, so MATERIALIZE the git default when the repo omits it
		// (in-place overwrite — clearWorkspace kept it). Matches ensureRepo's first-run default.
		if (!providedAtRoot(".gitignore")) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(root + "/.gitignore"), encoder.encode(gitEngine.DEFAULT_GITIGNORE));
		}

		// A load that brought its own `.git` (a clone): `.silo/` goes in git there too. Any other: a new repository, no
		// one's origin.
		if (files.some((file) => file.path.startsWith(root + "/.git/"))) {
			await gitEngine.includeSilo();
		} else {
			await gitEngine.ensureRepo();
		}

		// eslint: a repo's own config already overwrote in place; when it ships none, drop any stale variant. Nothing
		// to materialize — with none, eslint's worker lints with the preset.
		if (!ESLINT_CONFIGS.some((name) => providedAtRoot(name))) {
			for (const name of ESLINT_CONFIGS) {
				await dropWritable(name);
			}
		}
	}

	for (const path of openEditors) {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));

			await vscode.window.showTextDocument(document, { "preview": false });
		} catch (error) {
			log.error("openProject: show failed", { "path": path, "error": failureText(error) });
		}
	}

	void Promise.resolve(vscode.commands.executeCommand("workbench.view.explorer")).catch(() => undefined);
	log.info("openProject wrote sample", { "files": files.length });
}

/** A live project switch (the shell's repo load → the app → here) arrives as a publish; written and focused into the
 *  running workbench (`open`). `replace` (a GitHub repo load) clears the workspace first — the workspace becomes the
 *  repo.
 *
 *  COALESCED: the hub delivers a single load as a burst of identical publishes. That's harmless for a plain write
 *  (idempotent), but a `replace` clears + rewrites the SingleBuffer (SAB) FS each time, and repeated clear/rewrite
 *  cycles corrupt it ("offset is out of bounds"). So we debounce the burst to ONE run with the latest request. */
export function followProjectSwitches(hub: Hub, open: (project: Project) => Promise<void>, log: Logger): void {
	let pendingProject: Project | undefined;
	let projectTimer: ReturnType<typeof setTimeout> | undefined;

	hub.subscribe("workbench.openProject", (data) => {
		pendingProject = data as Project;

		clearTimeout(projectTimer);
		projectTimer = setTimeout(() => {
			const project = pendingProject;

			pendingProject = undefined;

			if (project !== undefined) {
				void open(project).catch((error: unknown) => {
					log.error("openProject failed", { "error": failureText(error) });
				});
			}
		}, 150);
	});
}

/** The GitHub repository the workspace is a clone of — its origin, and the branch it's on — or null, as `git.origin`: the
 *  shell's binding (where a commit pushes, what an `env/` address compares with), read from the workspace so the two
 *  can't disagree. */
export function serveOrigin(hub: Hub): void {
	serve(hub, "git.origin", async () => {
		const [owner, repo] = /github\.com\/(.+)\.git$/u.exec(await gitEngine.githubRemote() ?? "")?.[1].split("/") ?? [];

		return owner === undefined || repo === undefined ? null : { "owner": owner, "repo": repo, "branch": (await gitEngine.branches()).current ?? "main" };
	});
}
