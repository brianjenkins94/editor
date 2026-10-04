/**
 * Durable anchoring — the BABLR half of the projection, and BABLR's actual strength.
 *
 * The recognizer (TS AST) gives each node a source RANGE, but ranges are fragile: any edit above a node shifts them. So
 * we give each node a content-addressed `spanAnchors` id — move-stable, shift-resistant, self-edit-aware — that future
 * attachments (annotations, extracted custom-code snippets, orphan detection) can key on. This is what "annotate the CST
 * in place with change-resistant anchors" means: the map's identity survives edits.
 *
 * Runs where BABLR lives (the recognizer worker). Per file, derive spanAnchors once; per node, pick the anchor that best
 * represents its range (bablr-language-ts's pickAnchor — the evidence store matches coverage the same way).
 */
import { pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import type { GameModel, NodeLoc } from "./recognizer";

type Anchor = ReturnType<typeof spanAnchors>[number];

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
