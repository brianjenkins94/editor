import type { Placed, SpanEvidence } from "@brianjenkins94/editor-api/evidence";

export interface Suggestion {
	"start": number;
	"end": number;
	"style": "underline" | "tint";
	"label": string;
	"evidence": string;
	"message": string;
	"code": string;
	"strength": 0 | 1 | 2;
	"fix"?: { "title": string; "start": number; "end": number; "text": string };
}

function runs(count: number): string {
	return `${count.toLocaleString("en-US")} run${count === 1
		? ""
		: "s"}`;
}

function times(count: number): string {
	return `${count.toLocaleString("en-US")} time${count === 1
		? ""
		: "s"}`;
}

export function bound(tries: number): string {
	return tries < 6
		? "too few tries yet to say how rare"
		: `at most 1 in ${Math.floor(tries / 3).toLocaleString("en-US")}, 95% sure`;
}

const short = (tries: number): string => bound(tries).replace(", 95% sure", "");

export function strength(tries: number): 0 | 1 | 2 {
	if (tries >= 300) {
		return 2;
	}

	return tries >= 30
		? 1
		: 0;
}

function endOfQuoted(text: string, index: number): number | undefined {
	const char = text[index];
	const next = text[index + 1];

	if (char === "\"" || char === "'" || char === "`") {
		let end = index + 1;

		for (; end < text.length && text[end] !== char; end += 1) {
			if (text[end] === "\\") {
				end += 1;
			}
		}

		return end;
	}

	if (char === "/" && next === "/") {
		return text.includes("\n", index)
			? text.indexOf("\n", index)
			: text.length;
	}

	if (char === "/" && next === "*") {
		return text.includes("*/", index + 2)
			? text.indexOf("*/", index + 2) + 1
			: text.length;
	}

	return undefined;
}

function walk(text: string, visit: (index: number, depth: number) => boolean | void): void {
	let depth = 0;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const quotedEnd = endOfQuoted(text, index);

		if (quotedEnd !== undefined) {
			index = quotedEnd;
		} else {
			if (char === ")" || char === "]" || char === "}") {
				depth -= 1;
			}

			if (visit(index, depth) === true) {
				return;
			}

			if (char === "(" || char === "[" || char === "{") {
				depth += 1;
			}
		}
	}
}

export function topLevelOperators(text: string): { "optional": number[]; "nullish": number[] } {
	const optional: number[] = [];
	const nullish: number[] = [];
	let skip = -1;

	walk(text, (index, depth) => {
		if (depth !== 0 || index === skip) {
			return;
		}

		if (text[index] === "?" && text[index + 1] === "?") {
			nullish.push(index);
			skip = index + 1;
		} else if (text[index] === "?" && text[index + 1] === "." && !/\d/u.test(text[index + 2] ?? "")) {
			optional.push(index);
			skip = index + 1;
		}
	});

	return { "optional": optional, "nullish": nullish };
}

function trimmed(text: string, from: number, to: number): [number, number] {
	let [start, end] = [from, to];

	while (start < end && /\s/u.test(text[start])) {
		start += 1;
	}

	while (end > start && /\s/u.test(text[end - 1])) {
		end -= 1;
	}

	return [start, end];
}

export function armsOf(text: string, type: string): { "arms": ([number, number] | undefined)[]; "test": [number, number] } | undefined {
	if (type === "TernaryExpression") {
		let [question, colon, nested] = [-1, -1, 0];

		walk(text, (index, depth) => {
			const char = text[index];

			if (depth !== 0) {
				return undefined;
			}

			if (char === "?" && text[index + 1] !== "?" && text[index - 1] !== "?" && !(text[index + 1] === "." && !/\d/u.test(text[index + 2] ?? ""))) {
				if (question === -1) {
					question = index;
				} else {
					nested += 1;
				}
			} else if (char === ":" && question !== -1) {
				if (nested === 0) {
					colon = index;

					return true;
				}

				nested -= 1;
			}

			return undefined;
		});

		return question === -1 || colon === -1
			? undefined
			: {
					"arms": [
						trimmed(text, question + 1, colon),
						trimmed(text, colon + 1, text.length)
					],
					"test": trimmed(text, 0, question)
				};
	}

	if (type === "If") {
		let [open, close, otherwise] = [-1, -1, -1];

		walk(text, (index, depth) => {
			if (open === -1 && text[index] === "(" && depth === 0) {
				open = index;
			} else if (open !== -1 && close === -1 && text[index] === ")" && depth === 0) {
				close = index;
			} else if (close !== -1 && depth === 0 && /^else\b/u.test(text.slice(index)) && !/[\w$]/u.test(text[index - 1] ?? "")) {
				otherwise = index;

				return true;
			}

			return undefined;
		});

		if (close === -1) {
			return undefined;
		}

		return {
			"arms": [
				trimmed(text, close + 1, otherwise === -1
					? text.length
					: otherwise),
				otherwise === -1
					? undefined
					: trimmed(text, otherwise + 4, text.length)
			],
			"test": trimmed(text, open + 1, close)
		};
	}

	let operator = -1;

	walk(text, (index, depth) => {
		if (depth === 0 && (text.startsWith("&&", index) || text.startsWith("||", index))) {
			operator = index;
		}
	});

	return operator === -1
		? undefined
		: {
				"arms": [
					trimmed(text, operator + 2, text.length),
					undefined
				],
				"test": trimmed(text, 0, operator)
			};
}

function standIn(code: string, indent: string): string {
	if (!(code.startsWith("{") && code.endsWith("}"))) {
		return code;
	}

	const lines = code.slice(1, -1).split("\n");

	while (lines.length > 0 && lines[0].trim() === "") {
		lines.shift();
	}

	while (lines.length > 0 && lines.at(-1).trim() === "") {
		lines.pop();
	}

	const common = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => /^\s*/u.exec(line)[0].length));

	return lines.map((line, index) => (index === 0
		? ""
		: indent) + line.slice(common)).join("\n");
}

function removal(text: string, start: number, end: number): { "start": number; "end": number } {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.includes("\n", end)
		? text.indexOf("\n", end) + 1
		: text.length;

	return text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === ""
		? { "start": lineStart, "end": lineEnd }
		: { "start": start, "end": end };
}

const indentAt = (text: string, offset: number): string => /^[ \t]*/u.exec(text.slice(text.lastIndexOf("\n", offset - 1) + 1))[0];

function ownOperator(type: string | undefined, operators: ReturnType<typeof topLevelOperators>): number | undefined {
	if (type === "MemberExpression" || type === "CallExpression") {
		return operators.optional.at(-1);
	}

	return type === "BinaryExpression"
		? operators.nullish.at(-1)
		: undefined;
}

interface Gathering {
	"text": string;
	"found": Suggestion[];
	"tinted": [number, number][];
	"minRuns": number;
	"minSeen": number;
}

const atLeast = (count: number): string => `${count.toLocaleString("en-US")}+ runs`;

const CLAIMED = "claimed in a commit, on 30+ runs and 100+ tries";

function gatherNullish({ found }: Gathering, { start, end, type }: Placed, span: string, value: NonNullable<SpanEvidence["value"]>): void {
	const operators = topLevelOperators(span);
	const at = ownOperator(type, operators);
	const coarse = value.coarse === true;
	const tally = coarse
		? atLeast(value.ever)
		: runs(value.ever);
	const why = coarse
		? `never nullish in ${tally}, ${CLAIMED}`
		: `${value.seen.toLocaleString("en-US")} values in ${tally} since this code last changed — nullish ${bound(value.seen)}`;
	const evidence = coarse
		? `${tally} · claimed`
		: `${value.seen.toLocaleString("en-US")} values in ${tally} · ${short(value.seen)}`;
	const sure = coarse
		? 1
		: strength(value.seen);

	if (at !== undefined && (type === "MemberExpression" || type === "CallExpression")) {
		const replacement = /[[(]/u.test(span[at + 2] ?? "")
			? ""
			: ".";

		found.push({
			"start": start + at,
			"end": start + at + 2,
			"style": "underline",
			"label": "?. never nullish",
			"evidence": evidence,
			"message": `\`?.\` never met a nullish value: ${why}.`,
			"code": "unneeded-optional-chain",
			"strength": sure,
			"fix": {
				"title": `Remove the \`?.\` (never nullish in ${tally})`,
				"start": start + at,
				"end": start + at + 2,
				"text": replacement
			}
		});
	} else if (at !== undefined) {
		const [, left] = trimmed(span, 0, at);

		found.push({
			"start": start + at,
			"end": end,
			"style": "underline",
			"label": "?? right side never ran",
			"evidence": evidence,
			"message": `The right side of \`??\` never ran — its left was never nullish: ${why}.`,
			"code": "unneeded-nullish-coalescing",
			"strength": sure,
			"fix": {
				"title": `Remove \`${span.slice(at).replace(/\s+/gu, " ").slice(0, 30)}\` (its left never nullish in ${tally})`,
				"start": start + left,
				"end": end,
				"text": ""
			}
		});
	}
}

function branchWords(type: string): { "names": string[]; "what": string } {
	if (type === "If") {
		return {
			"names": ["then", "else"],
			"what": "`if`'s"
		};
	}

	if (type === "TernaryExpression") {
		return {
			"names": ["true", "false"],
			"what": "`?:`'s"
		};
	}

	return {
		"names": ["right side", "short-circuit"],
		"what": "`&&`/`||`'s"
	};
}

function keptCode(text: string, start: number, type: string, span: string, shape: NonNullable<ReturnType<typeof armsOf>>, never: number): string | undefined {
	const other = shape.arms[1 - never];

	if (type === "If") {
		return other === undefined
			? ""
			: standIn(span.slice(...other), indentAt(text, start));
	}

	if (type === "TernaryExpression") {
		return span.slice(...other);
	}

	return never === 0
		? span.slice(...shape.test)
		: undefined;
}

function gatherBranch({ text, found, tinted, minRuns, minSeen }: Gathering, { start, end, type }: Placed, span: string, branch: NonNullable<SpanEvidence["branch"]>): void {
	const total = branch.arms.reduce((sum, count) => sum + count, 0);
	const never = branch.arms.findIndex((count) => count === 0);
	const coarse = branch.coarse === true;
	const enough = coarse
		? branch.claimed === true
		: branch.ever >= minRuns && total >= minSeen;

	if (type === undefined || never === -1 || !enough) {
		return;
	}

	const shape = armsOf(span, type);
	const { names, what } = branchWords(type);
	const tally = coarse
		? atLeast(branch.ever)
		: runs(branch.ever);
	const why = coarse
		? `every time the ${names[1 - never]} in ${tally}, ${CLAIMED}`
		: `${times(total)} in ${tally}, every one the ${names[1 - never]} — the ${names[never]} ${bound(total)}`;
	const message = `The ${what} ${names[never]} never ran: ${why}.`;
	const label = `${what.replaceAll("`", "")} ${names[never]} never ran`;
	const evidence = coarse
		? `${tally} · claimed`
		: `${times(total)} in ${tally} · ${short(total)}`;
	const sure = coarse
		? 1
		: strength(total);

	if (shape === undefined) {
		return;
	}

	const arm = shape.arms[never];
	const keep = keptCode(text, start, type, span, shape, never);
	let fix: Suggestion["fix"] | undefined;

	if (keep === "") {
		fix = {
			"title": `Remove the \`if\` (its then never ran in ${tally})`,
			...removal(text, start, end),
			"text": ""
		};
	} else if (keep !== undefined) {
		fix = {
			"title": `Keep only \`${keep.replace(/\s+/gu, " ").slice(0, 30)}\` (the ${names[1 - never]}, every time in ${tally})`,
			"start": start,
			"end": end,
			"text": keep
		};
	}

	if (arm !== undefined) {
		tinted.push([start + arm[0], start + arm[1]]);
		found.push({
			"start": start + arm[0],
			"end": start + arm[1],
			"style": "tint",
			"label": label,
			"evidence": evidence,
			"message": message,
			"code": "branch-never-taken",
			"strength": sure,
			...fix === undefined
				? {}
				: { "fix": fix }
		});
	} else {
		found.push({
			"start": start + shape.test[0],
			"end": start + shape.test[1],
			"style": "underline",
			"label": label,
			"evidence": evidence,
			"message": message,
			"code": "branch-never-taken",
			"strength": sure,
			...fix === undefined
				? {}
				: { "fix": fix }
		});
	}
}

export function suggestions(text: string, placed: Placed[], minRuns: number, minSeen: number): Suggestion[] {
	const gathering: Gathering = {
		"text": text,
		"found": [],
		"tinted": [],
		"minRuns": minRuns,
		"minSeen": minSeen
	};
	const { found, tinted } = gathering;

	for (const at of placed) {
		const span = text.slice(at.start, at.end);
		const { value, branch } = at.evidence;

		if (value?.nullish === 0 && (value.coarse === true
			? value.claimed === true
			: value.ever >= minRuns && value.seen >= minSeen)) {
			gatherNullish(gathering, at, span, value);
		}

		if (branch !== undefined) {
			gatherBranch(gathering, at, span, branch);
		}
	}

	const unreached = placed.filter(({ evidence }) => evidence.reached?.ever === 0 && (evidence.reached.coarse === true
		? evidence.reached.claimed === true
		: Math.round(evidence.reached.runs) >= minRuns)).toSorted((left, right) => left.start - right.start || right.end - left.end);

	for (const { start, end, evidence } of unreached) {
		if (!tinted.some(([from, to]) => start >= from && end <= to)) {
			const tries = Math.round(evidence.reached.runs);
			const coarse = evidence.reached.coarse === true;
			const tally = coarse
				? atLeast(tries)
				: runs(tries);

			tinted.push([start, end]);
			found.push({
				"start": start,
				"end": end,
				"style": "tint",
				"label": "never ran",
				"evidence": coarse
					? `${tally} · claimed`
					: `${tally} · ${short(tries)}`,
				"message": coarse
					? `Never ran: not once in ${tally}, ${CLAIMED}.`
					: `Never ran: not once in ${tally} since this code last changed — ${bound(tries)}.`,
				"code": "never-reached",
				"strength": coarse
					? 1
					: strength(tries),
				"fix": {
					"title": `Remove it (never ran in ${tally})`,
					...removal(text, start, end),
					"text": ""
				}
			});
		}
	}

	return found;
}
