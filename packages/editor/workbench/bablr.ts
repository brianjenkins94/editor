/**
 * Which files BABLR parses, and a warning on each one it can't (*Unparsable files flagged*): nothing can attach to code
 * BABLR can't parse — no note, no runtime evidence — so a file it can't take is said in Problems, with why, until it
 * parses again. And how much of a folder it takes, for the rewrite's Measure (ARCHITECTURE.md, *Comments become
 * notes*: what of the scope BABLR parses is measured first).
 *
 * - the command `editor.bablr.check` ("BABLR: Check Which Files Parse…"): a folder's code files parsed one at a time,
 *   with a progress notification to cancel it by, the ones BABLR can't take in Problems, and what it took said;
 * - `bablr.check` { path, exclude? }: the same, for agents' `code_parses`, with each file it can't parse and why.
 *
 * And a text with its comments blanked (`stripped`), for the code alone (git-refs.ts' `.refs/<name>~stripped/`).
 *
 * BABLR runs in its own worker (workers/bablr-worker.ts), started the first time it's asked — not at boot: it's a big
 * bundle — and asked one text at a time, each kept by its blob oid there, so a file is parsed once. A file whose warning
 * shows is parsed again as it's saved.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";

const DIR = "/workspace";

/** The files BABLR's grammar may take. */
const CODE_FILES = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** A why, at most this long in a warning or an answer (BABLR's can carry the parser's state). */
const MOST_WHY = 300;

/** What the worker says of a text: whether BABLR parses it, why not, and where its comments are (each one's start and
 *  end, in turn). */
interface Parse { "parsed": boolean; "why"?: string; "comments"?: number[]; "ms": number; "cached": boolean }

/** What else reads BABLR: a text with its comments blanked (git-refs.ts' stripped view). */
export interface Bablr {
	/** `text` with each comment's characters spaces but its line breaks — line for line the text as it is — or
	 *  undefined where BABLR can't parse it. */
	"stripped": (text: string, signal?: AbortSignal) => Promise<string | undefined>;
}

/** A folder's files, checked. */
interface Checked {
	"path": string;
	"files": number;
	"parsed": number;
	"lines": number;
	"parsedLines": number;
	"ms": number;
	"cached": number;
	"cancelled"?: true;
	"unparsable": { "file": string; "lines": number; "why": string }[];
}

export function installBablr(vscode: typeof vscodeApi, hub: Hub, log: Logger): Bablr {
	const diagnostics = vscode.languages.createDiagnosticCollection("BABLR");
	let started: { "request": (source: string, signal?: AbortSignal) => Promise<Parse> } | undefined;

	/** The worker, started on first use, asked one text at a time: BABLR is slow, and a check is many. */
	const worker = (): NonNullable<typeof started> => {
		if (started !== undefined) {
			return started;
		}

		const spawned = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
		const dead = new AbortController();
		const rpc = createRpcClient(hub);
		let tail: Promise<unknown> = Promise.resolve();

		hub.link(portTransport(spawned));
		watchWorker(spawned, "bablr-worker", (message) => {
			dead.abort(new Error("BABLR's worker failed: " + message));
			started = undefined;
		});

		started = {
			"request": async (source, signal) => {
				const combined = signal === undefined ? dead.signal : AbortSignal.any([signal, dead.signal]);
				// (no timeout: the first waits out the worker's bundle loading, and a parse takes what it takes)
				const run = tail.then(async () => rpc.request("bablr.parse", { "source": source }, { "timeoutMs": Infinity, "waitForResponderMs": 60_000, "signal": combined }) as Promise<Parse>);

				tail = run.catch(() => undefined);

				return run;
			}
		};

		return started;
	};

	/** `uri`'s text parsed, and its warning set or cleared by what BABLR says. */
	const parse = async (uri: vscodeApi.Uri, text: string, signal?: AbortSignal): Promise<Parse> => {
		const answer = await worker().request(text, signal);

		if (answer.parsed) {
			diagnostics.delete(uri);
		} else {
			const why = (answer.why ?? "BABLR can't parse it").slice(0, MOST_WHY);
			const warning = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `BABLR can't parse this file, so nothing can be attached to its code (notes, runtime evidence): ${why}`, vscode.DiagnosticSeverity.Warning);

			warning.source = "BABLR";
			diagnostics.set(uri, [warning]);
		}

		return answer;
	};

	/** Every code file under `path` (relative to the workspace) parsed, but those `exclude` matches: what BABLR takes. */
	const check = async (path: string, exclude: string | undefined, signal: AbortSignal, progress?: (done: number, of: number) => void): Promise<Checked> => log.span("editor.workbench.bablr.check", { "path": path }, async (span) => {
		const base = vscode.Uri.file(path === "" || path === "." ? DIR : `${DIR}/${path.replace(/^\/+|\/+$/gu, "")}`);
		const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(base, CODE_FILES), exclude === undefined ? "**/node_modules/**" : `{**/node_modules/**,${exclude}}`)).toSorted((one, other) => one.path.localeCompare(other.path));
		const checked: Checked = { "path": path, "files": files.length, "parsed": 0, "lines": 0, "parsedLines": 0, "ms": 0, "cached": 0, "unparsable": [] };
		const begun = performance.now();

		for (const [at, uri] of files.entries()) {
			if (signal.aborted) {
				checked.cancelled = true;

				break;
			}

			progress?.(at, files.length);

			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			const lines = text.split("\n").length;
			const answer = await parse(uri, text, signal).catch((error: unknown) => {
				if (signal.aborted) {
					return undefined;
				}

				throw error;
			});

			if (answer === undefined) {
				checked.cancelled = true;

				break;
			}

			checked.lines += lines;
			checked.cached += answer.cached ? 1 : 0;

			if (answer.parsed) {
				checked.parsed += 1;
				checked.parsedLines += lines;
			} else {
				checked.unparsable.push({ "file": vscode.workspace.asRelativePath(uri, false), "lines": lines, "why": (answer.why ?? "").slice(0, MOST_WHY) });
			}
		}

		checked.ms = Math.round(performance.now() - begun);
		span.end({ "count": checked.files, "parsed": checked.parsed, "lines": checked.lines, "parsedLines": checked.parsedLines, "cached": checked.cached });

		return checked;
	});

	// (a file whose warning shows is parsed again as it's saved: it goes when it parses)
	vscode.workspace.onDidSaveTextDocument((document) => {
		if (diagnostics.has(document.uri)) {
			void parse(document.uri, document.getText()).catch(() => undefined);
		}
	});

	vscode.commands.registerCommand("editor.bablr.check", async () => {
		const path = await vscode.window.showInputBox({ "title": "BABLR: Check Which Files Parse", "prompt": "The folder, from the workspace's root (empty: all of it)", "placeHolder": "packages/editor" });

		if (path === undefined) {
			return;
		}

		const checked = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": "BABLR", "cancellable": true }, async (report, token) => {
			const cancelled = new AbortController();

			token.onCancellationRequested(() => {
				cancelled.abort();
			});

			return check(path.trim(), undefined, cancelled.signal, (done, of) => {
				report.report({ "message": `${String(done)} of ${String(of)} files`, "increment": 100 / of });
			});
		});
		const percent = checked.lines === 0 ? 100 : Math.round((checked.parsedLines / checked.lines) * 100);
		const said = `BABLR parses ${String(checked.parsed)} of ${String(checked.files)} files${checked.path === "" ? "" : " in " + checked.path} — ${String(percent)}% of their ${String(checked.lines)} lines${checked.cancelled === true ? " (cancelled)" : ""}.`;

		if (checked.unparsable.length === 0) {
			void vscode.window.showInformationMessage(said);
		} else if (await vscode.window.showWarningMessage(said + " The rest are in Problems.", "Show Problems") !== undefined) {
			await vscode.commands.executeCommand("workbench.actions.view.problems");
		}
	});

	serve(hub, "bablr.check", async (args, { signal }) => {
		const { path, exclude } = (args ?? {}) as { "path"?: unknown; "exclude"?: unknown };

		if (typeof path !== "string" || (exclude !== undefined && typeof exclude !== "string")) {
			throw new TypeError("bablr.check takes { path, exclude? }: a folder from the workspace's root, and a glob to leave out");
		}

		return check(path, exclude, signal);
	});

	return {
		"stripped": async (text, signal) => {
			const { parsed, comments = [] } = await worker().request(text, signal);

			if (!parsed) {
				return undefined;
			}

			let blanked = "";
			let at = 0;

			for (let index = 0; index < comments.length; index += 2) {
				blanked += text.slice(at, comments[index]) + text.slice(comments[index], comments[index + 1]).replace(/[^\n]/gu, " ");
				at = comments[index + 1];
			}

			return blanked + text.slice(at);
		}
	};
}
