import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { SharedWorkspace } from "../shared/playground-link";
import type { WorkspaceFs } from "./workspace-fs";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { serve } from "@brianjenkins94/hub";
import { fs as store } from "@zenfs/core";
import { callerFs } from "../shared/fs-caller";
import * as gitEngine from "./git-engine";

const workspaceStore = callerFs(store, "project");

export interface Project { "files"?: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[]; "openEditors"?: string[]; "replace"?: boolean }

const SCAFFOLDING = new Set(["editor-ambient.d.ts", ".silo", "node_modules", ".git"]);

const FALLTHROUGH_DEFAULTS = new Set(["tsconfig.json", "jsconfig.json"]);
const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];

export const OVERRIDABLE_DEFAULTS = new Set([...FALLTHROUGH_DEFAULTS, ...ESLINT_CONFIGS, ".gitignore"]);

async function clearWorkspace(vscode: typeof vscodeApi, root: string): Promise<void> {
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
	const kept = (name: string): boolean => SCAFFOLDING.has(name) || OVERRIDABLE_DEFAULTS.has(name);

	const going = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
		const path: string | undefined = tab.input instanceof vscode.TabInputText ? tab.input.uri.path : undefined;

		return path?.startsWith(root + "/") === true && !tab.isDirty && !kept(path.slice(root.length + 1).split("/")[0]);
	});

	await vscode.window.tabGroups.close(going);

	for (const [name] of entries) {
		if (!kept(name)) {
			await vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": true, "useTrash": false }).then(undefined, () => { /* already gone */ });
		}
	}
}

export async function announceWorkspaceSettings(vscode: typeof vscodeApi, root: string, store: WorkspaceFs | undefined): Promise<void> {
	const dir = root + "/.vscode";
	const entries: [string, unknown][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)).then((list) => list, () => []);
	const uris = entries.map(([name]) => vscode.Uri.file(dir + "/" + name)) as unknown as Parameters<WorkspaceFs["announce"]>[0];

	store?.announce(uris);
}

export async function openProject(vscode: typeof vscodeApi, root: string, log: Logger, { files = [], openEditors = [], replace = false }: Project): Promise<void> {
	const encoder = new TextEncoder();
	const madeDirs = new Set<string>();

	if (replace) {
		await clearWorkspace(vscode, root);

		await vscode.workspace.fs.delete(vscode.Uri.file(root + "/.git"), { "recursive": true, "useTrash": false }).then(undefined, () => { /* none yet */ });
		await vscode.workspace.fs.delete(vscode.Uri.file(root + "/.silo/local"), { "recursive": true, "useTrash": false }).then(undefined, () => { /* none yet */ });
	}

	for (const file of files) {
		const dir = file.path.slice(0, file.path.lastIndexOf("/"));

		if (dir.length > 0 && !madeDirs.has(dir)) {
			madeDirs.add(dir);
			workspaceStore.mkdirSync(dir, { "recursive": true });
		}

		workspaceStore.writeFileSync(file.path, file.bytes ?? encoder.encode(file.contents ?? ""));
	}

	if (replace) {
		const provided = new Set(files.map((file) => file.path));
		const providedAtRoot = (name: string): boolean => provided.has(root + "/" + name);
		const dropWritable = async (name: string): Promise<void> => {
			await Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": false, "useTrash": false })).catch(() => { /* not present */ });
		};

		for (const name of FALLTHROUGH_DEFAULTS) {
			if (!providedAtRoot(name)) {
				await dropWritable(name);
			}
		}

		if (!providedAtRoot(".gitignore")) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(root + "/.gitignore"), encoder.encode(gitEngine.DEFAULT_GITIGNORE));
		}

		if (files.some((file) => file.path.startsWith(root + "/.git/"))) {
			await gitEngine.includeSilo();
		} else {
			await gitEngine.ensureRepo();
		}

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

export function followProjectSwitches(hub: Hub, open: (project: Project) => Promise<void>, log: Logger): void {
	let pendingProject: Project | undefined;
	let projectTimer: ReturnType<typeof setTimeout> | undefined;

	hub.subscribe("workbench.openProject", (data) => {
		pendingProject = data;

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

export function serveFiles(vscode: typeof vscodeApi, hub: Hub, root: string, log: Logger): void {
	serve(hub, "workbench.files", async (): Promise<SharedWorkspace> => log.span("editor.workbench.project.files", { "path": root }, async (span) => {
		const files: SharedWorkspace["files"] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))) {
				const full = `${dir}/${name}`;

				if (dir === root && SCAFFOLDING.has(name)) {
					continue;
				}

				if (type === vscode.FileType.Directory) {
					await walk(full);
				} else if (type === vscode.FileType.File) {
					files.push({ "path": full, "bytes": await vscode.workspace.fs.readFile(vscode.Uri.file(full)) });
				}
			}
		};

		await walk(root);
		span.end({ "count": files.length, "bytes": files.reduce((total, { bytes }) => total + bytes.length, 0) });

		const editor = vscode.window.activeTextEditor;

		if (editor === undefined || editor.document.uri.scheme !== "file") {
			return { "files": files };
		}

		const { active, anchor } = editor.selection;

		return {
			"files": files,
			"activeFile": editor.document.uri.path,
			"selection": { "positionLineNumber": active.line + 1, "positionColumn": active.character + 1, "selectionStartLineNumber": anchor.line + 1, "selectionStartColumn": anchor.character + 1 }
		};
	}));
}

export function serveOrigin(hub: Hub): void {
	serve(hub, "git.origin", async () => {
		const [owner, repo] = /github\.com\/(.+)\.git$/u.exec(await gitEngine.githubRemote() ?? "")?.[1].split("/") ?? [];

		return owner === undefined || repo === undefined ? null : { "owner": owner, "repo": repo, "branch": (await gitEngine.branches()).current ?? "main" };
	});
}
