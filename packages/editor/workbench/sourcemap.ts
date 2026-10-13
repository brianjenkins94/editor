/**
 * Source maps, read: where a position in generated code (what the dev server serves) came from in the source (what's in
 * the workspace). Enough of the format (v3) to answer that — `sources` and `mappings`, the base64 VLQ segments — for the
 * inline maps the preview's dev server writes (`//# sourceMappingURL=data:…`), so a profile's hotspot lands on the line
 * you wrote rather than the line it compiled to.
 */

export interface SourceMap { "sources": string[]; "sourceRoot"?: string; "mappings": string }

/** A generated position's origin: its source file (as the map names it) and its 0-based line and column there. */
export interface OriginalPosition { "source": string; "line": number; "column": number }

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One segment's numbers: each a base64 VLQ (5 value bits a digit, continuation in the 6th, sign in the lowest bit). */
function decodeSegment(segment: string): number[] {
	const values: number[] = [];
	let value = 0;
	let shift = 0;

	for (const char of segment) {
		const digit = BASE64.indexOf(char);

		if (digit < 0) {
			return values;
		}

		value += (digit & 31) << shift;

		if ((digit & 32) === 0) {
			values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
			value = 0;
			shift = 0;
		} else {
			shift += 5;
		}
	}

	return values;
}

/** The map inlined in `code` (`//# sourceMappingURL=data:application/json;base64,…`), if there is one — the last. */
export function inlineSourceMap(code: string): SourceMap | undefined {
	const match = [...code.matchAll(/\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/gu)].at(-1);

	if (match === undefined) {
		return undefined;
	}

	try {
		const map = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0)))) as Partial<SourceMap>;

		return Array.isArray(map.sources) && typeof map.mappings === "string" ? map as SourceMap : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Where generated `line`:`column` (0-based) came from: the mapping at or before it on that line (the segment that
 * covers it), or — when the line's first mapping is after it — that first one. Undefined for a line with none.
 */
export function originalPosition(map: SourceMap, line: number, column: number): OriginalPosition | undefined {
	// Source, line and column are relative to the previous segment's across the whole map; the generated column, to the
	// previous segment's on the same line. So decode up to `line`, carrying them.
	let source = 0;
	let sourceLine = 0;
	let sourceColumn = 0;
	const lines = map.mappings.split(";");

	for (let at = 0; at <= line && at < lines.length; at++) {
		let generatedColumn = 0;
		let best: OriginalPosition | undefined;

		for (const segment of lines[at].split(",")) {
			const values = decodeSegment(segment);

			if (values.length < 4) {
				generatedColumn += values[0] ?? 0;
				continue; // no source: a generated-only segment
			}

			generatedColumn += values[0];
			source += values[1];
			sourceLine += values[2];
			sourceColumn += values[3];

			if (at === line && (best === undefined || generatedColumn <= column)) {
				best = { "source": (map.sourceRoot ?? "") + (map.sources[source] ?? ""), "line": sourceLine, "column": sourceColumn };
			}
		}

		if (at === line) {
			return best;
		}
	}

	return undefined;
}
