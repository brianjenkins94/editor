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

/** Build the 3-column table for a generated program; each row jumps to its own line range on click. */
function renderTable(container: HTMLElement, context: AugmentationContext): void {
	const program = generate(sampleSheet);

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
		tr.addEventListener("mouseenter", () => { tr.style.background = "var(--vscode-list-hoverBackground,#2a2d2e)"; });
		tr.addEventListener("mouseleave", () => { tr.style.background = "transparent"; });

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

		table.append(tr);
	}

	container.append(table);
}

/** The event-sheet augmentation, keyed to the generated file. */
export const eventSheetAugmentation: FileAugmentation = {
	"id": "event-sheet",
	"title": "Event Sheet",
	"when": (document: any) => String(document.uri?.path ?? "").endsWith("event-sheet.generated.ts"),
	"render": (container, context) => {
		renderTable(container, context);

		return { "dispose": () => { container.replaceChildren(); } };
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
