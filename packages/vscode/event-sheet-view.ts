/**
 * The Event Sheet augmentation — the FIRST file augmentation (see file-augmentations.ts). A Construct-style event sheet
 * rendered in the auxpane as a 3-column table (When · Do · Code), a projection of the event-sheet model whose generated
 * code is a real file in the workspace. Clicking a row JUMPS the editor to the lines that row produced — the bidirectional
 * source map (event-sheet.ts) made visible: row → generated line range.
 *
 * Slice 1 is deliberately model-driven: the table is `sampleSheet` and the generated file is written verbatim from it,
 * so `spanOf(rowId)` line numbers match the file exactly. Reading an existing file back INTO rows (code → sheet) and
 * re-anchoring after edits (event-sheet-anchors.ts / off-thread) are later steps.
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings -- a plain data table in the aux-bar body; intrinsic layout, not themeable chrome */
import type { AugmentationContext, FileAugmentation } from "./file-augmentations";
import { generate, rowLabels, sampleSheet } from "./event-sheet";

/** The generated code lives here; the augmentation attaches to this file. */
const GENERATED_PATH = "/workspace/event-sheet.generated.ts";

/** Reveal + select a 1-based inclusive line range in the document the augmentation is attached to. */
async function jumpTo(context: AugmentationContext, startLine: number, endLine: number): Promise<void> {
	const { api, document } = context;
	const editor = await api.window.showTextDocument(document, { "preserveFocus": false });
	const range = new api.Range(startLine - 1, 0, endLine - 1, Number.MAX_SAFE_INTEGER);

	editor.selection = new api.Selection(range.start, range.end);
	editor.revealRange(range, api.TextEditorRevealType.InCenter);
}

const SELECTED_BG = "var(--vscode-list-inactiveSelectionBackground,#37373d)";
const HOVER_BG = "var(--vscode-list-hoverBackground,#2a2d2e)";

/**
 * Build the 3-column table for a generated program and wire the map BOTH ways:
 *  - row → code: clicking a row jumps the editor to its line range (`spanOf`);
 *  - code → row: as the cursor moves in the generated file, the owning row highlights (`rowAt`).
 * Returns a disposer (tears down the selection listener + the DOM).
 */
function renderTable(container: HTMLElement, context: AugmentationContext): () => void {
	const { api } = context;
	const program = generate(sampleSheet);
	const rowEls = new Map<string, HTMLElement>();
	let activeRowId: string | undefined;
	// The row's resting background — SELECTED when the cursor is in its code, else blank. Declared out here (not in the
	// row loop) so the mouseleave handler reads the LATEST activeRowId without a per-row closure over it.
	const idleBg = (rowId: string): string => (rowId === activeRowId ? SELECTED_BG : "transparent");

	const table = document.createElement("table");

	table.style.cssText = "width:100%;border-collapse:collapse;font-size:13px";

	const header = document.createElement("tr");

	for (const [label, width] of [["When", "38%"], ["Do", "44%"], ["Code", "18%"]] as const) {
		const th = document.createElement("th");

		th.textContent = label;
		th.style.cssText = "text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#333);opacity:0.7;font-weight:600;width:" + width;
		header.append(th);
	}

	table.append(header);

	for (const row of sampleSheet.rows) {
		const labels = rowLabels(row);
		const span = program.spanOf(row.id);
		const tr = document.createElement("tr");

		tr.style.cssText = "cursor:pointer;border-bottom:1px solid var(--vscode-panel-border,#2a2a2a)";
		// Hover is transient; on leave fall back to the row's SELECTED state (set by the cursor), not blindly to blank.
		tr.addEventListener("mouseenter", () => { tr.style.background = HOVER_BG; });
		tr.addEventListener("mouseleave", () => { tr.style.background = idleBg(row.id); });

		const cell = (text: string, mono = false): HTMLElement => {
			const td = document.createElement("td");

			td.textContent = text;
			td.style.cssText = "padding:6px 8px;vertical-align:top" + (mono ? ";font-family:var(--monaco-monospace-font,monospace);opacity:0.8" : "");

			return td;
		};

		tr.append(cell(labels.when), cell(labels.then), cell(span === undefined ? "—" : "L" + span.startLine + "–" + span.endLine, true));

		if (span !== undefined) {
			tr.addEventListener("click", () => { void jumpTo(context, span.startLine, span.endLine); });
		}

		rowEls.set(row.id, tr);
		table.append(tr);
	}

	container.append(table);

	// Reverse map (code → row): highlight the row that owns the cursor's line.
	const highlight = (rowId: string | undefined): void => {
		activeRowId = rowId;

		for (const [id, tr] of rowEls) {
			tr.style.background = id === rowId ? SELECTED_BG : "transparent";
		}
	};

	const reflect = (editor: any): void => {
		// Only track the file this augmentation is attached to.
		if (editor === undefined || String(editor.document?.uri?.path ?? "") !== String(context.document.uri?.path ?? "")) {
			return;
		}

		highlight(program.rowAt((editor.selection?.active?.line ?? 0) + 1)); // selection line is 0-based; rowAt is 1-based
	};

	const sub = api.window.onDidChangeTextEditorSelection((event: any) => { reflect(event.textEditor); });

	reflect(api.window.activeTextEditor); // reflect the current cursor immediately

	return (): void => { sub.dispose(); container.replaceChildren(); };
}

/** The event-sheet augmentation, keyed to the generated file. */
export const eventSheetAugmentation: FileAugmentation = {
	"id": "event-sheet",
	"title": "Event Sheet",
	"when": (document: any) => String(document.uri?.path ?? "").endsWith("event-sheet.generated.ts"),
	"render": (container, context) => {
		return { "dispose": renderTable(container, context) };
	},
	"bootstrap": {
		"label": "Open Event Sheet demo",
		"run": async (api: any) => {
			// Write the generated code verbatim from the model, then open it — the augmentation matches it and renders.
			const uri = api.Uri.file(GENERATED_PATH);

			await api.workspace.fs.writeFile(uri, new TextEncoder().encode(generate(sampleSheet).code));
			await api.window.showTextDocument(uri);
		}
	}
};
