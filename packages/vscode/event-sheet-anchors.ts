/**
 * The DURABLE half of the event-sheet source map (map #2 in event-sheet.ts) — split out because it calls BABLR
 * (spanAnchors), which is slow and must stay OFF the main workbench thread. `event-sheet.ts` stays BABLR-free so the
 * auxpane view can import it directly; when the map needs to survive edits/regen, run `rowAnchors` off-thread (the
 * classify worker) instead of on the UI thread.
 *
 * A row's durable handle is the content-addressed anchor id of the statement it emitted: move-stable + shift-resistant,
 * so a row re-finds its code by anchor (not line number) after a regen that reorders/adds rows or an edit to an
 * unrelated row, and a row whose own code changed no longer matches any anchor (it orphans → "diverged from generated").
 */
import { spanAnchors } from "@brianjenkins94/bablr";
import type { GeneratedProgram } from "./event-sheet";

/**
 * Map each row to the content-addressed anchor of its most distinctive owned span. Returns rowId → anchorId; a row with
 * no covered span (e.g. empty actions) is omitted.
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
