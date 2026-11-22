export interface Comment { "from": number; "to": number; "text": string; "below": number; "column"?: number }

const FOR_TOOLS = /^\s*(?:eslint-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck|check)\b|@jsx|@vite-ignore|no default\b|prettier-ignore|istanbul ignore|[cv]8 ignore|#__PURE__|webpackChunkName|global\s)|@license|@preserve|\bcopyright\b/iu;

const directive = (line: string): boolean => FOR_TOOLS.test(line.replace(/^\s*\/\/ ?/u, ""));

const lineComment = (line: string): boolean => /^\s*\/\/(?!\/)/u.test(line);
const blockStart = (line: string): boolean => /^\s*\/\*/u.test(line);
const inBlock = (line: string): boolean => /^\s*\*/u.test(line);

const anyComment = (line: string): boolean => lineComment(line) || blockStart(line) || inBlock(line);

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

	return to < lines.length && to >= line && /\*\/\s*$/u.test(lines[to])
		? [from, to]
		: undefined;
}

function besideAt(line: string): number | undefined {
	let quote: string | undefined;

	for (let at = 0; at < line.length; at += 1) {
		const char = line[at];

		if (quote !== undefined) {
			if (char === "\\") {
				at += 1;
			} else if (char === quote) {
				quote = undefined;
			}
		} else if (char === "\"" || char === "'" || char === "`") {
			quote = char;
		} else if (char === "/" && line[at + 1] === "/") {
			return at > 0 && /\s/u.test(line[at - 1]!) && line.slice(0, at).trim() !== "" ? at : undefined;
		}
	}

	return undefined;
}

function jsxAround(lines: readonly string[], line: number): [number, number] | undefined {
	let from = line;

	while (from >= 0 && !/^\s*\{\/\*/u.test(lines[from]!)) {
		if (from < line && lines[from]!.includes("*/")) {
			return undefined;
		}

		from -= 1;
	}

	if (from < 0) {
		return undefined;
	}

	let to = from;

	while (to < lines.length && !lines[to]!.includes("*/")) {
		to += 1;
	}

	return to < lines.length && to >= line && /\*\/\}\s*$/u.test(lines[to]!) ? [from, to] : undefined;
}

export function commentAt(lines: readonly string[], line: number): Comment | undefined {
	if (line < 0 || line >= lines.length) {
		return undefined;
	}

	const jsx = jsxAround(lines, line);

	if (jsx !== undefined) {
		const said = lines.slice(jsx[0], jsx[1] + 1).join("\n").replace(/^\s*\{\/\*\*?/u, "").replace(/\*\/\}\s*$/u, "").split("\n").map((each) => each.trim()).join("\n").trim();
		let below = jsx[1] + 1;

		while (below < lines.length && lines[below]!.trim() === "") {
			below += 1;
		}

		return said === "" || FOR_TOOLS.test(said) || below >= lines.length ? undefined : { "from": jsx[0], "to": jsx[1], "text": said, "below": below };
	}

	const beside = anyComment(lines[line]) ? undefined : besideAt(lines[line]);

	if (beside !== undefined) {
		const text = lines[line].slice(beside + 2).trim();

		return text === "" || FOR_TOOLS.test(text) ? undefined : { "from": line, "to": line, "text": text, "below": line, "column": beside };
	}

	let span: [number, number] | undefined;
	let text: string[];

	if (lineComment(lines[line])) {
		let from = line;
		let to = line;

		if (directive(lines[line])) {
			return undefined;
		}

		while (from > 0 && lineComment(lines[from - 1]) && !directive(lines[from - 1])) {
			from -= 1;
		}

		while (to < lines.length - 1 && lineComment(lines[to + 1]) && !directive(lines[to + 1])) {
			to += 1;
		}

		span = [from, to];
		text = lines.slice(from, to + 1).map((each) => each.replace(/^\s*\/\/ ?/u, ""));
	} else if (blockStart(lines[line]) || inBlock(lines[line])) {
		span = blockAround(lines, line);

		if (span === undefined) {
			return undefined;
		}

		text = lines.slice(span[0], span[1] + 1).map((each) => each.replace(/^\s*\/\*\*?\s?/u, "").replace(/\s*\*\/\s*$/u, "").replace(/^\s*\*/u, "").trim());
	} else {
		return undefined;
	}

	const said = text.join("\n").trim();

	if (said === "" || FOR_TOOLS.test(said)) {
		return undefined;
	}

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
