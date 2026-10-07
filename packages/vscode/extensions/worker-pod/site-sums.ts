/**
 * What went through each observed site of a tsval run (its `observe` hook), summed as the program runs: the debug
 * worker's half of runtime evidence's values and branches (RUNTIME-EVIDENCE.md, the second slice). Nothing is kept per
 * event. A timeline's sums are its own: a fork (time travel's next step) starts from a copy, as coverage does. The page
 * runtime (page-evidence.ts) sums a preview's sites the same way, keyed by its site index instead of a node.
 */
import type { ObserveSite } from "@brianjenkins94/tsval";
import type ts from "typescript";
import type { SiteObservation } from "./debug-protocol";
// typeTag alone, not the interpreter: the page runtime bundles this into every preview page.
import { typeTag } from "../../../tsval/src/values";

/** At most this many type tags a site; the rest count as `other`. */
const MAX_TAGS = 8;
/** At most this many distinct primitives a site keeps, each string cut to SAMPLE_CHARS. */
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 40;

interface Sums { "site": ObserveSite; "seen": number; "nullish": number; "tags": Record<string, number>; "samples": (string | number | boolean)[]; "arms": number[] }

export type SiteSums<Key = ts.Node> = Map<Key, Sums>;

/** Add what `site` (`node`, or whatever keys the sums) was just told — a value, or for a branch the arm that ran — to
 *  `sums`. */
export function addObservation<Key>(sums: SiteSums<Key>, node: Key, site: ObserveSite, value: unknown): void {
	let known = sums.get(node);

	if (known === undefined) {
		// Every branch site tsval observes has two arms (then/else; the right side ran/didn't).
		known = { "site": site, "seen": 0, "nullish": 0, "tags": {}, "samples": [], "arms": site === "branch" ? [0, 0] : [] };
		sums.set(node, known);
	}

	if (site === "branch") {
		known.arms[value as number] = (known.arms[value as number] ?? 0) + 1;

		return;
	}

	known.seen += 1;

	if (value === null || value === undefined) {
		known.nullish += 1;
	}

	const tag = typeTag(value);
	const counted = tag in known.tags || Object.keys(known.tags).length < MAX_TAGS ? tag : "other";

	known.tags[counted] = (known.tags[counted] ?? 0) + 1;

	const sample = typeof value === "string" ? value.slice(0, SAMPLE_CHARS) : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;

	if (sample !== undefined && known.samples.length < MAX_SAMPLES && !known.samples.includes(sample)) {
		known.samples.push(sample);
	}
}

/** A copy of `sums` a fork goes on adding to, leaving the original as it was. */
export function copySums(sums: SiteSums | undefined): SiteSums {
	return new Map([...sums ?? []].map(([node, known]) => [node, { ...known, "tags": { ...known.tags }, "samples": [...known.samples], "arms": [...known.arms] }]));
}

/** Each site that ran, with its node's range in `file` (0-based line and character), in source order. */
export function siteObservations(sums: SiteSums | undefined, file: ts.SourceFile): SiteObservation[] {
	const position = (offset: number): [number, number] => {
		const { line, character } = file.getLineAndCharacterOfPosition(offset);

		return [line, character];
	};

	return [...sums ?? []].filter(([node]) => node.getSourceFile() === file).sort(([a], [b]) => a.getStart(file) - b.getStart(file)).map(([node, known]) => ({ "start": position(node.getStart(file)), "end": position(node.getEnd()), ...summary(known) }));
}

/** What a site's sums say, as a report gives it: for a branch its arms, for a value its counts, tags and samples. */
export function summary(known: Sums): Omit<SiteObservation, "start" | "end"> {
	return { "site": known.site, ...known.site === "branch" ? { "arms": known.arms } : { "seen": known.seen, "nullish": known.nullish, "tags": known.tags, ...known.samples.length > 0 ? { "samples": known.samples } : {} } };
}
