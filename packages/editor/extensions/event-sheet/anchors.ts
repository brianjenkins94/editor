/**
 * Durable anchoring — the BABLR half of the projection, and BABLR's actual strength.
 *
 * The recognizer (TS AST) gives each node a source RANGE, but ranges are fragile: any edit above a node shifts them. So
 * each node gets a REFERENCE to the BABLR span standing for its range (SPAN-ANNOTATIONS.md): the span's content-addressed
 * id — move-stable, shift-resistant, self-edit-aware — plus what it looked like and where it was, so whatever is attached
 * to the node (an extracted custom-code snippet, a note) is found again the way every span annotation is, and re-placed
 * or orphaned when its code changes. This is what "annotate the CST in place with change-resistant anchors" means: the
 * map's identity survives edits.
 *
 * BABLR itself is the editor's (`referOf`: in the extension, worker-pod's `editor.annotations.refer` command — one BABLR
 * worker, one cache of parses): per file, one call for the reference standing for each node's range.
 */
import type { SpanRef } from "@brianjenkins94/util/silo/annotations";
import type { GameModel, NodeLoc } from "./recognizer";

/** A reference to the span standing for each of `ranges` in `source`, the text of game file `path` — undefined for one
 *  BABLR can't place, and for all of them when its grammar doesn't take the text. */
export type ReferOf = (source: string, path: string, ranges: { "start": number; "end": number }[]) => Promise<(SpanRef | undefined | null)[] | undefined>;

/** Attach a durable span reference to every recognized node in the model (mutates + returns it): one `referOf` a file. */
export async function anchorGame(files: Record<string, string>, model: GameModel, referOf: ReferOf): Promise<GameModel> {
	const nodes: NodeLoc[] = [...model.behaviors, ...model.composites, ...model.objects, ...model.rules.flatMap((rule) => [rule, ...rule.rows])];
	const byFile = new Map<string, NodeLoc[]>();

	for (const node of nodes) {
		byFile.set(node.defPath, [...byFile.get(node.defPath) ?? [], node]);
	}

	await Promise.all([...byFile].map(async ([path, inFile]) => {
		const source = files[path] ?? "";
		// An unparsable or empty file has no references (BABLR throws on "").
		const refs = source === "" ? undefined : await referOf(source, path, inFile.map((node) => ({ "start": node.start, "end": node.end }))).catch(() => undefined);

		inFile.forEach((node, index) => {
			node.ref = refs?.[index] ?? undefined;
		});
	}));

	return model;
}
