/**
 * A comment as a note would take it (packages/editor/ARCHITECTURE.md, *Comments become notes*): a whole-line comment — a run
 * of `//` lines, or a `/* … *\/` block — its text off the markers, and the code just below it, which the note stands on.
 * One that's for a tool stays a comment: `eslint-disable`, `@ts-expect-error`, a license, a triple-slash reference.
 */

/** A comment: its lines (0-based, both ends in), its text, and the line of the code below it. */
export interface Comment { "from": number; "to": number; "text": string; "below": number }

/** What a tool reads: kept as a comment. */
const FOR_TOOLS = /eslint-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck|check)\b|@license|@preserve|\bcopyright\b|prettier-ignore|istanbul ignore|[cv]8 ignore|#__PURE__|webpackChunkName|^\s*global\s/iu;

const lineComment = (line: string): boolean => /^\s*\/\/(?!\/)/u.test(line);
const blockStart = (line: string): boolean => /^\s*\/\*/u.test(line);
const inBlock = (line: string): boolean => /^\s*\*/u.test(line);

/** Whether a line is any comment's (a line comment, a block's start, middle or end). */
const anyComment = (line: string): boolean => lineComment(line) || blockStart(line) || inBlock(line);

/** A block comment's lines around `line`: from its `/*` to its `*\/`, each alone on its lines. */
function blockAround(lines: readonly string[], line: number): [number, number] | undefined {
	let from = line;

	while (from >= 0 && !blockStart(lines[from])) {
		if (!inBlock(lines[from]) || (from < line && lines[from].includes("*/"))) {
			return undefined;
		}

		from -= 1;
	}

	if (from < 0) {
		return undefined;
	}

	let to = from;

	while (to < lines.length && !lines[to].includes("*/")) {
		to += 1;
	}

	// (nothing after it on its last line: a comment beside code isn't one a note takes)
	return to < lines.length && to >= line && /\*\/\s*$/u.test(lines[to])
		? [from, to]
		: undefined;
}

/** The comment `line` (0-based) is in, as a note would take it; undefined when it's in none, the comment is a tool's,
 *  or there's no code below it to stand on. */
export function commentAt(lines: readonly string[], line: number): Comment | undefined {
	if (line < 0 || line >= lines.length) {
		return undefined;
	}

	let span: [number, number] | undefined;
	let text: string[];

	if (lineComment(lines[line])) {
		let from = line;
		let to = line;

		while (from > 0 && lineComment(lines[from - 1])) {
			from -= 1;
		}

		while (to < lines.length - 1 && lineComment(lines[to + 1])) {
			to += 1;
		}

		span = [from, to];
		text = lines.slice(from, to + 1).map((each) => each.replace(/^\s*\/\/ ?/u, ""));
	} else if (blockStart(lines[line]) || inBlock(lines[line])) {
		span = blockAround(lines, line);

		if (span === undefined) {
			return undefined;
		}

		text = lines.slice(span[0], span[1] + 1).map((each) => each.replace(/^\s*\/\*\*?\s?/u, "").replace(/\s*\*\/\s*$/u, "").replace(/^\s*\* ?/u, ""));
	} else {
		return undefined;
	}

	const said = text.join("\n").trim();

	if (said === "" || FOR_TOOLS.test(said)) {
		return undefined;
	}

	// (the code below: past blank lines and any other comment, a tool's say)
	let below = span[1] + 1;

	while (below < lines.length && (lines[below].trim() === "" || anyComment(lines[below]))) {
		below += 1;
	}

	return below < lines.length
		? {
				"from": span[0],
				"to": span[1],
				"text": said,
				"below": below
			}
		: undefined;
}
