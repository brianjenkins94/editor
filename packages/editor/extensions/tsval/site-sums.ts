import type { SiteObservation } from "@brianjenkins94/editor-api";
import type { ObserveSite } from "@brianjenkins94/tsval";
import type ts from "typescript";
import { typeTag } from "@brianjenkins94/tsval/values";

const MAX_TAGS = 8;
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 40;

interface Sums { "site": ObserveSite; "seen": number; "nullish": number; "tags": Record<string, number>; "samples": (string | number | boolean)[]; "arms": number[] }

export type SiteSums<Key = ts.Node> = Map<Key, Sums>;

export function addObservation<Key>(sums: SiteSums<Key>, node: Key, site: ObserveSite, value: unknown): void {
	let known = sums.get(node);

	if (known === undefined) {
		known = {
			"site": site,
			"seen": 0,
			"nullish": 0,
			"tags": {},
			"samples": [],
			"arms": site === "branch"
				? [0, 0]
				: []
		};
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
	const counted = tag in known.tags || Object.keys(known.tags).length < MAX_TAGS
		? tag
		: "other";

	known.tags[counted] = (known.tags[counted] ?? 0) + 1;

	const sample = sampleOf(value);

	if (sample !== undefined && known.samples.length < MAX_SAMPLES && !known.samples.includes(sample)) {
		known.samples.push(sample);
	}
}

function sampleOf(value: unknown): string | number | boolean | undefined {
	if (typeof value === "string") {
		return value.slice(0, SAMPLE_CHARS);
	}

	return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
		? value
		: undefined;
}

export function copySums(sums: SiteSums | undefined): SiteSums {
	return new Map([
		...sums ?? []
	].map(([node, known]) => [
		node,
		{
			...known,
			"tags": { ...known.tags },
			"samples": [...known.samples],
			"arms": [...known.arms]
		}
	]));
}

export function siteObservations(sums: SiteSums | undefined, file: ts.SourceFile): SiteObservation[] {
	const position = (offset: number): [number, number] => {
		const { line, character } = file.getLineAndCharacterOfPosition(offset);

		return [line, character];
	};

	return [
		...sums ?? []
	].filter(([node]) => node.getSourceFile() === file).sort(([left], [right]) => left.getStart(file) - right.getStart(file)).map(([node, known]) => ({
		"start": position(node.getStart(file)),
		"end": position(node.getEnd()),
		...summary(known)
	}));
}

export function summary(known: Sums): Omit<SiteObservation, "start" | "end"> {
	return {
		"site": known.site,
		...known.site === "branch"
			? { "arms": known.arms }
			: {
					"seen": known.seen,
					"nullish": known.nullish,
					"tags": known.tags,
					...known.samples.length > 0
						? { "samples": known.samples }
						: {}
				}
	};
}
