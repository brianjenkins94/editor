/**
 * The Event Sheet augmentation — the FIRST file augmentation (see file-augmentations.ts). A Construct-style event sheet
 * rendered in the auxpane as a 3-column table (Name · Kind · Code), a PROJECTION of the active code file, with clicks
 * that drive the editor: click a row → jump to its lines; move the cursor → the owning row highlights.
 *
 * WHAT A ROW IS is deliberately not decided yet, so this is an ARBITRARY first projection to find the general shape:
 * rows are the file's top-level symbols (via the document-symbol provider), and a placeholder recognizer tags a few as
 * "event" while EVERYTHING ELSE is "custom code" — the vision's custom-code bucket. Both the recognizer and the columns
 * are throwaway scaffolding; the real projection is the BABLR CST (source of truth), the real vocabulary is conditions/
 * actions, and custom code will become anchored snippets. This step is only to feel out rows ↔ code in a live pane.
 *
 * (The sheet→code half — event-sheet.ts generate()/sampleSheet + its source map — still backs the "Open demo" bootstrap
 * and stays as the tested model for the eventual round-trip; the table no longer reads from it.)
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings -- a plain data table in the aux-bar body; intrinsic layout, not themeable chrome */
import type { AugmentationContext, FileAugmentation } from "./file-augmentations";
import { generate, sampleSheet } from "./event-sheet";

/** Files this augmentation projects (any code file, for now). */
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
/** The bootstrap demo's generated code lives here. */
const GENERATED_PATH = "/workspace/event-sheet.generated.ts";

const SELECTED_BG = "var(--vscode-list-inactiveSelectionBackground,#37373d)";
const HOVER_BG = "var(--vscode-list-hoverBackground,#2a2d2e)";

/** One projected row: a top-level construct of the file, classified, with the line range it occupies (1-based). */
interface Row {
	"id": string;
	"name": string;
	"kind": "event" | "custom";
	"startLine": number;
	"endLine": number;
}

/**
 * The ARBITRARY recognizer — the single seam to evolve. Today: top-level functions read as (placeholder) "event" rows,
 * everything else is "custom code". Tomorrow this becomes a real BABLR-CST reading of conditions/actions vs snippets.
 */
function classify(api: any, symbolKind: number): "event" | "custom" {
	return symbolKind === api.SymbolKind.Function || symbolKind === api.SymbolKind.Method ? "event" : "custom";
}

/** Project a document into rows via its top-level symbols. Empty when the provider isn't ready or the file has none. */
async function fetchRows(api: any, document: any): Promise<Row[]> {
	let symbols: any[] = [];

	try {
		symbols = (await api.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri)) ?? [];
	} catch { /* provider not ready / unsupported → no rows */ }

	const rows: Row[] = [];

	for (const symbol of symbols) {
		const range = symbol.range ?? symbol.location?.range;

		if (range === undefined) {
			continue;
		}

		rows.push({
			"id": symbol.name + "@" + range.start.line,
			"name": symbol.name,
			"kind": classify(api, symbol.kind),
			"startLine": range.start.line + 1,
			"endLine": range.end.line + 1
		});
	}

	return rows.sort((a, b) => a.startLine - b.startLine);
}

/** Reveal + select a 1-based inclusive line range in the augmented document. */
async function jumpTo(context: AugmentationContext, startLine: number, endLine: number): Promise<void> {
	const { api, document } = context;
	const editor = await api.window.showTextDocument(document, { "preserveFocus": false });
	const range = new api.Range(startLine - 1, 0, endLine - 1, Number.MAX_SAFE_INTEGER);

	editor.selection = new api.Selection(range.start, range.end);
	editor.revealRange(range, api.TextEditorRevealType.InCenter);
}

/** The row whose range contains a 1-based line — the SMALLEST such (innermost), or undefined. */
function rowAtLine(rows: Row[], line: number): string | undefined {
	let best: Row | undefined;

	for (const row of rows) {
		if (line >= row.startLine && line <= row.endLine && (best === undefined || row.endLine - row.startLine < best.endLine - best.startLine)) {
			best = row;
		}
	}

	return best?.id;
}

/**
 * Render the projection of `context.document` into `container`, wiring the map both ways, and re-projecting on edits.
 * Returns a disposer (listeners + DOM).
 */
function renderProjection(container: HTMLElement, context: AugmentationContext): () => void {
	const { api } = context;
	const sameDoc = (document: any): boolean => String(document?.uri?.path ?? "") === String(context.document.uri?.path ?? "");

	let rows: Row[] = [];
	const rowEls = new Map<string, HTMLElement>();
	let activeRowId: string | undefined;
	const idleBg = (rowId: string): string => (rowId === activeRowId ? SELECTED_BG : "transparent");

	const highlight = (rowId: string | undefined): void => {
		activeRowId = rowId;

		for (const [id, tr] of rowEls) {
			tr.style.background = id === rowId ? SELECTED_BG : "transparent";
		}
	};

	const reflect = (editor: any): void => {
		if (editor !== undefined && sameDoc(editor.document)) {
			highlight(rowAtLine(rows, (editor.selection?.active?.line ?? 0) + 1)); // selection line 0-based; rows 1-based
		}
	};

	const paint = (): void => {
		rowEls.clear();
		container.replaceChildren();

		const table = document.createElement("table");

		table.style.cssText = "width:100%;border-collapse:collapse;font-size:13px";

		const header = document.createElement("tr");

		for (const [label, width] of [["Name", "52%"], ["Kind", "26%"], ["Code", "22%"]] as const) {
			const th = document.createElement("th");

			th.textContent = label;
			th.style.cssText = "text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#333);opacity:0.7;font-weight:600;width:" + width;
			header.append(th);
		}

		table.append(header);

		if (rows.length === 0) {
			const note = document.createElement("div");

			note.textContent = "No top-level symbols to project yet.";
			note.style.cssText = "padding:12px;opacity:0.6;font-size:13px";
			container.append(table, note);

			return;
		}

		for (const row of rows) {
			const tr = document.createElement("tr");

			tr.style.cssText = "cursor:pointer;border-bottom:1px solid var(--vscode-panel-border,#2a2a2a)";
			tr.addEventListener("mouseenter", () => { tr.style.background = HOVER_BG; });
			tr.addEventListener("mouseleave", () => { tr.style.background = idleBg(row.id); });
			tr.addEventListener("click", () => { void jumpTo(context, row.startLine, row.endLine); });

			const cell = (text: string, style = ""): HTMLElement => {
				const td = document.createElement("td");

				td.textContent = text;
				td.style.cssText = "padding:6px 8px;vertical-align:top;" + style;

				return td;
			};

			// "custom code" is the everything-else bucket — muted; the arbitrary "event" is the recognized one.
			const kindStyle = row.kind === "custom" ? "opacity:0.55;font-style:italic" : "color:var(--vscode-charts-blue,#4fc1ff)";

			tr.append(
				cell(row.name),
				cell(row.kind === "custom" ? "custom code" : "event", kindStyle),
				cell("L" + row.startLine + "–" + row.endLine, "font-family:var(--monaco-monospace-font,monospace);opacity:0.8")
			);

			rowEls.set(row.id, tr);
			table.append(tr);
		}

		container.append(table);
	};

	// Re-project the file (debounced) — on open and on every edit — then repaint and re-sync the cursor highlight.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reproject = (): void => {
		void fetchRows(api, context.document).then((next) => {
			rows = next;
			paint();
			reflect(api.window.activeTextEditor);
		});
	};
	const scheduleReproject = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(reproject, 200);
	};

	paint(); // immediate empty frame, then fill
	reproject();

	const selSub = api.window.onDidChangeTextEditorSelection((event: any) => { reflect(event.textEditor); });
	const editSub = api.workspace.onDidChangeTextDocument((event: any) => {
		if (sameDoc(event.document)) {
			scheduleReproject();
		}
	});

	return (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		selSub.dispose();
		editSub.dispose();
		container.replaceChildren();
	};
}

/** The event-sheet augmentation — projects any code file; bootstrap opens a demo generated file to look at. */
export const eventSheetAugmentation: FileAugmentation = {
	"id": "event-sheet",
	"title": "Event Sheet",
	"when": (document: any) => CODE_FILE.test(String(document.uri?.path ?? "")),
	"render": (container, context) => {
		return { "dispose": renderProjection(container, context) };
	},
	"bootstrap": {
		"label": "Open Event Sheet demo",
		"run": async (api: any) => {
			const uri = api.Uri.file(GENERATED_PATH);

			await api.workspace.fs.writeFile(uri, new TextEncoder().encode(generate(sampleSheet).code));
			await api.window.showTextDocument(uri);
		}
	}
};
