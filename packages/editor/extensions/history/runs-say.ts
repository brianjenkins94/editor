/**
 * What runs say of a feature (pure): whether its code ran. A feature's own code is where it's registered (its inline handler)
 * and the declarations its registration names; what ran is each run's statements, by file, in the text it ran.
 *
 *   exercised   a statement in its own code ran;
 *   dormant     its file ran, but its own code never did;
 *   unobserved  no run ran its file: nothing to say yet.
 *
 * What it reaches beyond its own code doesn't count (a helper many features share would make them all look exercised), nor
 * does the statement that registers it, which runs whether or not it's ever used: only code strictly inside counts.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import { TOP } from "@brianjenkins94/util/silo/graph";

interface Range { "file": string; "start": number; "end": number }

export type Exercise = "exercised" | "dormant" | "unobserved";

/** A feature's own code: its registrations, and the declarations its roots name (an import followed to what it names; a
 *  module's body isn't its own). */
function codeOf(feature: Feature, graph: DeclarationGraph): Range[] {
	const code: Range[] = [...feature.ranges];
	const seen = new Set<string>();
	const pending = [...feature.roots];

	while (pending.length > 0) {
		const id = pending.pop()!;

		if (!seen.has(id) && !id.endsWith("#" + TOP)) {
			seen.add(id);

			const range = graph.fingerprints.has(id) ? graph.range?.(id) : undefined;

			if (range !== undefined) {
				code.push(range);
			} else if (!graph.fingerprints.has(id)) {
				pending.push(...graph.edges(id));
			}
		}
	}

	return code;
}

/** What runs say of `feature`: `ran`, the `[start, end)` of every statement that ran in each file as it is now (a file
 *  that some run ran, and that hasn't changed since, has an entry, empty or not). */
export function exerciseOf(feature: Feature, graph: DeclarationGraph, ran: ReadonlyMap<string, [number, number][]>): Exercise {
	const code = codeOf(feature, graph);
	const inside = code.some((range) => (ran.get(range.file) ?? []).some(([start, end]) => range.start <= start && end <= range.end && (range.start < start || end < range.end)));

	if (inside) {
		return "exercised";
	}

	return code.some((range) => ran.has(range.file)) ? "dormant" : "unobserved";
}
