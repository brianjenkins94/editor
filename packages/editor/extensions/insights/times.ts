import type { EvidenceStore, Placed } from "@brianjenkins94/editor-api/evidence";
import * as vscode from "vscode";

const CODE = /\.[cm]?[jt]sx?$/u;
const CODE_SELECTOR = ["typescript", "typescriptreact", "javascript", "javascriptreact"].map((language) => ({ "language": language }));

const MIN_SHARE = 0.01;
const TINTED = [0.1, 0.25, 0.5];

const WARM = { "dark": "#e5a050", "light": "#bc4c00" };
const TINT = ["1f", "33", "4d"];

type Timed = Placed & { "evidence": Required<Pick<Placed["evidence"], "time">> };

function duration(ms: number): string {
	return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function shareOf({ evidence }: Timed): number {
	return evidence.time.profiledMs === 0 ? 0 : evidence.time.selfMs / evidence.time.profiledMs;
}

function said(timed: Timed): string {
	const { selfMs, runs } = timed.evidence.time;

	return `${String(Math.round(shareOf(timed) * 100))}% · ${duration(selfMs / Math.max(1, runs))}`;
}

function names(byName: Record<string, number>, runs: number): string {
	return Object.entries(byName).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, ms]) => `\`${name}\` ${duration(ms / Math.max(1, runs))}`).join(", ");
}

export function registerTimes(context: vscode.ExtensionContext, store: EvidenceStore): void {
	const atEnd = vscode.window.createTextEditorDecorationType({ "after": { "margin": "0 0 0 1.5em" } });
	const tints = TINT.map((alpha) => vscode.window.createTextEditorDecorationType({
		"dark": { "backgroundColor": WARM.dark + alpha },
		"light": { "backgroundColor": WARM.light + alpha },
		"overviewRulerColor": WARM.dark + alpha,
		"overviewRulerLane": vscode.OverviewRulerLane.Right
	}));
	const byDocument = new Map<string, { "text": string; "timed": Timed[] }>();

	const draw = (editor: vscode.TextEditor): void => {
		const here = byDocument.get(editor.document.uri.toString());
		const timed = here?.text === editor.document.getText() ? here.timed : [];
		const head = (each: Timed): vscode.Range => {
			const start = editor.document.positionAt(each.start);

			return new vscode.Range(start, editor.document.lineAt(start.line).range.end);
		};

		editor.setDecorations(atEnd, timed.map((each) => ({
			"range": new vscode.Range(head(each).end, head(each).end),
			"renderOptions": { "after": { "contentText": said(each), "color": new vscode.ThemeColor("editorCodeLens.foreground") } }
		})));

		for (const [level, tint] of tints.entries()) {
			const upTo = TINTED[level + 1] ?? Number.POSITIVE_INFINITY;

			editor.setDecorations(tint, timed.filter((each) => shareOf(each) >= TINTED[level]! && shareOf(each) < upTo).map((each) => new vscode.Range(editor.document.positionAt(each.start), head(each).end)));
		}
	};

	const check = async (document: vscode.TextDocument): Promise<void> => {
		if (!CODE.test(document.uri.path)) {
			return;
		}

		const placed = await store.placed(document);

		if (placed === undefined) {
			return; // edited since: a newer look follows
		}

		byDocument.set(document.uri.toString(), { "text": document.getText(), "timed": placed.filter((each): each is Timed => each.evidence.time !== undefined && shareOf(each as Timed) >= MIN_SHARE) });

		for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === document)) {
			draw(editor);
		}
	};

	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(
		atEnd,
		...tints,
		vscode.languages.registerHoverProvider(CODE_SELECTOR, {
			"provideHover": (document, position) => {
				const here = byDocument.get(document.uri.toString());
				const offset = document.offsetAt(position);
				const timed = here?.text === document.getText() ? here.timed.filter((each) => each.start <= offset && document.positionAt(each.start).line === position.line).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] : undefined;

				if (timed === undefined) {
					return undefined;
				}

				const { selfMs, totalMs, runs, callers, callees } = timed.evidence.time;
				const profiles = Math.max(1, runs);
				const lines = [
					`**Time** — ${String(Math.round(shareOf(timed) * 100))}% of the time profiled: ${duration(selfMs / profiles)} its own, ${duration(totalMs / profiles)} with what it called, a profile (over ${Math.round(runs) <= 1 ? "1 profile" : `about ${String(Math.round(runs))} profiles, the older fading`})`,
					...Object.keys(callers).length === 0 ? [] : [`Called by ${names(callers, runs)}`],
					...Object.keys(callees).length === 0 ? [] : [`Calls ${names(callees, runs)}`]
				];

				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}),
		store.onDidChange((file) => {
			for (const editor of vscode.window.visibleTextEditors.filter((candidate) => vscode.workspace.asRelativePath(candidate.document.uri, false) === file)) {
				void check(editor.document);
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				draw(editor);
				void check(editor.document);
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === event.document)) {
					draw(editor);
				}

				clearTimeout(typing);
				typing = setTimeout(() => {
					void check(event.document);
				}, 400);
			}
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			byDocument.delete(document.uri.toString());
		})
	);

	for (const editor of vscode.window.visibleTextEditors) {
		void check(editor.document);
	}
}
