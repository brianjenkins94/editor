import type { Effect } from "@brianjenkins94/editor-api";
import type { RuntimeDecision } from "@brianjenkins94/editor-api/runtime";
import type { Hub } from "@brianjenkins94/hub";
import { recordEffect } from "@brianjenkins94/editor-api/effects";
import { verdictOf } from "@brianjenkins94/editor-api/gate";
import { answerMailbox, runtimeSession } from "@brianjenkins94/editor-api/runtime";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { decideCapabilityAs } from "./capabilities/decide";
import { policyFor, takeOnce } from "./capability-stops";
import { countCall } from "../../shared/fs-boundaries";

const READS = new Set(["readFile", "stat", "readdir"]);
const WRITES = new Set(["writeFile", "mkdir", "rm", "rename"]);

const CODES: Record<string, string> = { "FileNotFound": "ENOENT", "FileExists": "EEXIST", "FileIsADirectory": "EISDIR", "FileNotADirectory": "ENOTDIR", "NoPermissions": "EACCES", "Unavailable": "EAGAIN" };

interface Answer { "meta": Record<string, unknown>; "payload"?: Uint8Array }

function failure(message: string, code: string): Error {
	return Object.assign(new Error(message), { "code": code });
}

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

async function perform(op: string, path: string, payload: Uint8Array, to?: string): Promise<Answer> {
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

			case "readdir": {
				const listed = await vscode.workspace.fs.readDirectory(uri);

				return { "meta": { "entries": listed.map(([name]) => name), "types": listed.map(([, type]) => ((type & vscode.FileType.Directory) === 0 ? "file" : "directory")) } };
			}
			case "writeFile":
				await vscode.workspace.fs.writeFile(uri, payload);

				return { "meta": {} };
			case "mkdir":
				await vscode.workspace.fs.createDirectory(uri);

				return { "meta": {} };
			case "rm":
				await vscode.workspace.fs.delete(uri, { "recursive": true, "useTrash": false });

				return { "meta": {} };
			case "rename":
				await vscode.workspace.fs.rename(uri, vscode.Uri.file(to), { "overwrite": true });

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

function skipped(op: string): Answer {
	return { "meta": op === "readdir" ? { "entries": [] } : {}, ...op === "readFile" ? { "payload": new Uint8Array() } : {} };
}

export function serveRuntimeFiles(context: vscode.ExtensionContext, hub: Hub): void {
	const rpc = createRpcClient(hub);
	const sessions = new Map<string, vscode.DebugSession>();
	const stops = new Map<string, (() => void)[]>();

	const decide = async (session: string | undefined, capability: string, path: string): Promise<{ "verdict": "allow" | "skip" | "deny"; "decided": NonNullable<Effect["decided"]> }> => {
		const once = session === undefined ? undefined : takeOnce(session, capability, path);

		if (once !== undefined) {
			return { "verdict": once, "decided": once === "allow" ? "once" : "refused" };
		}

		return { "verdict": verdictOf(await policyFor(session), capability, path, session !== undefined && sessions.get(session)?.configuration["__live"] === true), "decided": "policy" };
	};

	const counted = (session: string | undefined, capability: string, path: string, how: Effect["how"], decided?: Effect["decided"]): Effect["how"] => {
		const runId = session === undefined ? undefined : sessions.get(session)?.configuration["__runId"];

		if (typeof runId === "string") {
			recordEffect(runId, capability, path, how, 1, decided);
		}

		return how;
	};

	const answer = async (session: string | undefined, meta: Record<string, unknown>, payload: Uint8Array): Promise<Answer & { "how"?: Effect["how"] }> => {
		const op = meta["op"] as string;

		if (op === "decide") {
			const call = (meta["call"] ?? {}) as RuntimeDecision;
			const runId = session === undefined ? undefined : sessions.get(session)?.configuration["__runId"];

			return { "meta": await decideCapabilityAs({ "kind": call.kind, ...call.method === undefined ? {} : { "method": call.method }, ...call.op === undefined ? {} : { "op": call.op }, "args": call.args, "package": call.package, ...call.why === undefined ? {} : { "why": call.why }, ...typeof runId === "string" ? { "runId": runId } : {} }) as unknown as Record<string, unknown> };
		}

		if (op === "tarball") {
			return { "meta": {}, "payload": await rpc.request("packages.tarball", { "name": meta["name"], "version": meta["version"] }, { "timeoutMs": 300_000, "waitForResponderMs": 30_000 }).catch((error: unknown) => {
				throw failure(`ENOENT: ${String(meta["name"])}@${String(meta["version"])}'s tarball: ${error instanceof Error ? error.message : String(error)}`, "ENOENT");
			}) as Uint8Array };
		}

		const path = workspacePath(meta["path"]);

		if (!READS.has(op) && !WRITES.has(op)) {
			throw failure(`unknown call "${op}"`, "EINVAL");
		}

		const to = op === "rename" ? workspacePath(meta["to"]) : undefined;

		if (path === undefined || (op === "rename" && to === undefined)) {
			throw failure(`EACCES: ${(path === undefined ? meta["path"] : meta["to"]) as string} isn't in the workspace`, "EACCES");
		}

		if (meta["load"] === true && READS.has(op)) {
			return perform(op, path, payload);
		}

		const capability = READS.has(op) ? "fs:read" : "fs:write";
		const paths = to === undefined ? [path] : [path, to];
		const decisions = await Promise.all(paths.map(async (each) => decide(session, capability, each)));
		const verdicts = decisions.map((each) => each.verdict);
		const decided = decisions.find((each) => each.decided !== "policy")?.decided ?? "policy";
		let verdict: "deny" | "skip" | "allow" = "allow";

		if (verdicts.includes("deny")) {
			verdict = "deny";
		} else if (verdicts.includes("skip")) {
			verdict = "skip";
		}

		const count = (how: Effect["how"]): Effect["how"] => paths.map((each) => counted(session, capability, each, how, decided))[0];

		if (verdict === "skip") {
			return { ...skipped(op), "how": count("skipped") };
		}

		if (verdict === "deny") {
			count("denied");

			throw failure(`EACCES: permission denied — ${capability} ${paths.join(" → ")} isn't allowed (the policy decides it, and it wasn't asked)`, "EACCES");
		}

		const how = count("made");

		return { ...await perform(op, path, payload, to), "how": how };
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
		{ "dispose": serve(hub, "runtime.fs.attach", (args, { from }) => {
			const { mailbox } = (args ?? {}) as { "mailbox"?: unknown };

			if (!(mailbox instanceof SharedArrayBuffer)) {
				throw new TypeError("runtime.fs.attach: a mailbox (a SharedArrayBuffer)");
			}

			const bound = from === undefined ? undefined : runtimeSession(from);
			const who = from?.split("#")[0] ?? "runtime";
			const stop = answerMailbox(mailbox, async (meta, payload) => {
				const op = typeof meta["op"] === "string" ? meta["op"] : "unknown";
				const path = typeof meta["path"] === "string" ? meta["path"] : undefined;
				const started = performance.now();

				try {
					const { how: _how, ...answered } = await answer(bound, meta, payload);

					countCall("runtime-fs", op, who, performance.now() - started, path, (answered.payload?.length ?? 0) + payload.length);

					return answered;
				} catch (error) {
					countCall("runtime-fs", op + "-failed", who, performance.now() - started, path);

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
