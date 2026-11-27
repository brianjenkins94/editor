import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { ChangeVerdict } from "@brianjenkins94/editor-api/git";
import type { SpanRef } from "@brianjenkins94/util/silo/annotations";
import type * as vscodeApi from "vscode";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { blobText, status } from "./git-engine";

const DIR = "/workspace";

const CODE_FILES = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const MOST_OTHERS = 50;

const MOST_WHY = 300;

interface Parse { "parsed": boolean; "why"?: string; "comments"?: number[]; "ms": number; "cached": boolean }

export interface Bablr {
	"stripped": (text: string, signal?: AbortSignal) => Promise<string | undefined>;
	"spans": (source: string) => Promise<{ "spans"?: { "id": string; "type"?: string; "start": number; "end": number }[]; "unparsable"?: string }>;
	"refer": (source: string, file: string, ranges: { "start": number; "end": number }[]) => Promise<{ "refs"?: (SpanRef | null)[]; "unparsable"?: string }>;
	"editGroups": (chain: string[]) => Promise<{ "groups": EditGroup[]; "bursts": number }>;
}

export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

function sourceBytes(args: unknown): number {
	const { source, contents, chain } = (args ?? {}) as { "source"?: unknown; "contents"?: unknown; "chain"?: unknown };
	const texts: unknown[] = [source, contents, chain].flat();

	return texts.reduce((total: number, text) => total + (typeof text === "string"
		? text.length
		: 0), 0);
}

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

	vscode.workspace.createFileSystemWatcher("**/*", true, true, false).onDidDelete((uri) => {
		const under: vscodeApi.Uri[] = [];

		diagnostics.forEach((each) => {
			if (each.path === uri.path || each.path.startsWith(`${uri.path}/`)) {
				under.push(each);
			}
		});

		for (const each of under) {
			diagnostics.delete(each);
		}
	});

	const worker = (): NonNullable<typeof started> => {
		if (started !== undefined) {
			return started;
		}

		const spawned = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
		const dead = new AbortController();
		const rpc = createRpcClient(hub);
		let tail: Promise<unknown> = Promise.resolve();
		let waiting = 0;

		hub.link(portTransport(spawned));
		watchWorker(spawned, "bablr-worker", (message) => {
			dead.abort(new Error("BABLR's worker failed: " + message));
			started = undefined;
		});

		started = {
			"ask": async <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => log.span("editor.workbench.bablr.ask", {
				"op": name,
				"bytes": sourceBytes(args),
				"ahead": waiting
			}, async () => {
				const combined = signal === undefined
					? dead.signal
					: AbortSignal.any([signal, dead.signal]);
				const run = tail.then(async () => rpc.request(`bablr.${name}`, args, { "timeoutMs": Infinity, "waitForResponderMs": 60_000, "signal": combined }) as Promise<T>);

				tail = run.catch(() => undefined);
				waiting += 1;

				try {
					return await run;
				} finally {
					waiting -= 1;
				}
			})
		};

		return started;
	};

	const parse = async (uri: vscodeApi.Uri, text: string, signal?: AbortSignal): Promise<Parse> => {
		const answer = await worker().ask<Parse>("parse", { "source": text }, signal);

		if (answer.parsed) {
			diagnostics.delete(uri);
		} else {
			warn(uri, answer.why ?? "BABLR can't parse it");
		}

		return answer;
	};

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

	const told = (file: string, why: string | undefined): void => {
		const uri = vscode.Uri.file(`${DIR}/${file}`);

		if (why === undefined) {
			diagnostics.delete(uri);
		} else {
			warn(uri, why);
		}
	};

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

	const verdicts = new Map<string, ChangeVerdict | "unparsable">();
	const classify = async (before: string, after: string): Promise<ChangeVerdict | "unparsable"> => {
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
