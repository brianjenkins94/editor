import type { Feature } from "@brianjenkins94/util/silo/features";
import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import { TOP } from "@brianjenkins94/util/silo/graph";

interface Range { "file": string; "start": number; "end": number }

export type Exercise = "exercised" | "dormant" | "unobserved";

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

export function exerciseOf(feature: Feature, graph: DeclarationGraph, ran: ReadonlyMap<string, [number, number][]>): Exercise {
	const code = codeOf(feature, graph);
	const inside = code.some((range) => (ran.get(range.file) ?? []).some(([start, end]) => range.start <= start && end <= range.end && (range.start < start || end < range.end)));

	if (inside) {
		return "exercised";
	}

	return code.some((range) => ran.has(range.file)) ? "dormant" : "unobserved";
}
