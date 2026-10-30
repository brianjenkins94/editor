/**
 * Experiments that undo themselves, for agents (NEXT.md item 2): `workspace.checkpoint` notes the working tree as it
 * stands against HEAD — every changed file's text, and which files weren't there — and `workspace.restore` puts every
 * file changed since back as it was then: a file made since deleted, one deleted since made again, the rest's text as
 * it was. Its readers: agents' `workspace_checkpoint` and `workspace_restore`.
 *
 * What a checkpoint covers is what git sees (the git service's status): the files it tracks and those it would, not
 * what it ignores (node_modules, `.silo/local/`), and not `.silo/` itself: the editor keeps its records there as it
 * goes (the baseline, the pinned versions), and a restore would undo the editor's work, not the agent's. A restore is one WorkspaceEdit — an open editor shows it, undo takes it
 * back — and every file it changes is saved. A commit since the checkpoint moves HEAD, and then a restore would have to
 * undo the commit too: it refuses, saying so. Checkpoints are kept in this page, the last few, and don't survive a
 * reload.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { GitReader } from "./git-service";
import { serve } from "@brianjenkins94/hub";
import { saveDocument } from "./workspace-tools";

const ROOT = "/workspace";

/** The editor's own records, which it writes as it goes: not an agent's change to put back. */
const RECORDS = /^\.silo\//u;

/** The checkpoints kept, at most (the oldest goes first). */
const KEPT = 10;

/** A checkpoint: HEAD then, and each file that differed from it — its text, or null where there was none. */
interface Checkpoint { "id": string; "label"?: string; "at": string; "head"?: string; "files": Map<string, string | null> }

export function installCheckpoints(vscode: typeof vscodeApi, hub: Hub, git: GitReader): void {
	const checkpoints: Checkpoint[] = [];
	const read = async (path: string): Promise<string | null> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => new TextDecoder().decode(bytes), () => null);
	const listed = (): { "id": string; "label"?: string; "at": string; "files": number }[] => checkpoints.map(({ id, label, at, files }) => ({ "id": id, ...label === undefined ? {} : { "label": label }, "at": at, "files": files.size }));

	serve(hub, "workspace.checkpoint", async (args) => {
		const { label } = (args ?? {}) as { "label"?: unknown };
		const { files, head } = await git.status();
		const kept = new Map<string, string | null>();

		for (const change of files.filter(({ path }) => !RECORDS.test(path))) {
			kept.set(change.path, change.status === "D" ? null : await read(change.path));
		}

		const checkpoint: Checkpoint = { "id": crypto.randomUUID().slice(0, 8), ...typeof label === "string" && label !== "" ? { "label": label } : {}, "at": new Date().toISOString(), ...head === undefined ? {} : { "head": head }, "files": kept };

		checkpoints.push(checkpoint);
		checkpoints.splice(0, Math.max(0, checkpoints.length - KEPT));

		return { "id": checkpoint.id, "files": kept.size, "checkpoints": listed() };
	});

	serve(hub, "workspace.restore", async (args) => {
		const { id } = (args ?? {}) as { "id"?: unknown };
		const checkpoint = checkpoints.find((each) => each.id === id);

		if (checkpoint === undefined) {
			throw new Error(`no checkpoint ${String(id)} here (they're this page's, and don't survive a reload): ${JSON.stringify(listed())}`);
		}

		const { files, head } = await git.status();

		if (head !== checkpoint.head) {
			throw new Error(`HEAD has moved since checkpoint ${checkpoint.id} (${checkpoint.head?.slice(0, 8) ?? "no commit"} then, ${head?.slice(0, 8) ?? "none"} now): restoring would mean undoing a commit, which is git's to do`);
		}

		// What each file should be: as the checkpoint had it, or — one that matched HEAD then — HEAD's (none, where HEAD
		// hasn't it).
		const edit = new vscode.WorkspaceEdit();
		const saving: vscodeApi.Uri[] = [];
		const restored: string[] = [];
		const removed: string[] = [];

		for (const path of [...new Set([...files.map((change) => change.path), ...checkpoint.files.keys()])].filter((each) => !RECORDS.test(each)).sort()) {
			const uri = vscode.Uri.file(`${ROOT}/${path}`);
			const now = await read(path);
			const then = checkpoint.files.has(path) ? checkpoint.files.get(path) ?? null : await git.file(path).then(({ head: text }) => (files.find((change) => change.path === path)?.status === "A" ? null : text));

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

		return { "checkpoint": checkpoint.id, "restored": restored, "removed": removed };
	});
}
