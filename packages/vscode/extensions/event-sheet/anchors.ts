/**
 * Durable anchoring — the BABLR half of the projection, and BABLR's actual strength.
 *
 * The recognizer (TS AST) gives each node a source RANGE, but ranges are fragile: any edit above a node shifts them. So
 * we give each node a content-addressed `spanAnchors` id — move-stable, shift-resistant, self-edit-aware — that future
 * attachments (annotations, extracted custom-code snippets, orphan detection) can key on. This is what "annotate the CST
 * in place with change-resistant anchors" means: the map's identity survives edits.
 *
 * Runs where BABLR lives (the recognizer worker). Per file, derive spanAnchors once; per node, pick the anchor that best
 * represents its range: the LARGEST BARE-hash span fully inside the node (bare = unique content, no `#ordinal`, so it
 * tracks moves without duplicate-ordinal churn — the finding from the row-anchor work), falling back to max overlap when
 * the TS and BABLR node boundaries don't line up exactly.
 */
import { spanAnchors } from "@brianjenkins94/bablr";
import type { GameModel, NodeLoc } from "./recognizer";

interface Anchor { "type": string | null; "start": number; "end": number; "id": string }

/** The durable anchor id best representing the range [start, end), or undefined if nothing matched. */
function pickAnchor(anchors: Anchor[], start: number, end: number): string | undefined {
	let inside: { "id": string; "bare": boolean; "size": number } | undefined;
	let overlap: { "id": string; "score": number } | undefined;

	for (const anchor of anchors) {
		if (anchor.type === null) {
			continue; // punctuation — never a stable handle
		}

		const score = Math.max(0, Math.min(anchor.end, end) - Math.max(anchor.start, start));

		if (score <= 0) {
			continue;
		}

		if (anchor.start >= start && anchor.end <= end) {
			const bare = !anchor.id.includes("#");
			const size = anchor.end - anchor.start;

			// bare beats ordinal'd; then larger beats smaller (the node's own top span).
			if (inside === undefined || (bare && !inside.bare) || (bare === inside.bare && size > inside.size)) {
				inside = { "id": anchor.id, "bare": bare, "size": size };
			}
		}

		if (overlap === undefined || score > overlap.score) {
			overlap = { "id": anchor.id, "score": score };
		}
	}

	return (inside ?? overlap)?.id;
}

/**
 * Attach a durable anchor id to every recognized node in the model (mutates + returns it). Cross-file: spanAnchors is
 * derived once per file and reused for every node in it.
 */
export function anchorGame(files: Record<string, string>, model: GameModel): GameModel {
	const cache = new Map<string, Anchor[]>();

	const anchorsFor = (path: string): Anchor[] => {
		let anchors = cache.get(path);

		if (anchors === undefined) {
			try {
				anchors = spanAnchors(files[path] ?? "") as Anchor[];
			} catch {
				anchors = []; // unparsable / empty file — no anchors (BABLR throws on "")
			}

			cache.set(path, anchors);
		}

		return anchors;
	};

	const attach = (node: NodeLoc): void => {
		node.anchor = pickAnchor(anchorsFor(node.defPath), node.start, node.end);
	};

	for (const behavior of model.behaviors) {
		attach(behavior);
	}

	for (const composite of model.composites) {
		attach(composite);
	}

	for (const object of model.objects) {
		attach(object);
	}

	for (const rule of model.rules) {
		attach(rule);

		for (const row of rule.rows) {
			attach(row);
		}
	}

	return model;
}
