/**
 * JavaScript for the computation a script is for — counting, joining JSON — with the workspace read-only, for agents:
 * `script.run` { code, timeoutMs? }. The code is an async function's body: what it `return`s is the answer, and
 * `workspace.read(path)`, `workspace.json(path)` and `workspace.glob(pattern, limit?)` read the workspace (a path
 * relative to it, or absolute under it; a glob as VS Code's findFiles takes it, files.exclude applying). What it logs on
 * `console` is kept. Its reader: agents' `script_run`.
 *
 * It runs in the capability-gated realm (editor-api/gated-eval): a worker of its own with no network and no way to start
 * another, whose one way out is these reads, served here. So what it touched is all in its answer's `touched`: the
 * files it read, the globs it asked, and each capability it tried and was refused (`net:*`, `eval:worker`). It has no
 * `require` and nothing that writes. One script runs at a time, so what each touched is its own.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { gatedEvalRealm } from "@brianjenkins94/editor-api/gated-eval";
import { serve } from "@brianjenkins94/hub";

const ROOT = "/workspace";

/** How long a script may take by default, and at most. */
const TIMEOUT_MS = 30_000;
const MOST_TIMEOUT_MS = 120_000;

/** What a script may read: files, and their bytes in all; what a glob finds by default, and at most. */
const READS = 5000;
const READ_BYTES = 64 * 1024 * 1024;
const GLOBBED = 1000;
const MOST_GLOBBED = 10_000;

/** What's answered of it at most: its value as JSON, its log's lines and each line's characters, the files listed. */
const VALUE_CHARS = 100_000;
const LOG_LINES = 500;
const LOG_LINE_CHARS = 2000;
const LISTED = 200;

/** Before the script's body: the workspace it reads, through the realm's one way out, and no `require`. */
const PRELUDE = "const workspace = Object.freeze({ read: (path) => host(\"read\", path), json: async (path) => JSON.parse(await host(\"read\", path)), glob: (pattern, limit) => host(\"glob\", pattern, limit) }); module.exports = async () => { const require = () => { throw new Error(\"a script has no require: it reads the workspace with workspace.read, workspace.json and workspace.glob\"); };\n";

/** A value as an agent reads it: whole, or as much of its JSON as fits, saying how much there was. */
export function bounded(value: unknown): Record<string, unknown> {
	const text = JSON.stringify(value);

	if (text === undefined || text.length <= VALUE_CHARS) {
		return { "value": value };
	}

	return { "valueText": text.slice(0, VALUE_CHARS), "truncated": { "chars": text.length, "shown": VALUE_CHARS } };
}

/** A log as an agent reads it: its first lines, each cut to length, and how many were left out. */
export function boundedLogs(logs: string[]): Record<string, unknown> {
	const lines = logs.slice(0, LOG_LINES).map((line) => (line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}… (${String(line.length)} characters)` : line));

	return { "logs": lines, ...logs.length > LOG_LINES ? { "logsLeftOut": logs.length - LOG_LINES } : {} };
}

export function installScriptRun(vscode: typeof vscodeApi, hub: Hub): void {
	const uriOf = (path: unknown): vscodeApi.Uri => {
		if (typeof path !== "string" || path === "") {
			throw new TypeError("a path, relative to the workspace or absolute under it");
		}

		const absolute = path.startsWith("/") ? path : `${ROOT}/${path}`;

		if (absolute !== ROOT && !absolute.startsWith(ROOT + "/")) {
			throw new Error(`${path} is outside the workspace`);
		}

		return vscode.Uri.file(absolute);
	};
	const relative = (uri: vscodeApi.Uri): string => (uri.path.startsWith(ROOT + "/") ? uri.path.slice(ROOT.length + 1) : uri.path);
	// (one at a time: the realm's refused attempts are then this script's alone)
	let queue: Promise<unknown> = Promise.resolve();

	serve(hub, "script.run", async (args) => {
		const { code, timeoutMs } = (args ?? {}) as { "code"?: unknown; "timeoutMs"?: unknown };

		if (typeof code !== "string" || code.trim() === "") {
			throw new TypeError("script.run takes { code, timeoutMs? }: an async function's body, which returns its answer");
		}

		const limit = typeof timeoutMs === "number" && timeoutMs > 0 ? Math.min(timeoutMs, MOST_TIMEOUT_MS) : TIMEOUT_MS;
		const read: string[] = [];
		const globs: string[] = [];
		let bytes = 0;
		const services = {
			"read": async (path: unknown): Promise<string> => {
				if (read.length >= READS || bytes >= READ_BYTES) {
					throw new Error(`a script reads at most ${String(READS)} files, ${String(READ_BYTES / 1024 / 1024)} MB in all`);
				}

				const uri = uriOf(path);
				const contents = await Promise.resolve(vscode.workspace.fs.readFile(uri)).catch(() => {
					throw new Error(`no file ${relative(uri)}`);
				});

				read.push(relative(uri));
				bytes += contents.byteLength;

				return new TextDecoder().decode(contents);
			},
			"glob": async (pattern: unknown, most: unknown): Promise<string[]> => {
				if (typeof pattern !== "string" || pattern === "") {
					throw new TypeError("workspace.glob takes a pattern (\"**/*.ts\") and, if you like, how many at most");
				}

				globs.push(pattern);

				const found = await vscode.workspace.findFiles(pattern, undefined, typeof most === "number" && most > 0 ? Math.min(most, MOST_GLOBBED) : GLOBBED);

				return found.map(relative).toSorted();
			}
		};
		const started = Date.now();
		const ran = queue.then(async () => gatedEvalRealm(`${PRELUDE}${code}\n};`, {}, limit, services as Record<string, (...args: unknown[]) => Promise<unknown>>));

		queue = ran.catch(() => undefined);

		const result = await ran;
		const touched = { "read": read.slice(0, LISTED), ...read.length > LISTED ? { "readLeftOut": read.length - LISTED } : {}, "bytes": bytes, "globs": globs.slice(0, LISTED), "refused": [...new Set(result.attempts)] };
		const ended = result.error === undefined ? bounded(result.value) : { "error": result.error === "timed out" ? `timed out after ${String(limit)} ms (the realm was stopped)` : result.error };

		return { ...ended, ...boundedLogs(result.logs ?? []), "touched": touched, "ms": Date.now() - started };
	});
}
