/**
 * Durable anchoring — the BABLR half of the projection, and BABLR's actual strength.
 *
 * The recognizer (TS AST) gives each node a source RANGE, but ranges are fragile: any edit above a node shifts them. So
 * we give each node a content-addressed `spanAnchors` id — move-stable, shift-resistant, self-edit-aware — that future
 * attachments (annotations, extracted custom-code snippets, orphan detection) can key on. This is what "annotate the CST
 * in place with change-resistant anchors" means: the map's identity survives edits.
 *
 * BABLR itself is the editor's (`anchorsOf`: in the extension, worker-pod's `editor.bablr.anchors` command — one BABLR
 * worker, one cache of parses): per file, one call for the anchor that best stands for each node's range
 * (bablr-language-ts's pickAnchor — the evidence store matches coverage the same way).
 */
import type { GameModel, NodeLoc } from "./recognizer";

/** The anchor id standing for each of `ranges` in `source`, or undefined when BABLR's grammar doesn't take it. */
export type AnchorsOf = (source: string, ranges: { "start": number; "end": number }[]) => Promise<(string | undefined | null)[] | undefined>;

/** Attach a durable anchor id to every recognized node in the model (mutates + returns it): one `anchorsOf` per file. */
export async function anchorGame(files: Record<string, string>, model: GameModel, anchorsOf: AnchorsOf): Promise<GameModel> {
	const nodes: NodeLoc[] = [...model.behaviors, ...model.composites, ...model.objects, ...model.rules.flatMap((rule) => [rule, ...rule.rows])];
	const byFile = new Map<string, NodeLoc[]>();

	for (const node of nodes) {
		byFile.set(node.defPath, [...byFile.get(node.defPath) ?? [], node]);
	}

	await Promise.all([...byFile].map(async ([path, inFile]) => {
		const source = files[path] ?? "";
		// An unparsable or empty file has no anchors (BABLR throws on "").
		const ids = source === "" ? undefined : await anchorsOf(source, inFile.map((node) => ({ "start": node.start, "end": node.end }))).catch(() => undefined);

		inFile.forEach((node, index) => {
			node.anchor = ids?.[index] ?? undefined;
		});
	}));

	return model;
}
