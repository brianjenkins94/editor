/**
 * What runs say could go (RUNTIME-EVIDENCE.md): from the evidence placed in a file's text, each suggestion — a `?.` that
 * never met a nullish value, a `??` or `&&`/`||` whose right side never ran, a branch arm never taken, a statement never
 * reached — with the evidence and how sure it is, and the edit that would remove it. Pure (offsets into the text, no
 * VS Code), so fixes.ts draws them and node tests them.
 *
 * Only on a strict claim: never once since the span last changed (its id changes when its code does, so its counts
 * start over), across at least `minRuns` runs and `minSeen` tries. Never isn't proof: each says how rare it could still
 * be (`bound`), and how strongly to draw it (`strength`) grows with the tries.
 */
import type { Placed } from "./evidence";

/** A suggestion: where to mark (an operator, underlined; code that never ran, tinted), why, and the edit that removes it. */
export interface Suggestion {
	"start": number;
	"end": number;
	"style": "underline" | "tint";
	/** What it says, short and plain (a list's row): `?. never nullish`. */
	"label": string;
	/** The evidence, short: `12 values in 4 runs · at most 1 in 4`. */
	"evidence": string;
	"message": string;
	"code": string;
	/** How strongly to draw it: 0 (a few tries) to 2 (hundreds). */
	"strength": 0 | 1 | 2;
	"fix"?: { "title": string; "start": number; "end": number; "text": string };
}

const runs = (n: number): string => `${n.toLocaleString("en-US")} run${n === 1 ? "" : "s"}`;
const times = (n: number): string => `${n.toLocaleString("en-US")} time${n === 1 ? "" : "s"}`;

/** With none in `n` tries, how often it could still happen: at most 3/n of the time, 95% sure (the rule of three) — and
 *  under six tries, that's half the time or more: too few to say. */
export function bound(n: number): string {
	return n < 6 ? "too few tries yet to say how rare" : `at most 1 in ${Math.floor(n / 3).toLocaleString("en-US")}, 95% sure`;
}

/** `bound`, short: without its "95% sure". */
const short = (n: number): string => bound(n).replace(", 95% sure", "");

/** How strongly the evidence speaks, by its tries. */
export function strength(n: number): 0 | 1 | 2 {
	return n >= 300 ? 2 : n >= 30 ? 1 : 0;
}

/**
 * Walk `text` at the top level of its brackets, past strings and comments: `visit` sees each character's index and its
 * bracket depth there (an opening bracket at the depth outside it), and stops the walk by returning true.
 */
function walk(text: string, visit: (index: number, depth: number) => boolean | void): void {
	let depth = 0;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];

		if (char === "\"" || char === "'" || char === "`") {
			for (index += 1; index < text.length && text[index] !== char; index += 1) {
				if (text[index] === "\\") {
					index += 1;
				}
			}
		} else if (char === "/" && next === "/") {
			index = text.includes("\n", index) ? text.indexOf("\n", index) : text.length;
		} else if (char === "/" && next === "*") {
			index = text.includes("*/", index + 2) ? text.indexOf("*/", index + 2) + 1 : text.length;
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

/** The operators at the top level of `text`: each `?.` and `??`, by offset. */
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

/** `[start, end)` of `text` between `from` and `to`, its surrounding whitespace dropped. */
function trimmed(text: string, from: number, to: number): [number, number] {
	let [start, end] = [from, to];

	while (start < end && /\s/u.test(text[start]!)) {
		start += 1;
	}

	while (end > start && /\s/u.test(text[end - 1]!)) {
		end -= 1;
	}

	return [start, end];
}

/**
 * A branch's arms in its text, as the evidence counts them: an `if`'s then and else, a `?:`'s true and false, an
 * `&&`/`||`'s right side (its short-circuit has no code). An arm with no code (an `if` without an `else`) is undefined;
 * so is the whole when the text doesn't read as its type. `test` is the condition's (or the left side's).
 */
export function armsOf(text: string, type: string): { "arms": ([number, number] | undefined)[]; "test": [number, number] } | undefined {
	if (type === "TernaryExpression") {
		let [question, colon, nested] = [-1, -1, 0];

		walk(text, (index, depth) => {
			const char = text[index];

			if (depth !== 0) {
				return undefined;
			}

			// A `?` of `?.` or `??` isn't the conditional's.
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

		return question === -1 || colon === -1 ? undefined : { "arms": [trimmed(text, question + 1, colon), trimmed(text, colon + 1, text.length)], "test": trimmed(text, 0, question) };
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

		return { "arms": [trimmed(text, close + 1, otherwise === -1 ? text.length : otherwise), otherwise === -1 ? undefined : trimmed(text, otherwise + 4, text.length)], "test": trimmed(text, open + 1, close) };
	}

	// `&&` / `||`: the last at the top level splits it (`a && b && c` is `(a && b) && c`).
	let operator = -1;

	walk(text, (index, depth) => {
		if (depth === 0 && (text.startsWith("&&", index) || text.startsWith("||", index))) {
			operator = index;
		}
	});

	return operator === -1 ? undefined : { "arms": [trimmed(text, operator + 2, text.length), undefined], "test": trimmed(text, 0, operator) };
}

/**
 * An arm's code as it would stand in the branch's place: an expression as it is; a block's statements unwrapped and
 * re-indented to `indent` (the branch's line's), its first line where the branch began.
 */
function standIn(code: string, indent: string): string {
	if (!(code.startsWith("{") && code.endsWith("}"))) {
		return code;
	}

	const lines = code.slice(1, -1).split("\n");

	while (lines.length > 0 && lines[0]!.trim() === "") {
		lines.shift();
	}

	while (lines.length > 0 && lines.at(-1)!.trim() === "") {
		lines.pop();
	}

	const common = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => /^\s*/u.exec(line)![0].length));

	return lines.map((line, index) => (index === 0 ? "" : indent) + line.slice(common)).join("\n");
}

/** The edit that removes `[start, end)` and, when it's alone on its lines, those lines. */
function removal(text: string, start: number, end: number): { "start": number; "end": number } {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.includes("\n", end) ? text.indexOf("\n", end) + 1 : text.length;

	return text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "" ? { "start": lineStart, "end": lineEnd } : { "start": start, "end": end };
}

/** What could go in `text`, by its evidence `placed` there, at the thresholds given. */
export function suggestions(text: string, placed: Placed[], minRuns: number, minSeen: number): Suggestion[] {
	const found: Suggestion[] = [];
	/** Code already marked as never run (an arm): a statement inside it isn't marked again. */
	const tinted: [number, number][] = [];
	const indentAt = (offset: number): string => /^[ \t]*/u.exec(text.slice(text.lastIndexOf("\n", offset - 1) + 1))![0];

	for (const { start, end, type, evidence } of placed) {
		const span = text.slice(start, end);
		const { value, branch } = evidence;

		if (value !== undefined && value.nullish === 0 && value.ever >= minRuns && value.seen >= minSeen) {
			const operators = topLevelOperators(span);
			// The span's own operator is its last at the top level: the one after its base, before its property or
			// arguments (`a?.b?.()`), or between its sides (`a ?? b ?? c` is `(a ?? b) ?? c`).
			const at = type === "MemberExpression" || type === "CallExpression" ? operators.optional.at(-1) : type === "BinaryExpression" ? operators.nullish.at(-1) : undefined;
			const why = `${value.seen.toLocaleString("en-US")} values in ${runs(value.ever)} since this code last changed — nullish ${bound(value.seen)}`;

			if (at !== undefined && (type === "MemberExpression" || type === "CallExpression")) {
				// `a?.b` → `a.b`; `a?.[k]` and `f?.()` → `a[k]`, `f()`.
				const replacement = /[[(]/u.test(span[at + 2] ?? "") ? "" : ".";

				found.push({ "start": start + at, "end": start + at + 2, "style": "underline", "label": "?. never nullish", "evidence": `${value.seen.toLocaleString("en-US")} values in ${runs(value.ever)} · ${short(value.seen)}`, "message": `\`?.\` never met a nullish value: ${why}.`, "code": "unneeded-optional-chain", "strength": strength(value.seen), "fix": { "title": `Remove the \`?.\` (never nullish in ${runs(value.ever)})`, "start": start + at, "end": start + at + 2, "text": replacement } });
			} else if (at !== undefined) {
				const left = trimmed(span, 0, at)[1];

				found.push({ "start": start + at, "end": end, "style": "underline", "label": "?? right side never ran", "evidence": `${value.seen.toLocaleString("en-US")} values in ${runs(value.ever)} · ${short(value.seen)}`, "message": `The right side of \`??\` never ran — its left was never nullish: ${why}.`, "code": "unneeded-nullish-coalescing", "strength": strength(value.seen), "fix": { "title": `Remove \`${span.slice(at).replace(/\s+/gu, " ").slice(0, 30)}\` (its left never nullish in ${runs(value.ever)})`, "start": start + left, "end": end, "text": "" } });
			}
		}

		const total = branch?.arms.reduce((sum, n) => sum + n, 0) ?? 0;
		const never = branch?.arms.findIndex((n) => n === 0) ?? -1;

		if (branch !== undefined && type !== undefined && branch.ever >= minRuns && never !== -1 && total >= minSeen) {
			const shape = armsOf(span, type);
			const names = type === "If" ? ["then", "else"] : type === "TernaryExpression" ? ["true", "false"] : ["right side", "short-circuit"];
			const what = type === "If" ? "`if`'s" : type === "TernaryExpression" ? "`?:`'s" : "`&&`/`||`'s";
			const why = `${times(total)} in ${runs(branch.ever)}, every one the ${names[1 - never]} — the ${names[never]} ${bound(total)}`;
			const message = `The ${what} ${names[never]} never ran: ${why}.`;
			const label = `${what.replaceAll("`", "")} ${names[never]} never ran`;
			const evidence = `${times(total)} in ${runs(branch.ever)} · ${short(total)}`;
			const arm = shape?.arms[never];
			const other = shape?.arms[1 - never];

			if (shape === undefined) {
				continue;
			}

			// What stands in the branch's place, by what always ran: the other arm (an `if` without its else: nothing; a
			// `&&`/`||` whose right side never ran: its left). An `&&`/`||` that always ran its right side keeps its left.
			const keep = type === "If" ? (other === undefined ? "" : standIn(span.slice(...other), indentAt(start))) : type === "TernaryExpression" ? span.slice(...other!) : never === 0 ? span.slice(...shape.test) : undefined;
			const fix = keep === undefined ? undefined : keep === "" ? { "title": `Remove the \`if\` (its then never ran in ${runs(branch.ever)})`, ...removal(text, start, end), "text": "" } : { "title": `Keep only \`${keep.replace(/\s+/gu, " ").slice(0, 30)}\` (the ${names[1 - never]}, every time in ${runs(branch.ever)})`, "start": start, "end": end, "text": keep };

			if (arm !== undefined) {
				tinted.push([start + arm[0], start + arm[1]]);
				found.push({ "start": start + arm[0], "end": start + arm[1], "style": "tint", "label": label, "evidence": evidence, "message": message, "code": "branch-never-taken", "strength": strength(total), ...fix === undefined ? {} : { "fix": fix } });
			} else {
				// No code to tint (an `if` without an else, never false): its condition, always one way.
				found.push({ "start": start + shape.test[0], "end": start + shape.test[1], "style": "underline", "label": label, "evidence": evidence, "message": message, "code": "branch-never-taken", "strength": strength(total), ...fix === undefined ? {} : { "fix": fix } });
			}
		}
	}

	// Statements never reached — outermost first, and not inside an arm already marked.
	const unreached = placed.filter(({ evidence }) => evidence.reached !== undefined && evidence.reached.ever === 0 && Math.round(evidence.reached.runs) >= minRuns).toSorted((a, b) => a.start - b.start || b.end - a.end);

	for (const { start, end, evidence } of unreached) {
		if (tinted.some(([from, to]) => start >= from && end <= to)) {
			continue;
		}

		const tries = Math.round(evidence.reached!.runs);

		tinted.push([start, end]);
		found.push({ "start": start, "end": end, "style": "tint", "label": "never ran", "evidence": `${runs(tries)} · ${short(tries)}`, "message": `Never ran: not once in ${runs(tries)} since this code last changed — ${bound(tries)}.`, "code": "never-reached", "strength": strength(tries), "fix": { "title": `Remove it (never ran in ${runs(tries)})`, ...removal(text, start, end), "text": "" } });
	}

	return found;
}
