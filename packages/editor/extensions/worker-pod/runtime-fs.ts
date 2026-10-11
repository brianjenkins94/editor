/**
 * The runtime's files (EXTENSION-POINTS.md, 2, *The runtime's files, through core*): a debugger's worker reads and
 * writes the workspace synchronously through its mailbox (run-contract's `connectRuntime`), and each call is answered
 * here — an open editor's unsaved text for a read, a write as the workspace's (editors, Source Control and watchers see
 * it). A call of the program's (not the debugger's own `load`) is decided as tsval decides its own: by the session's
 * policy (`policyFor`, its "this run" answers included, and a call it was just told to make once), and a live run makes
 * nothing but a read the policy allows. What a call did goes back with its answer, for the debugger's `effects`.
 *
 * The gate keeps the program to the policy, whichever debugger runs it; the debugger's extension is trusted as any
 * extension is (it has `vscode.workspace.fs`).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type { Effect } from "@brianjenkins94/run-contract";
import { serve } from "@brianjenkins94/hub";
import { answerMailbox } from "@brianjenkins94/run-contract/runtime";
import * as vscode from "vscode";
import { policyFor, takeOnce } from "./capability-stops";
import { verdictOf } from "./gate";

const READS = new Set(["readFile", "stat", "readdir"]);
const WRITES = new Set(["writeFile", "mkdir", "rm"]);

/** VS Code's file errors, as node names them. */
const CODES: Record<string, string> = { "FileNotFound": "ENOENT", "FileExists": "EEXIST", "FileIsADirectory": "EISDIR", "FileNotADirectory": "ENOTDIR", "NoPermissions": "EACCES", "Unavailable": "EAGAIN" };

type Answer = { "meta": Record<string, unknown>; "payload"?: Uint8Array };

function failure(message: string, code: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), { "code": code }, extra);
}

/** `path`, normalized — if it's in the workspace. */
function workspacePath(path: unknown): string | undefined {
	if (typeof path !== "string" || !path.startsWith("/")) {
		return undefined;
	}

	const parts: string[] = [];

	for (const part of path.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	const normal = "/" + parts.join("/");

	return normal === "/workspace" || normal.startsWith("/workspace/") ? normal : undefined;
}

/** The call, made. */
async function perform(op: string, path: string, payload: Uint8Array): Promise<Answer> {
	const uri = vscode.Uri.file(path);

	try {
		switch (op) {
			case "readFile": {
				const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.path === path);

				return { "meta": {}, "payload": open === undefined ? await vscode.workspace.fs.readFile(uri) : new TextEncoder().encode(open.getText()) };
			}
			case "stat": {
				const stat = await vscode.workspace.fs.stat(uri).then((found) => found, () => undefined);

				return { "meta": stat === undefined ? {} : { "stat": { "type": (stat.type & vscode.FileType.Directory) === 0 ? "file" : "directory", "size": stat.size, "mtime": stat.mtime } } };
			}
			case "readdir":
				return { "meta": { "entries": (await vscode.workspace.fs.readDirectory(uri)).map(([name]) => name) } };
			case "writeFile":
				await vscode.workspace.fs.writeFile(uri, payload);

				return { "meta": {} };
			case "mkdir":
				await vscode.workspace.fs.createDirectory(uri);

				return { "meta": {} };
			case "rm":
				await vscode.workspace.fs.delete(uri, { "recursive": true, "useTrash": false });

				return { "meta": {} };
			default:
				throw failure(`unknown call "${op}"`, "EINVAL");
		}
	} catch (error) {
		if (error instanceof vscode.FileSystemError) {
			throw failure(`${CODES[error.code] ?? "EIO"}: ${error.message}`, CODES[error.code] ?? "EIO");
		}

		throw error;
	}
}

/** What a skipped call answers: as if there were nothing there, and nothing done. */
function skipped(op: string): Answer {
	return { "meta": op === "readdir" ? { "entries": [] } : {}, ...op === "readFile" ? { "payload": new Uint8Array() } : {} };
}

/** Answer each debugger worker's file calls, once it hands over its mailbox (`runtime.fs.attach`). */
export function serveRuntimeFiles(context: vscode.ExtensionContext, hub: Hub, log: Observed["log"]): void {
	const sessions = new Map<string, vscode.DebugSession>();
	/** Each session's mailboxes, stopped as it ends. */
	const stops = new Map<string, (() => void)[]>();

	/** How the program's call of `capability` on `path` goes: as the policy decides, unless told once. */
	const decide = async (session: string | undefined, capability: string, path: string): Promise<"allow" | "skip" | "deny"> => {
		const once = session === undefined ? undefined : takeOnce(session, capability, path);

		if (once !== undefined) {
			return once;
		}

		return verdictOf(await policyFor(session), capability, path, session !== undefined && sessions.get(session)?.configuration["__live"] === true);
	};

	const answer = async (session: string | undefined, meta: Record<string, unknown>, payload: Uint8Array): Promise<Answer> => {
		const op = String(meta["op"]);
		const path = workspacePath(meta["path"]);

		if (!READS.has(op) && !WRITES.has(op)) {
			throw failure(`unknown call "${op}"`, "EINVAL");
		}

		if (path === undefined) {
			throw failure(`EACCES: ${String(meta["path"])} isn't in the workspace`, "EACCES");
		}

		// The debugger's own: the program and what it imports, read.
		if (meta["load"] === true && READS.has(op)) {
			return perform(op, path, payload);
		}

		const capability = READS.has(op) ? "fs:read" : "fs:write";
		const verdict = await decide(session, capability, path);
		const told = (how: Effect["how"]): Record<string, unknown> => ({ "how": how, "capability": capability });

		if (verdict === "skip") {
			const answered = skipped(op);

			return { ...answered, "meta": { ...answered.meta, ...told("skipped") } };
		}

		if (verdict === "deny") {
			throw failure(`EACCES: permission denied — ${capability} ${path} isn't allowed (the policy decides it, and it wasn't asked)`, "EACCES", told("denied"));
		}

		try {
			const made = await perform(op, path, payload);

			return { ...made, "meta": { ...made.meta, ...told("made") } };
		} catch (error) {
			throw Object.assign(error as Error, told("made"));
		}
	};

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => { sessions.set(session.id, session); }),
		vscode.debug.onDidTerminateDebugSession((session) => {
			sessions.delete(session.id);

			for (const stop of stops.get(session.id) ?? []) {
				stop();
			}

			stops.delete(session.id);
		}),
		{ "dispose": serve(hub, "runtime.fs.attach", (args) => {
			const { mailbox, session } = (args ?? {}) as { "mailbox"?: unknown; "session"?: unknown };

			if (!(mailbox instanceof SharedArrayBuffer)) {
				throw new TypeError("runtime.fs.attach: a mailbox (a SharedArrayBuffer)");
			}

			const bound = typeof session === "string" ? session : undefined;
			const stop = answerMailbox(mailbox, async (meta, payload) => {
				const span = log.span("runtime.fs", { "op": String(meta["op"]), "path": String(meta["path"]), ...bound === undefined ? {} : { "session": bound } });

				try {
					const answered = await answer(bound, meta, payload);

					span.end({ ...answered.meta["how"] === undefined ? {} : { "how": answered.meta["how"] }, "bytes": answered.payload?.length ?? 0 });

					return answered;
				} catch (error) {
					span.end({ "error": (error as { "code"?: string }).code ?? String(error) });

					throw error;
				}
			});

			if (bound !== undefined) {
				stops.set(bound, [...stops.get(bound) ?? [], stop]);
			}

			return true;
		}) }
	);
}
