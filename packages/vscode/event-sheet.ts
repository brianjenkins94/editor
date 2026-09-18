/**
 * Event sheet → code generator + BIDIRECTIONAL SOURCE MAP — the spine of the Construct-style event sheet (a projection
 * of the program, code-gen not runtime; see the event-sheet vision). This module is deliberately the FIRST thing built,
 * before any real event vocabulary or UI, because everything hangs off the map: step a generated line → highlight its
 * event row; click an event row → jump to its code. No vscode dependency (like git-engine) — a pure, testable core.
 *
 * TWO maps, and the second is the point:
 *  1. The EMIT-TIME map is ground truth but fragile — the generator knows exactly which row each line came from as it
 *     writes, so `SourceMap` is exact for the code it just produced. It dies the moment the file is regenerated or the
 *     user hand-edits, because it's keyed on line numbers.
 *  2. The DURABLE map keys each row on the CONTENT-ADDRESSED anchor of the statement it emitted (bablr spanAnchors). An
 *     anchor is move-stable and shift-resistant, so after a regen that reorders/adds rows — or after the user edits an
 *     UNRELATED row — a row still finds its code, and a row whose own code changed orphans (the "diverged from
 *     generated" signal). That's the same identity mechanism the annotation spine used, reused here.
 *
 * The vocabulary here (a handful of conditions/actions) is a PLACEHOLDER to exercise nesting and multi-line rows; the
 * real palette, the ECS-system-per-row shape, and the idiomatic-vs-procedural house style are later, deliberate calls.
 */
import { spanAnchors } from "@brianjenkins94/bablr";

/** A trigger/query for a row. `kind` picks the shape; `arg` is its single placeholder parameter (real params later). */
export interface Condition { "kind": "onStart" | "everyTick" | "onKey"; "arg"?: string }

/** An effect the row runs when its condition holds. One statement's worth of generated code. */
export interface Action { "kind": "spawn" | "move" | "setVar" | "log"; "arg"?: string; "value"?: string }

/** One event-sheet row: a condition guarding an ordered list of actions. `id` is the row's stable handle (the UI's; a
 *  future version derives it from the sheet's own CST). */
export interface EventRow { "id": string; "condition": Condition; "actions": Action[] }

/** An event sheet is just an ordered list of rows — evaluated top-to-bottom, the Construct model. */
export interface EventSheet { "rows": EventRow[] }

/** A row's contiguous line ownership in the generated file (1-based, inclusive). */
export interface RowSpan { "rowId": string; "startLine": number; "endLine": number }

/** The generator's output: the source text, and the bidirectional map from rows to the lines they own. */
export interface GeneratedProgram {
	"code": string;
	/** Per row, the line range it produced, in emit order. Lines outside every span are generated "chrome" (the
	 *  function signature, blank lines, the closing brace) and belong to no row — a step there highlights nothing. */
	"spans": RowSpan[];
	/** 1-based line → the row that produced it, or undefined for chrome. */
	"rowAt": (line: number) => string | undefined;
	/** A row's line range, or undefined if the row produced nothing / isn't in this program. */
	"spanOf": (rowId: string) => RowSpan | undefined;
}

/** Renders one condition as the head of a JS block. Kept trivial and readable — the generated code is a core value. */
function conditionHead(condition: Condition): string {
	switch (condition.kind) {
		case "onKey": {
			return "if (input.pressed(" + JSON.stringify(condition.arg ?? "") + ")) {";
		}
		case "onStart": {
			return "if (world.frame === 0) {";
		}
		case "everyTick":
		default: {
			return "{";
		}
	}
}

/** A short human label for a condition — the comment that heads each row's block (and the row's title in the sheet). */
function conditionLabel(condition: Condition): string {
	switch (condition.kind) {
		case "onKey": {
			return "when " + JSON.stringify(condition.arg ?? "") + " is pressed";
		}
		case "onStart": {
			return "on start";
		}
		case "everyTick":
		default: {
			return "every tick";
		}
	}
}

/** Renders one action as a single generated statement. */
function actionStatement(action: Action): string {
	switch (action.kind) {
		case "spawn": {
			return "world.spawn(" + JSON.stringify(action.arg ?? "entity") + ");";
		}
		case "move": {
			return "world.move(" + JSON.stringify(action.arg ?? "") + ", " + (action.value ?? "0") + ");";
		}
		case "setVar": {
			return "world.vars[" + JSON.stringify(action.arg ?? "") + "] = " + (action.value ?? "0") + ";";
		}
		case "log":
		default: {
			return "world.log(" + JSON.stringify(action.arg ?? "") + ");";
		}
	}
}

/**
 * A line-tracking emitter — the whole trick of the emit-time map. Every physical line written carries the row it was
 * written for (or undefined for chrome), so provenance is exact by construction rather than recovered by a diff.
 */
class Emitter {
	private readonly lines: string[] = [];
	private readonly owner: (string | undefined)[] = [];
	private depth = 0;

	/** Write one line at the current indent, attributed to `rowId` (undefined = chrome). */
	public line(text: string, rowId?: string): void {
		this.lines.push(text === "" ? "" : "\t".repeat(this.depth) + text);
		this.owner.push(rowId);
	}

	public indent(): void {
		this.depth += 1;
	}

	public dedent(): void {
		this.depth = Math.max(0, this.depth - 1);
	}

	/** Finish: the joined source, plus the per-line owners (index 0 = line 1). */
	public finish(): { "code": string; "owners": (string | undefined)[] } {
		return { "code": this.lines.join("\n") + "\n", "owners": this.owner };
	}
}

/** Collapse a per-line owner array into contiguous row spans (adjacent same-owner lines merge; chrome breaks a run). */
function spansFromOwners(owners: (string | undefined)[]): RowSpan[] {
	const spans: RowSpan[] = [];

	owners.forEach((rowId, index) => {
		const line = index + 1; // 1-based

		if (rowId === undefined) {
			return;
		}

		const last = spans.at(-1);

		if (last !== undefined && last.rowId === rowId && last.endLine === line - 1) {
			last.endLine = line;
		} else {
			spans.push({ "rowId": rowId, "startLine": line, "endLine": line });
		}
	});

	return spans;
}

/**
 * Generate the readable source for an event sheet, tracking which row produced each line. The shape is one procedural
 * `update(world, input)` with a block per row — the most direct analog of a sheet (a sequential list of events run each
 * frame). The ECS-system-per-row shape is the growth target; the map machinery here is independent of that choice.
 */
export function generate(sheet: EventSheet): GeneratedProgram {
	const emitter = new Emitter();

	emitter.line("export function update(world, input) {"); // chrome
	emitter.indent();

	for (const row of sheet.rows) {
		emitter.line("// " + conditionLabel(row.condition), row.id);
		emitter.line(conditionHead(row.condition), row.id);
		emitter.indent();

		if (row.actions.length === 0) {
			emitter.line("// (no actions yet)", row.id);
		}

		for (const action of row.actions) {
			emitter.line(actionStatement(action), row.id);
		}

		emitter.dedent();
		emitter.line("}", row.id);
	}

	emitter.dedent();
	emitter.line("}"); // chrome

	const { code, owners } = emitter.finish();
	const spans = spansFromOwners(owners);
	const byRow = new Map(spans.map((span) => [span.rowId, span]));

	return {
		"code": code,
		"spans": spans,
		"rowAt": (line) => owners[line - 1],
		"spanOf": (rowId) => byRow.get(rowId)
	};
}

/**
 * A row's DURABLE handle: the content-addressed anchor id of the statement it emitted. Deriving spanAnchors over the
 * generated code and taking the innermost span that covers a row's line range gives a key that survives regen and
 * unrelated edits (move-stable + shift-resistant) — so a row re-finds its code by anchor, not by line number, and a row
 * whose own code changed no longer matches any anchor (it orphans → "diverged from generated", the review signal).
 *
 * Returns rowId → anchorId. A row with no covered span (e.g. empty actions) is omitted.
 */
export function rowAnchors(program: GeneratedProgram): Map<string, string> {
	const anchors = spanAnchors(program.code);

	// 1-based line for a character offset in the generated code.
	const lineStarts: number[] = [0];

	for (let index = 0; index < program.code.length; index += 1) {
		if (program.code[index] === "\n") {
			lineStarts.push(index + 1);
		}
	}

	const lineAt = (offset: number): number => {
		let low = 0;
		let high = lineStarts.length - 1;

		while (low < high) {
			const mid = (low + high + 1) >> 1;

			if (lineStarts[mid] <= offset) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}

		return low + 1; // 1-based
	};

	const result = new Map<string, string>();

	for (const span of program.spans) {
		// The row's durable handle is its most DISTINCTIVE owned span: a real node (not a bare punctuator, `type: null`)
		// that lies entirely inside the row's lines. Prefer a BARE-hash id (unique content ⇒ no `#ordinal` ⇒ immune to
		// spans added elsewhere), and among those the LARGEST — the whole emitted statement, e.g. `world.spawn("bullet")`,
		// rather than a sub-token like `world` that repeats in every row. A leaf like `(` was the trap: same content
		// everywhere, so its ordinal (and thus its id) slid the instant a row was inserted above.
		let best: { "id": string; "bare": boolean; "size": number } | undefined;

		for (const anchor of anchors) {
			if (anchor.type === null) {
				continue; // punctuation — always duplicated, never a stable handle
			}

			const startLine = lineAt(anchor.start);
			const endLine = lineAt(Math.max(anchor.start, anchor.end - 1));

			if (startLine < span.startLine || endLine > span.endLine) {
				continue; // not fully inside this row
			}

			const bare = !anchor.id.includes("#");
			const size = anchor.end - anchor.start;

			// Bare beats ordinal'd; then larger beats smaller.
			if (best === undefined || (bare && !best.bare) || (bare === best.bare && size > best.size)) {
				best = { "id": anchor.id, "bare": bare, "size": size };
			}
		}

		if (best !== undefined) {
			result.set(span.rowId, best.id);
		}
	}

	return result;
}

/** A small, realistic sample sheet — enough to exercise nesting, multi-action rows, and every condition/action kind. */
export const sampleSheet: EventSheet = {
	"rows": [
		{ "id": "row-init", "condition": { "kind": "onStart" }, "actions": [{ "kind": "spawn", "arg": "player" }, { "kind": "setVar", "arg": "score", "value": "0" }] },
		{ "id": "row-shoot", "condition": { "kind": "onKey", "arg": "Space" }, "actions": [{ "kind": "spawn", "arg": "bullet" }] },
		{ "id": "row-move", "condition": { "kind": "everyTick" }, "actions": [{ "kind": "move", "arg": "player", "value": "world.player.vx" }] }
	]
};
