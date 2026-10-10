/**
 * The Event Sheet: the game the open file belongs to, as a map of its parts and a builder (view.ts, authoring.ts), in a
 * webview view. This is its VS Code side, on the public API only: it serves the view, answers what the view asks of it
 * (EventSheetHost: the game around the active file, its projection, opening a file at a line, writing files, prompts),
 * tells the view when to refresh (the active editor changed, a file was saved), and runs the recognizer in a worker of
 * its own (recognizer-worker.ts) so parsing doesn't hold up the extension host — anchoring what it recognizes with the
 * editor's BABLR (anchors.ts).
 */
import { annotations } from "@brianjenkins94/run-contract/annotations";
import type { EventSheetHost, HostMessage, ViewMessage } from "./view";
import type { GameModel } from "./recognizer";
import * as vscode from "vscode";
import { anchorGame } from "./anchors";

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const IGNORE = /(?:^|\/)(?:node_modules|\.git|\.silo|dist|assets)(?:\/|$)/u;

/** The nearest directory above `path` with a package.json — a game is a package. */
async function gameRoot(path: string): Promise<string | undefined> {
	for (let dir = path.replace(/\/[^/]*$/u, ""); dir !== "" && dir !== "/"; dir = dir.replace(/\/[^/]*$/u, "")) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(dir + "/package.json"));

			return dir;
		} catch { /* keep walking up */ }
	}

	return undefined;
}

/** Every code file under `root` (not deps, builds, assets or .d.ts), by path relative to it. */
async function gameFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const decoder = new TextDecoder();
	const walk = async (dir: string): Promise<void> => {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)).then((found) => found, () => []);

		for (const [name, type] of entries) {
			const full = dir + "/" + name;

			if (IGNORE.test(full)) {
				continue;
			}

			if (type === vscode.FileType.Directory) {
				await walk(full);
			} else if (CODE_FILE.test(name) && !name.endsWith(".d.ts")) {
				await vscode.workspace.fs.readFile(vscode.Uri.file(full)).then((bytes) => { files[full.slice(root.length + 1)] = decoder.decode(bytes); }, () => undefined);
			}
		}
	};

	await walk(root);

	return files;
}

/** The recognizer, in its worker: started on first use (it says when it's ready), asked by id. */
function recognizer(context: vscode.ExtensionContext): { "project": (root: string, files: Record<string, string>) => Promise<GameModel>; "dispose": () => void } {
	let worker: { "worker": Worker; "ready": Promise<void> } | undefined;
	let next = 0;
	const pending = new Map<number, { "resolve": (model: GameModel) => void; "reject": (error: Error) => void }>();
	const start = (): { "worker": Worker; "ready": Promise<void> } => {
		// recognizer.js is a classic bootstrap that imports the module worker (an extension's workers start classic).
		const started = new Worker(vscode.Uri.joinPath(context.extensionUri, "recognizer.js").toString(true));
		let markReady: () => void = () => undefined;
		let markFailed: (error: Error) => void = () => undefined;
		const ready = new Promise<void>((resolve, reject) => { markReady = resolve; markFailed = reject; });

		started.addEventListener("message", (event: MessageEvent) => {
			const { id, model, error, "ready": isReady, failed } = event.data as { "id": number; "model"?: GameModel; "error"?: string; "ready"?: true; "failed"?: string };

			if (isReady === true) {
				markReady();

				return;
			}

			// Its module didn't load: this worker never will; the next projection starts another.
			if (failed !== undefined) {
				markFailed(new Error("the recognizer couldn't start: " + failed));
				worker = undefined;

				return;
			}

			const call = pending.get(id);

			pending.delete(id);

			if (error === undefined && model !== undefined) {
				call?.resolve(model);
			} else {
				call?.reject(new Error(error ?? "no model"));
			}
		});
		// A worker that fails to load (or dies) never answers: fail what's waiting, and start afresh next time.
		started.addEventListener("error", (event) => {
			event.preventDefault();

			for (const call of pending.values()) {
				call.reject(new Error("the recognizer couldn't start: " + (event.message || "it failed to load")));
			}

			pending.clear();
			worker = undefined;
		});

		return { "worker": started, "ready": ready };
	};

	return {
		"project": async (root, files) => {
			worker ??= start();

			const current = worker;

			await current.ready;

			const model = await new Promise<GameModel>((resolve, reject) => {
				next += 1;
				pending.set(next, { "resolve": resolve, "reject": reject });
				current.worker.postMessage({ "id": next, "files": files });
			});

			// Durable span references, from the editor's BABLR (one worker, one cache of parses): worker-pod's command,
			// each file named as the workspace does. Without it (VS Code without the editor), the nodes go unanchored.
			return anchorGame(files, model, async (source, path, ranges) => annotations(vscode.commands).refer(source, vscode.workspace.asRelativePath(vscode.Uri.file(root + "/" + path), false), ranges));
		},
		"dispose": () => { worker?.worker.terminate(); }
	};
}

/** What the view asks for, done with VS Code's API. */
function hostFor(projection: ReturnType<typeof recognizer>): EventSheetHost {
	return {
		"game": async () => {
			const path = vscode.window.activeTextEditor?.document.uri.path;

			if (path === undefined || !CODE_FILE.test(path)) {
				return { "problem": "Open a file of a game to see its event sheet." };
			}

			const root = await gameRoot(path);

			return root === undefined ? { "problem": "No package.json above this file — can't locate a game." } : { "root": root, "files": await gameFiles(root) };
		},
		"project": projection.project,
		"open": (path, line) => {
			void vscode.window.showTextDocument(vscode.Uri.file(path), { "preserveFocus": false }).then((editor) => {
				const position = new vscode.Position(Math.max(0, line - 1), 0);

				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			});
		},
		"writeFiles": async (root, files) => {
			const encoder = new TextEncoder();

			// Directories first (the workspace's file system won't make parents), shallowest first.
			const dirs = [...new Set(Object.keys(files).flatMap((relative) => relative.split("/").slice(0, -1).map((_, index, parts) => root + "/" + parts.slice(0, index + 1).join("/"))))].sort((a, b) => a.length - b.length);

			for (const dir of dirs) {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
			}

			for (const [relative, content] of Object.entries(files)) {
				await vscode.workspace.fs.writeFile(vscode.Uri.file(root + "/" + relative), encoder.encode(content));
			}
		},
		"info": (message) => { void vscode.window.showInformationMessage(message); },
		"input": async (options) => vscode.window.showInputBox(options),
		"pick": async (items, options) => vscode.window.showQuickPick(items, options)
	};
}

/** The webview's page: the view's script inline (a webview here can't load its resources by URL), behind a strict policy. */
async function page(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
	const script = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, "view.js")));
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const policy = `default-src 'none'; img-src data: ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;

	// eslint-disable-next-line webawesome/no-html-in-strings -- a webview is given its page as a string
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><script nonce="${nonce}">${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}

export function activate(context: vscode.ExtensionContext): void {
	const projection = recognizer(context);
	const host = hostFor(projection);

	context.subscriptions.push({ "dispose": projection.dispose }, vscode.window.registerWebviewViewProvider("eventSheet.view", {
		"resolveWebviewView": async (view) => {
			const post = (message: HostMessage): void => { void view.webview.postMessage(message); };

			view.webview.options = { "enableScripts": true };
			view.webview.onDidReceiveMessage(async (message: ViewMessage) => {
				if (message.call !== true) {
					return;
				}

				try {
					const method = host[message.method] as (...args: unknown[]) => unknown;

					post({ "answer": true, "id": message.id, "result": await method(...message.args) });
				} catch (error) {
					post({ "answer": true, "id": message.id, "error": error instanceof Error ? error.message : String(error) });
				}
			}, undefined, context.subscriptions);
			context.subscriptions.push(
				vscode.window.onDidChangeActiveTextEditor(() => { post({ "refresh": "editor" }); }),
				vscode.workspace.onDidSaveTextDocument(() => { post({ "refresh": "save" }); })
			);
			view.webview.html = await page(context, view.webview);
		}
	}));
}
