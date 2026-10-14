/**
 * ESLint — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). This is the WEB implementation of `dbaeumer.vscode-eslint`: the manifest claims
 * that id, so a repo's `.vscode/settings.json` written for the desktop extension (defaultFormatter,
 * `source.fixAll.eslint`, `eslint.*`) means the same thing here. The desktop extension runs an eslint language
 * server under Node; here real ESLint runs under almostnode in a worker of this extension's (worker.ts), with the
 * preset and the workspace's files — through the workspace runtime, so an open editor's unsaved text is what it reads —
 * and this entry shows what it says:
 *
 *   • each open JavaScript/TypeScript document is linted as it opens and once its edits settle, and its problems are
 *     this extension's own diagnostics (source "eslint", the rule as the code), honoring `eslint.enable`,
 *     `eslint.validate` and `eslint.rules.customizations` as the desktop extension does;
 *   • `source.fixAll.eslint` (what `editor.codeActionsOnSave` runs) and the formatter both ask the worker to fix the
 *     document's text;
 *   • the formatter is registered only while `eslint.format.enable` is true — the desktop extension's default is
 *     false, so `editor.defaultFormatter` alone doesn't make eslint format on either side;
 *   • the config is the workspace's `eslint.config.*` (else the preset): one that fails to load is a problem on that
 *     file, saying why and that the preset lints meanwhile, and a change to one starts the worker afresh, as the
 *     desktop server reloads its config.
 */
import { workspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import { watchWorker } from "../../shared/failures";

const LANGUAGES = ["javascript", "javascriptreact", "typescript", "typescriptreact"];
const FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("eslint");
/** How long edits settle before a document is linted again. */
const SETTLE_MS = 300;
/** The rules the desktop server marks unnecessary (drawn faded): unused things. */
const UNUSED_RULES = new Set(["no-unused-imports", "no-unused-private-class-members", "no-unused-vars"]);

/** What the worker says of a file (eslint's messages). */
interface Message { "line": number; "column": number; "endLine"?: number; "endColumn"?: number; "message": string; "ruleId": string | null; "severity": number; "fixable": boolean }

/** The names ESLint finds a config by, at the workspace's root (worker.ts's CONFIGS). */
const CONFIG_GLOB = "eslint.config.{js,mjs,cjs,ts,mts,cts}";

/** The worker: lint a text, or fix it — until it's disposed. */
interface Worker { "lint": (file: string, text: string) => Promise<Message[]>; "fix": (file: string, text: string) => Promise<{ "output": string; "fixed": boolean }>; "dispose": () => void }

/** What the worker lints with once it's loaded: the workspace's config file, or the preset (undefined) — and why not
 *  the workspace's, when it failed to load. */
type OnConfig = (config: string | undefined, error: string | undefined) => void;

/** ESLint's worker (worker.ts, through its bootstrap `worker.js`), given its link into the workspace runtime once it
 *  listens. Undefined where there's no workspace runtime (no editor core in this host): nothing is linted. */
function startWorker(context: vscode.ExtensionContext, onConfig: OnConfig): Worker | undefined {
	const runtime = workspaceRuntime();

	if (runtime === undefined) {
		console.error("[eslint] no workspace runtime in this extension host: nothing is linted");

		return undefined;
	}

	const disposables: (() => void)[] = [];
	const worker = new globalThis.Worker(vscode.Uri.joinPath(context.extensionUri, "worker.js").toString(true), { "name": "eslint" });
	const pending = new Map<number, { "resolve": (answer: Record<string, unknown>) => void; "reject": (error: Error) => void }>();
	// (it listens once it says it's ready: its module loads after the bootstrap, and a message before then is lost)
	let listening: () => void;
	const ready = new Promise<void>((resolve) => {
		listening = resolve;
	});
	let next = 0;
	let failure: Error | undefined;
	const failAll = (error: Error): void => {
		failure = error;

		for (const call of pending.values()) {
			call.reject(error);
		}

		pending.clear();
	};

	watchWorker(worker, "eslint-worker", (message) => {
		failAll(new Error("eslint's worker failed: " + message));
	});
	worker.addEventListener("message", (event: MessageEvent) => {
		const data = event.data as Record<string, unknown>;

		// (it listens: its link into the workspace — then it loads ESLint, and answers once it has)
		if (data["ready"] === true) {
			const link = runtime.connect("eslint");

			disposables.push(link.dispose);
			worker.postMessage({ "runtime": link.port }, [link.port]);
			listening();

			return;
		}

		if (data["booted"] === true) {
			const config = typeof data["config"] === "string" ? data["config"] : undefined;
			const error = typeof data["error"] === "string" ? data["error"] : undefined;

			console.info(`[eslint] ESLint loaded in ${String(data["ms"])} ms, linting with ${config ?? "the preset"}`);
			onConfig(config, error);

			return;
		}

		const call = pending.get(data["id"] as number);

		if (call !== undefined) {
			pending.delete(data["id"] as number);

			if (typeof data["error"] === "string") {
				call.reject(new Error(data["error"]));
			} else {
				call.resolve(data);
			}
		}
	});
	disposables.push(() => {
		worker.terminate();
		failAll(new Error("eslint's worker was started afresh"));
	});

	const ask = (request: Record<string, unknown>): Promise<Record<string, unknown>> => (failure === undefined
		? new Promise((resolve, reject) => {
			next += 1;

			const id = next;

			pending.set(id, { "resolve": resolve, "reject": reject });
			void ready.then(() => {
				worker.postMessage({ "id": id, ...request });
			});
		})
		: Promise.reject(failure));

	return {
		"lint": async (file, text) => (await ask({ "lint": { "file": file, "text": text } }))["messages"] as Message[],
		"fix": async (file, text) => {
			const answer = await ask({ "fix": { "file": file, "text": text } });

			return { "output": answer["output"] as string, "fixed": answer["fixed"] === true };
		},
		"dispose": () => {
			for (const dispose of disposables.splice(0)) {
				dispose();
			}
		}
	};
}

/** The `eslint.*` settings, read the way the desktop extension reads them. */
function settings(): { "enable": boolean; "validate": string[] | null; "customizations": { "rule": string; "severity": string; "fixable"?: boolean }[] } {
	const config = vscode.workspace.getConfiguration("eslint");
	const customizations = config.get<unknown>("rules.customizations");

	return {
		"enable": config.get<boolean>("enable", true),
		"validate": config.get<string[] | null>("validate", null),
		"customizations": Array.isArray(customizations) ? customizations.filter((entry): entry is { "rule": string; "severity": string } => entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["rule"] === "string" && typeof (entry as Record<string, unknown>)["severity"] === "string") : []
	};
}

/** Whether eslint lints `document`: `eslint.enable`, then `eslint.validate` (null: every JavaScript/TypeScript language). */
function validates(document: vscode.TextDocument): boolean {
	const { enable, validate } = settings();

	return document.uri.scheme === "file" && LANGUAGES.includes(document.languageId) && enable && (validate === null || validate.includes(document.languageId));
}

/** `eslint.rules.customizations`' severity for a problem, with the desktop server's semantics: `*` globs, a leading `!`
 *  negates, an entry with `fixable` applies only when it matches whether the problem has a fix, and the last match wins. */
function customized(ruleId: string, fixable: boolean): string | undefined {
	let severity: string | undefined;

	for (const entry of settings().customizations) {
		const negate = entry.rule.startsWith("!");
		const matches = new RegExp("^" + (negate ? entry.rule.slice(1) : entry.rule).replaceAll("*", ".*") + "$", "u").test(ruleId);

		if (matches !== negate && (entry.fixable === undefined || entry.fixable === fixable)) {
			severity = entry.severity;
		}
	}

	return severity;
}

/** A problem's severity — eslint's (2 error, 1 warning), as customized — or undefined when it's customized off. */
function severityOf(message: Message): vscode.DiagnosticSeverity | undefined {
	const base = message.severity === 2 ? "error" : "warn";
	const override = message.ruleId === null ? undefined : customized(message.ruleId, message.fixable);
	const resolved = override === "downgrade" ? (base === "error" ? "warn" : "info") : override === "upgrade" ? "error" : override === "off" || override === "info" || override === "warn" || override === "error" ? override : base;

	return resolved === "off" ? undefined : resolved === "error" ? vscode.DiagnosticSeverity.Error : resolved === "info" ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
}

/** A problem as a diagnostic in `document`, or undefined when it's customized off. */
function diagnosticOf(document: vscode.TextDocument, message: Message): vscode.Diagnostic | undefined {
	const severity = severityOf(message);

	if (severity === undefined) {
		return undefined;
	}

	const start = new vscode.Position(Math.max(0, message.line - 1), Math.max(0, message.column - 1));
	const end = message.endLine === undefined || message.endColumn === undefined ? start.translate(0, 1) : new vscode.Position(message.endLine - 1, message.endColumn - 1);
	const diagnostic = new vscode.Diagnostic(document.validateRange(new vscode.Range(start, end)), message.message, severity);
	const rule = message.ruleId?.slice(message.ruleId.lastIndexOf("/") + 1) ?? "";

	diagnostic.source = "eslint";

	if (message.ruleId !== null) {
		diagnostic.code = message.ruleId;
	}

	// (as the desktop server marks them: unused things, drawn faded)
	if (UNUSED_RULES.has(rule) || /\b(?:defined|assigned)\b.+\bnever used\b/iu.test(message.message)) {
		diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
	}

	return diagnostic;
}

function wholeDocument(document: vscode.TextDocument): vscode.Range {
	return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

export function activate(context: vscode.ExtensionContext): void {
	// (a workspace config that failed to load: a problem on it, apart from what linting it says)
	const configProblems = vscode.languages.createDiagnosticCollection("eslint-config");
	const onConfig: OnConfig = (config, error) => {
		configProblems.clear();

		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;

		if (error !== undefined && folder !== undefined) {
			void vscode.workspace.findFiles(new vscode.RelativePattern(folder, CONFIG_GLOB), null, 1).then(([file]) => {
				if (file !== undefined) {
					const problem = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `ESLint couldn't load this config, so the preset lints meanwhile: ${error}`, vscode.DiagnosticSeverity.Error);

					problem.source = "eslint";
					configProblems.set(file, [problem]);
				}
			});
		}
	};

	const first = startWorker(context, onConfig);

	if (first === undefined) {
		return;
	}

	let worker: Worker = first;

	context.subscriptions.push(configProblems, { "dispose": () => {
		worker.dispose();
	} });

	const collection = vscode.languages.createDiagnosticCollection("eslint");
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const selector = LANGUAGES.map((language) => ({ "language": language }));

	/** Every autofix for the document — the fixed text, or undefined when there's nothing to fix. */
	const fixAll = async (document: vscode.TextDocument): Promise<string | undefined> => {
		if (!validates(document)) {
			return undefined;
		}

		const { output, fixed } = await worker.fix(document.uri.fsPath, document.getText());

		return fixed && output !== document.getText() ? output : undefined;
	};

	const lint = async (document: vscode.TextDocument): Promise<void> => {
		if (!validates(document)) {
			collection.delete(document.uri);

			return;
		}

		const { version } = document;
		const messages = await worker.lint(document.uri.fsPath, document.getText()).catch((error: unknown) => {
			console.error("[eslint] couldn't lint", document.uri.fsPath, error instanceof Error ? error.message : String(error));

			return undefined;
		});

		// (closed meanwhile, or edited: a later lint is on its way)
		if (messages !== undefined && !document.isClosed && document.version === version) {
			collection.set(document.uri, messages.map((message) => diagnosticOf(document, message)).filter((diagnostic) => diagnostic !== undefined));
		}
	};

	const schedule = (document: vscode.TextDocument, delay: number): void => {
		const key = document.uri.toString();

		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => {
			timers.delete(key);
			void lint(document);
		}, delay));
	};

	context.subscriptions.push(
		collection,
		vscode.workspace.onDidOpenTextDocument((document) => {
			schedule(document, 0);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				schedule(event.document, SETTLE_MS);
			}
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			clearTimeout(timers.get(document.uri.toString()));
			timers.delete(document.uri.toString());
			collection.delete(document.uri);
		}),
		vscode.languages.registerCodeActionsProvider(selector, {
			"provideCodeActions": async (document, _range, codeContext) => {
				// Only as a source action (save / "Fix all"), never as a lightbulb on every cursor move.
				if (codeContext.only === undefined || !FIX_ALL.intersects(codeContext.only)) {
					return [];
				}

				const output = await fixAll(document);

				if (output === undefined) {
					return [];
				}

				const action = new vscode.CodeAction("Fix all auto-fixable problems", FIX_ALL);

				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(document.uri, wholeDocument(document), output);

				return [action];
			}
		}, { "providedCodeActionKinds": [FIX_ALL] }),
		{ "dispose": () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
		} }
	);

	// The formatter follows `eslint.format.enable` (default false, as on desktop).
	let formatter: vscode.Disposable | undefined;

	const syncFormatter = (): void => {
		const enabled = vscode.workspace.getConfiguration("eslint").get<boolean>("format.enable", false);

		if (enabled && formatter === undefined) {
			formatter = vscode.languages.registerDocumentFormattingEditProvider(selector, {
				"provideDocumentFormattingEdits": async (document) => {
					const output = await fixAll(document);

					return output === undefined ? [] : [vscode.TextEdit.replace(wholeDocument(document), output)];
				}
			});
		} else if (!enabled && formatter !== undefined) {
			formatter.dispose();
			formatter = undefined;
		}
	};

	syncFormatter();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("eslint")) {
			syncFormatter();

			for (const document of vscode.workspace.textDocuments) {
				schedule(document, 0);
			}
		}
	}), { "dispose": () => formatter?.dispose() });

	for (const document of vscode.workspace.textDocuments) {
		schedule(document, 0);
	}

	// A config made, changed or removed: a worker afresh — the old one's config and plugins stay loaded in it — and every
	// open document linted with what it loads.
	const folder = vscode.workspace.workspaceFolders?.[0];

	if (folder !== undefined) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, CONFIG_GLOB));
		let restart: ReturnType<typeof setTimeout> | undefined;
		const restarted = (): void => {
			clearTimeout(restart);
			restart = setTimeout(() => {
				worker.dispose();
				worker = startWorker(context, onConfig) ?? worker;

				for (const document of vscode.workspace.textDocuments) {
					schedule(document, 0);
				}
			}, SETTLE_MS);
		};

		context.subscriptions.push(watcher, watcher.onDidCreate(restarted), watcher.onDidChange(restarted), watcher.onDidDelete(restarted), { "dispose": () => {
			clearTimeout(restart);
		} });
	}
}

export function deactivate(): void { /* subscriptions are disposed with the context */ }
