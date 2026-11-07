/**
 * Experiments that undo themselves: *Workspace: Save Checkpoint* notes the working tree as it stands against HEAD (every changed
 * file's text, and which files weren't there), and *Workspace: Restore Checkpoint…* puts every file changed since back as it was
 * then: a file made since deleted, one deleted since made again, the rest's text as it was. Agents' `workspace_checkpoint` and
 * `workspace_restore` do the same (`workspace.checkpoint`, `workspace.restore`), so they try a change, see what it breaks, and
 * undo it whole.
 *
 * What a checkpoint covers is what git sees (the git service's status): not what it ignores, and not `.silo/`, where the editor
 * keeps its records as it goes, as a restore would undo the editor's work, not yours. A restore is one WorkspaceEdit, so an open
 * editor shows it and undo takes it back, and every file it changes is saved. A commit since moves HEAD, and a restore would have
 * to undo the commit too, which is git's to do: it refuses, saying so. Checkpoints are this window's, the last few, until a
 * reload.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type * as vscodeApi from "vscode";
import type { GitReader } from "./git-service";
import { serve } from "@brianjenkins94/hub";
import { saveDocument } from "./workspace-tools";

const ROOT = "/workspace";

/** The editor's own records, which it writes as it goes: not a change to put back. */
const RECORDS = /^\.silo\//u;

/** The checkpoints kept, at most (the oldest goes first). */
const KEPT = 10;

/** A checkpoint: HEAD then, and each file that differed from it, its text or null where there was none. */
interface Checkpoint { "id": string; "label"?: string; "at": string; "head"?: string; "files": Map<string, string | null> }

/** A checkpoint, as it's listed. */
interface Listed { "id": string; "label"?: string; "at": string; "files": number }

export function installCheckpoints(vscode: typeof vscodeApi, hub: Hub, git: GitReader, log: Observed["log"]): void {
	const checkpoints: Checkpoint[] = [];
	const read = async (path: string): Promise<string | null> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => new TextDecoder().decode(bytes), () => null);
	const listed = (): Listed[] => checkpoints.map(({ id, label, at, files }) => ({ "id": id, ...label === undefined ? {} : { "label": label }, "at": at, "files": files.size }));

	const checkpoint = async (label?: string): Promise<Listed> => log.span("editor.workbench.checkpoints.save", {}, async () => {
		const { files, head } = await git.status({ "whole": true });
		const kept = new Map<string, string | null>();

		for (const change of files.filter(({ path }) => !RECORDS.test(path))) {
			kept.set(change.path, change.status === "D" ? null : await read(change.path));
		}

		const made: Checkpoint = { "id": crypto.randomUUID().slice(0, 8), ...label === undefined || label === "" ? {} : { "label": label }, "at": new Date().toISOString(), ...head === undefined ? {} : { "head": head }, "files": kept };

		checkpoints.push(made);
		checkpoints.splice(0, Math.max(0, checkpoints.length - KEPT));

		return listed().at(-1) as Listed;
	});

	const restore = async (id: string): Promise<{ "checkpoint": string; "restored": string[]; "removed": string[] }> => log.span("editor.workbench.checkpoints.restore", { "op": id }, async () => {
		const made = checkpoints.find((each) => each.id === id);

		if (made === undefined) {
			throw new Error(`no checkpoint ${id} here (they're this window's, and don't survive a reload): ${JSON.stringify(listed())}`);
		}

		const { files, head } = await git.status({ "whole": true });

		if (head !== made.head) {
			throw new Error(`HEAD has moved since checkpoint ${made.id} (${made.head?.slice(0, 8) ?? "no commit"} then, ${head?.slice(0, 8) ?? "none"} now): restoring would mean undoing a commit, which is git's to do`);
		}

		// What each file should be: as the checkpoint had it, or, one that matched HEAD then, HEAD's (none, where HEAD hasn't it).
		const edit = new vscode.WorkspaceEdit();
		const saving: vscodeApi.Uri[] = [];
		const restored: string[] = [];
		const removed: string[] = [];

		for (const path of [...new Set([...files.map((change) => change.path), ...made.files.keys()])].filter((each) => !RECORDS.test(each)).sort()) {
			const uri = vscode.Uri.file(`${ROOT}/${path}`);
			const now = await read(path);
			const then = made.files.has(path) ? made.files.get(path) ?? null : await git.file(path).then(({ "head": text }) => (files.find((change) => change.path === path)?.status === "A" ? null : text));

			if (now === then) {
				continue;
			}

			if (then === null) {
				edit.deleteFile(uri, { "ignoreIfNotExists": true });
				removed.push(path);
			} else if (now === null) {
				edit.createFile(uri, { "contents": new TextEncoder().encode(then) });
				restored.push(path);
			} else {
				const document = await vscode.workspace.openTextDocument(uri);

				edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), then);
				saving.push(uri);
				restored.push(path);
			}
		}

		if (edit.size > 0 && !await vscode.workspace.applyEdit(edit)) {
			throw new Error("VS Code didn't apply the restore: nothing was changed");
		}

		for (const uri of saving) {
			await saveDocument(await vscode.workspace.openTextDocument(uri), uri.path.slice(ROOT.length + 1));
		}

		return { "checkpoint": made.id, "restored": restored, "removed": removed };
	});

	/** A checkpoint as a person picks it: its name or time, and how many files it noted. */
	const said = ({ label, at, files }: Listed): string => `${label ?? new Date(at).toLocaleTimeString()} (${String(files)} ${files === 1 ? "file" : "files"} changed then)`;

	vscode.commands.registerCommand("editor.workspace.checkpoint", async (given?: unknown) => {
		const label = typeof given === "string" ? given : await vscode.window.showInputBox({ "title": "Save Checkpoint", "prompt": "A name for it, to tell it apart (optional)", "placeHolder": "before trying…" });

		if (label === undefined) {
			return undefined;
		}

		const made = await checkpoint(label);

		void vscode.window.showInformationMessage(`Checkpoint saved: ${said(made)}. Workspace: Restore Checkpoint… puts every file back as it is now.`);

		return made.id;
	});
	vscode.commands.registerCommand("editor.workspace.restoreCheckpoint", async () => {
		if (checkpoints.length === 0) {
			void vscode.window.showInformationMessage("No checkpoint to restore: Workspace: Save Checkpoint makes one (they're kept in this window until it reloads).");

			return;
		}

		const picked = await vscode.window.showQuickPick(listed().toReversed().map((each) => ({ "label": said(each), "description": new Date(each.at).toLocaleTimeString(), "id": each.id })), { "title": "Restore Checkpoint", "placeHolder": "Every file changed since goes back as it was then" });

		if (picked === undefined) {
			return;
		}

		try {
			const { restored, removed } = await restore(picked.id);

			void vscode.window.showInformationMessage(restored.length + removed.length === 0 ? "Nothing's changed since that checkpoint." : `Restored ${[...restored.length === 0 ? [] : [`${String(restored.length)} ${restored.length === 1 ? "file" : "files"}`], ...removed.length === 0 ? [] : [`removed ${String(removed.length)} made since`]].join(", ")}. Undo takes it back.`);
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	});

	serve(hub, "workspace.checkpoint", async (args) => {
		const { label } = (args ?? {}) as { "label"?: unknown };
		const made = await checkpoint(typeof label === "string" ? label : undefined);

		return { "id": made.id, "files": made.files, "checkpoints": listed() };
	});
	serve(hub, "workspace.restore", async (args) => restore(String((args as { "id"?: unknown } | undefined)?.id ?? "")));
}
