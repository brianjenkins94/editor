import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";

const TRIES = 25;
const TRY_MS = 2000;

export function historyAsker(vscode: typeof vscodeApi): (command: string, target: string, signal: AbortSignal, tries?: number) => Promise<unknown> {
	let woken: Promise<void> | undefined;
	const wake = async (): Promise<void> => {
		woken ??= (async () => {
			if (!vscode.workspace.textDocuments.some((document) => /^(?:typescript|javascript)(?:react)?$/u.test(document.languageId))) {
				const [file] = await vscode.workspace.findFiles("**/*.{ts,tsx}", "**/node_modules/**", 1);

				if (file !== undefined) {
					await vscode.workspace.openTextDocument(file);
				}
			}
		})().catch(() => { /* no TypeScript to open: History says so */ }).finally(() => {
			woken = undefined;
		});

		return woken;
	};

	const unanswered = (answer: unknown): boolean => answer === undefined || (answer as { "ready"?: unknown }).ready === false;

	return async (command, target, signal, tries = TRIES) => {
		const ask = async (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(command, target)).catch(() => undefined);
		let answer = await ask();

		if (unanswered(answer)) {
			await wake();
		}

		for (let tried = 1; unanswered(answer) && tried < tries && !signal.aborted; tried += 1) {
			await new Promise((resolve) => {
				setTimeout(resolve, TRY_MS);
			});
			answer = await ask();
		}

		return answer;
	};
}

interface Decided {
	"target"?: string;
	"ledger"?: { "name": string; "status"?: string; "why"?: string; "since"?: string; "what"?: string }[];
	"docs"?: { "doc": string; "line": number; "heading": string; "text": string }[];
	"counts"?: { "docs": number };
	"notes"?: { "line"?: number; "text"?: string; "by"?: string; "status"?: string }[];
	"error"?: string;
}

const SCHEME = "editor-decisions";

function markdownOf(decided: Decided): string {
	const lines = [`# What's been decided about ${decided.target ?? "it"}`, ""];

	if (decided.error !== undefined) {
		return [...lines, decided.error, ""].join("\n");
	}

	lines.push("## The feature ledger", "");
	lines.push(...(decided.ledger ?? []).length === 0 ? ["Nothing names it.", ""] : (decided.ledger ?? []).flatMap((entry) => [`- **${entry.name}** — ${entry.status ?? ""}${entry.since === undefined ? "" : ` since ${entry.since}`}: ${entry.why ?? ""}${entry.what === undefined ? "" : `\n  ${entry.what}`}`]), "");
	lines.push("## The docs", "");
	lines.push(...(decided.docs ?? []).length === 0 ? ["No line names it.", ""] : [...(decided.docs ?? []).map((doc) => `- ${doc.doc}:${String(doc.line)}${doc.heading === "" ? "" : ` (*${doc.heading}*)`}: ${doc.text}`), ...(decided.counts?.docs ?? 0) > (decided.docs ?? []).length ? [`- …and ${String((decided.counts?.docs ?? 0) - (decided.docs ?? []).length)} more`] : [], ""]);

	if ((decided.notes ?? []).length > 0) {
		lines.push("## Its notes", "", ...(decided.notes ?? []).map((note) => `- ${note.line === undefined ? "(its place lost)" : `line ${String(note.line)}`}: ${note.text ?? ""}${note.by === undefined ? "" : ` — ${note.by}`}`), "");
	}

	return lines.join("\n");
}

export function installDecisions(vscode: typeof vscodeApi, hub: Hub): void {
	const asked = historyAsker(vscode);

	const decide = async (target: string, signal: AbortSignal): Promise<Decided> => {
		const decided = await asked("history.decisions", target, signal) as Decided | undefined;

		if (decided === undefined) {
			return { "target": target, "error": "the history extension didn't answer" };
		}

		const notes = target.includes("/") ? await Promise.resolve(vscode.commands.executeCommand<Decided["notes"]>("notes.on", target)).catch(() => undefined) ?? [] : [];

		return notes.length === 0 ? decided : { ...decided, "notes": notes };
	};

	serve(hub, "decisions.for", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("decisions.for takes { target }: a file (its path or its name) or a name (an identifier, a feature)");
		}

		return decide(target.trim(), signal);
	});

	const shown = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscodeApi.Uri>();

	vscode.workspace.registerTextDocumentContentProvider(SCHEME, { "onDidChange": changed.event, "provideTextDocumentContent": (uri) => shown.get(uri.toString()) ?? "" });
	vscode.commands.registerCommand("editor.decisions.show", async (given?: unknown) => {
		const editor = vscode.window.activeTextEditor;
		const front = editor?.document.uri.scheme === "file" ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
		const target = typeof given === "string" && given.trim() !== "" ? given.trim() : await vscode.window.showInputBox({ "title": "What's Been Decided About…", "prompt": "A file's path or name, or a name: an identifier, a feature, a way in", "value": front ?? "" });

		if (target === undefined || target.trim() === "") {
			return;
		}

		const decided = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Window, "title": `What's been decided about ${target.trim()}` }, async () => decide(target.trim(), new AbortController().signal));
		const uri = vscode.Uri.from({ "scheme": SCHEME, "path": `/${target.trim()}.md` });

		shown.set(uri.toString(), markdownOf(decided));
		changed.fire(uri);

		const document = await vscode.workspace.openTextDocument(uri);

		await vscode.languages.setTextDocumentLanguage(document, "markdown");
		await vscode.window.showTextDocument(document, { "viewColumn": vscode.ViewColumn.Beside, "preview": true });
	});
}
