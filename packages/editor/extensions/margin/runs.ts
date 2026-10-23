/**
 * The runs kept of a file, on this machine (RUNTIME-EVIDENCE.md, *Runs kept, as balls*; lib util/silo/traces): every run,
 * values and the text it ran, in `.silo/local/traces/<file>.jsonl`. What's shared in git — the runs of the text a commit
 * commits, a run that could have read inputs by its values' types alone — is worked out as the commit is made (the git
 * engine's pre-commit step, git-engine.ts `shareRuns`).
 */
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import { GITATTRIBUTES, GITIGNORE, localTracesPath, SILO_DIR, withLines } from "@brianjenkins94/util/silo/layout";
import { parseTraces, tracesText, withRun } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";

/** The workspace's root, where `.silo/` is. */
const rootOf = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;

async function read(uri: vscode.Uri): Promise<string | undefined> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
}

async function write(uri: vscode.Uri, text: string): Promise<void> {
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** `.silo/.gitignore` (`/local/`: what stays on this machine) and `.gitattributes` (line files merge by line), seeded
 *  before anything's written under `.silo/` — a local run's values must never reach a commit. */
async function seeded(root: vscode.Uri): Promise<void> {
	for (const [name, wanted] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]]) {
		const uri = vscode.Uri.joinPath(root, SILO_DIR, name);
		const updated = withLines(await read(uri) ?? "", wanted);

		if (updated !== undefined) {
			await write(uri, updated);
		}
	}
}

/** The git blob oid of `text`: what names that text in git (`sha1("blob <length>\0" + text)`). */
export async function blobOid(text: string): Promise<string> {
	const body = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${body.length}\0`);
	const bytes = new Uint8Array(header.length + body.length);

	bytes.set(header);
	bytes.set(body, header.length);

	return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The runs of `file` (from the workspace root) kept on this machine, oldest first. */
export async function keptRuns(file: string): Promise<RunTrace[]> {
	const root = rootOf();

	return root === undefined ? [] : parseTraces(await read(vscode.Uri.joinPath(root, localTracesPath(file))) ?? "");
}

/** Each file's keeping, in turn: a keep reads the file's runs and writes them back with one more, so two at once (a
 *  test file's run kept while another's is) would lose one. */
const keeping = new Map<string, Promise<void>>();

/** Keep `run` on this machine (the last `keep`, the same run counted once). What's shared is worked out as a commit is
 *  made (the git engine's pre-commit step: the runs of the text committed). */
export async function keepRun(run: RunTrace, keep: number): Promise<void> {
	const root = rootOf();

	if (root === undefined) {
		return;
	}

	const local = vscode.Uri.joinPath(root, localTracesPath(run.file));
	const kept = (keeping.get(local.path) ?? Promise.resolve()).then(async () => {
		await seeded(root);
		await write(local, tracesText(withRun(parseTraces(await read(local) ?? ""), run, keep)));
	});
	const settled = kept.catch(() => undefined);

	keeping.set(local.path, settled);
	void settled.then(() => {
		if (keeping.get(local.path) === settled) {
			keeping.delete(local.path);
		}
	});

	await kept;
}
