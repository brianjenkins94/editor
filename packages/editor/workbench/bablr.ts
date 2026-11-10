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
 * And what's placed on code stays on it: `editor.annotations.spans`, `.refer` and `.resolve`, for anything an extension attaches to
 * code (editor-api's annotations.ts is their contract; RUNTIME-EVIDENCE.md, *Durable annotations on spans*). A reference not
 * found by its own id is looked for further: followed from the commit or text it was made against, and in the other changed files.
 *
 * BABLR runs in its own worker (workers/bablr-worker.ts), started the first time it's asked — not at boot: it's a big
 * bundle — and asked one text at a time, each kept by its blob oid there, so a file is parsed once. A file whose warning
 * shows is parsed again as it's saved.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { ChangeVerdict } from "@brianjenkins94/editor-api/git";
import type { SpanRef } from "@brianjenkins94/util/silo/annotations";
import type * as vscodeApi from "vscode";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { blobText, status } from "./git-engine";

const DIR = "/workspace";

/** The files BABLR's grammar may take. */
const CODE_FILES = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** Where a moved span may be looked for, and in how many changed files at most. */
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const MOST_OTHERS = 50;

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
	/** Every span of `source` (evidence.ts keys a site on the one that's exactly its node), or why BABLR can't parse it. */
	"spans": (source: string) => Promise<{ "spans"?: { "id": string; "type"?: string; "start": number; "end": number }[]; "unparsable"?: string }>;
	/** The span each range anchors to, as a reference (evidence.ts keys a statement on it), or why BABLR can't parse it. */
	"refer": (source: string, file: string, ranges: { "start": number; "end": number }[]) => Promise<{ "refs"?: (SpanRef | null)[]; "unparsable"?: string }>;
	/** A file's texts since the last commit, [HEAD, …each burst after it], as the code each change touched (edit-history.ts):
	 *  none where BABLR can't parse one. */
	"editGroups": (chain: string[]) => Promise<{ "groups": EditGroup[]; "bursts": number }>;
}

/** What a file's edits since the last commit touched: a node's label and kind, its working lines, and how many bursts. */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

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
	let started: { "ask": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T> } | undefined;

	const warn = (uri: vscodeApi.Uri, why: string): void => {
		const warning = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `BABLR can't parse this file, so nothing can be attached to its code (notes, runtime evidence): ${why.slice(0, MOST_WHY)}`, vscode.DiagnosticSeverity.Warning);

		warning.source = "BABLR";
		diagnostics.set(uri, [warning]);
	};

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
			"ask": async <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => {
				const combined = signal === undefined
					? dead.signal
					: AbortSignal.any([signal, dead.signal]);
				// (no timeout: the first waits out the worker's bundle loading, and a parse takes what it takes)
				const run = tail.then(async () => rpc.request(`bablr.${name}`, args, { "timeoutMs": Infinity, "waitForResponderMs": 60_000, "signal": combined }) as Promise<T>);

				tail = run.catch(() => undefined);

				return run;
			}
		};

		return started;
	};

	/** `uri`'s text parsed, and its warning set or cleared by what BABLR says. */
	const parse = async (uri: vscodeApi.Uri, text: string, signal?: AbortSignal): Promise<Parse> => {
		const answer = await worker().ask<Parse>("parse", { "source": text }, signal);

		if (answer.parsed) {
			diagnostics.delete(uri);
		} else {
			warn(uri, answer.why ?? "BABLR can't parse it");
		}

		return answer;
	};

	/** Every code file under `path` (relative to the workspace) parsed, but those `exclude` matches: what BABLR takes. */
	const check = async (path: string, exclude: string | undefined, signal: AbortSignal, progress?: (done: number, of: number) => void): Promise<Checked> => log.span("editor.workbench.bablr.check", { "path": path }, async (span) => {
		const base = vscode.Uri.file(path === "" || path === "."
			? DIR
			: `${DIR}/${path.replace(/^\/+|\/+$/gu, "")}`);
		const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(base, CODE_FILES), exclude === undefined
			? "**/node_modules/**"
			: `{**/node_modules/**,${exclude}}`)).toSorted((one, other) => one.path.localeCompare(other.path));
		const checked: Checked = {
			"path": path,
			"files": files.length,
			"parsed": 0,
			"lines": 0,
			"parsedLines": 0,
			"ms": 0,
			"cached": 0,
			"unparsable": []
		};
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
				checked.unparsable.push({
					"file": vscode.workspace.asRelativePath(uri, false),
					"lines": lines,
					"why": (answer.why ?? "").slice(0, MOST_WHY)
				});
			}
		}

		checked.ms = Math.round(performance.now() - begun);
		span.end({
			"count": checked.files,
			"parsed": checked.parsed,
			"lines": checked.lines,
			"parsedLines": checked.parsedLines,
			"cached": checked.cached
		});

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
		const percent = checked.lines === 0
			? 100
			: Math.round((checked.parsedLines / checked.lines) * 100);
		const said = `BABLR parses ${String(checked.parsed)} of ${String(checked.files)} files${checked.path === ""
			? ""
			: " in " + checked.path} — ${String(percent)}% of their ${String(checked.lines)} lines${checked.cancelled === true
			? " (cancelled)"
			: ""}.`;

		if (checked.unparsable.length === 0) {
			void vscode.window.showInformationMessage(said);
		} else if (await vscode.window.showWarningMessage(said + " The rest are in Problems.", "Show Problems") !== undefined) {
			await vscode.commands.executeCommand("workbench.actions.view.problems");
		}
	});

	/** `file` parses, or doesn't and why: its warning, as a check's, until it does. */
	const told = (file: string, why: string | undefined): void => {
		const uri = vscode.Uri.file(`${DIR}/${file}`);

		if (why === undefined) {
			diagnostics.delete(uri);
		} else {
			warn(uri, why);
		}
	};

	/** An annotation's question, answered as editor-api's Answer: the value, or why BABLR can't parse the text. */
	const answering = async (file: string | undefined, name: string, args: unknown, take: (answer: Record<string, unknown[]>) => unknown): Promise<unknown> => {
		const answer = await worker().ask<Record<string, unknown[]> & { "unparsable"?: string }>(name, args);

		if (file !== undefined) {
			told(file, answer.unparsable);
		}

		return answer.unparsable === undefined
			? {
					"value": take(answer)
				}
			: { "unparsable": answer.unparsable };
	};

	/** The other changed files, for a span that may have moved to one. */
	const changedFiles = async (file: string): Promise<Record<string, string>> => {
		const { files } = await status();
		const others = files.filter((change) => change.status !== "D" && change.path !== file && CODE_FILE.test(change.path)).slice(0, MOST_OTHERS);
		const texts = await Promise.all(others.map(async ({ path }): Promise<[string, string]> => [
			path,
			new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(`${DIR}/${path}`)))
		]));

		return Object.fromEntries(texts);
	};

	vscode.commands.registerCommand("editor.annotations.spans", async (source: string) => answering(undefined, "spans", { "source": source }, ({ spans }) => spans));
	vscode.commands.registerCommand("editor.annotations.refer", async (source: string, file: string, ranges: unknown[]) => answering(file, "refer", { "source": source, "file": file, "ranges": ranges }, ({ refs }) => refs.map((ref) => ref ?? undefined)));
	vscode.commands.registerCommand("editor.annotations.resolve", async (source: string, file: string, refs: SpanRef[], options: { "observed"?: boolean; "types"?: unknown; "texts"?: string[] } = {}) => log.span("editor.workbench.bablr.resolve", { "path": file, "count": refs.length }, async (span) => {
		const asked = {
			"source": source,
			"file": file,
			"refs": refs,
			"observed": options.observed === true,
			"types": options.types ?? {},
			"texts": options.texts ?? []
		};
		const first = await answering(file, "resolve", asked, ({ resolutions }) => resolutions) as { "value"?: { "status": string }[] };
		// (one that's what ran fades instead of being looked for; one made by a person is looked for further)
		const lost = options.observed === true || first.value === undefined
			? []
			: refs.flatMap((ref, index) => (first.value?.[index]?.status === "attached"
					? []
					: [
							{ "ref": ref, "index": index }
						]));

		span.end({ "lost": lost.length });

		if (lost.length === 0) {
			return first;
		}

		const blobs = [
			...new Set(lost.flatMap(({ ref }) => (ref.baseline === undefined
				? []
				: [ref.baseline.blob])))
		];
		const baselines = Object.fromEntries((await Promise.all(blobs.map(async (blob) => [blob, await blobText(blob)] as const))).filter(([, text]) => text !== undefined));
		const others = await changedFiles(file).catch(() => ({}));

		if (Object.keys(baselines).length === 0 && Object.keys(others).length === 0 && asked.texts.length === 0) {
			return first;
		}

		const again = await worker().ask<{ "resolutions"?: { "status": string }[] }>("resolve", {
			...asked,
			"refs": lost.map(({ ref }) => ref),
			"baselines": baselines,
			"others": others
		});

		for (const [at, { index }] of lost.entries()) {
			if (again.resolutions?.[at] !== undefined && first.value !== undefined) {
				first.value[index] = again.resolutions[at];
			}
		}

		return first;
	}));

	// What a change from one text to another is (the worker's verdict, from its kept parses): cosmetic, formatting or
	// comments only, or meaningful, with the nodes that changed and their lines. The same two texts answer the same, kept
	// for the next ask (the cosmetic extension reads every changed file again after each change).
	const verdicts = new Map<string, ChangeVerdict | "unparsable">();
	const classify = async (before: string, after: string): Promise<ChangeVerdict | "unparsable"> => {
		// (identical: the only answer that needs no parse)
		if (before === after) {
			return { "verdict": "cosmetic", "changedNodeIds": [], "changedLines": [] };
		}

		const [one, other] = await Promise.all([before, after].map(async (text) => crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))));
		const key = [one, other].map((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).join(":");
		const known = verdicts.get(key);

		if (known !== undefined) {
			return known;
		}

		const answer = await worker().ask<ChangeVerdict | { "verdict": "unparsable" }>("verdict", { "contents": [before, after] });
		const verdict = answer.verdict === "unparsable" ? "unparsable" : answer as ChangeVerdict;

		if (verdicts.size > 200) {
			verdicts.clear();
		}

		verdicts.set(key, verdict);

		return verdict;
	};

	// …asked by extensions through the bridge's `editor.annotations.classify` (editor-api's annotations().classify).
	serve(hub, "annotations.classify", async (args) => {
		const { before, after } = (args ?? {}) as { "before"?: unknown; "after"?: unknown };

		if (typeof before !== "string" || typeof after !== "string") {
			throw new TypeError("annotations.classify: the two texts");
		}

		return log.span("editor.workbench.bablr.classify", { "bytes": before.length + after.length }, async (span) => {
			const verdict = await classify(before, after);

			span.end({ "op": verdict === "unparsable" ? verdict : verdict.verdict });

			return verdict === "unparsable" ? { "unparsable": "BABLR can't parse one of the two texts" } : { "value": verdict };
		});
	});

	serve(hub, "bablr.check", async (args, { signal }) => {
		const { path, exclude } = (args ?? {}) as { "path"?: unknown; "exclude"?: unknown };

		if (typeof path !== "string" || (exclude !== undefined && typeof exclude !== "string")) {
			throw new TypeError("bablr.check takes { path, exclude? }: a folder from the workspace's root, and a glob to leave out");
		}

		return check(path, exclude, signal);
	});

	return {
		"spans": async (source) => worker().ask("spans", { "source": source }),
		"refer": async (source, file, ranges) => worker().ask("refer", { "source": source, "file": file, "ranges": ranges }),
		"editGroups": async (chain) => worker().ask("editGroups", { "chain": chain }),
		"stripped": async (text, signal) => {
			const { parsed, comments = [] } = await worker().ask<Parse>("parse", { "source": text }, signal);

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
