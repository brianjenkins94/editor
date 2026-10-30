/**
 * Structural search and rewrite on TypeScript's tree (agents' `code_query` / `code_rewrite`, through history's tsserver
 * plugin): a pattern is code, matched node for node, whitespace and comments aside.
 *
 * - `$X` (a `$` and a capital) matches any one node, and the same text wherever else it's written in the pattern.
 * - `$$$` or `$$$X` matches any run of the list it's in — arguments, elements, statements — none included.
 * - Everything else matches itself: the same kind of node, the same names and literals (a string by its value, in
 *   either quotes), the same operators.
 *
 * A pattern is one expression or one statement (`request("shell.run", $$$)`, `$A.indexOf($B) !== -1`,
 * `if ($C) { $$$ }`). A rewrite's template is text, with each metavariable's binding put in where it's named.
 * `ts` is the caller's (the TypeScript server's own, in the plugin; Node's, in the tests).
 */
import type * as TS from "typescript";

/** What a metavariable bound: one node, or a run of a list's. */
type Bound = TS.Node | TS.Node[];

/** A match: where, and what each named metavariable bound (its text). */
export interface PatternMatch {
	"start": number;
	"end": number;
	"bindings": Record<string, string>;
}

const ONE = /^\$[A-Z][\w]*$/u;
const RUN = /^\$\$\$(?:[A-Z][\w]*)?$/u;

/** The pattern's node: its one expression, or its one statement. Throws on a pattern that isn't one. */
export function patternNode(ts: typeof TS, pattern: string): TS.Node {
	const source = ts.createSourceFile("pattern.ts", pattern, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const [statement, ...more] = source.statements;

	if (statement === undefined || more.length > 0) {
		throw new Error(`a pattern is one expression or one statement: ${pattern}`);
	}

	if ((source as unknown as { "parseDiagnostics"?: unknown[] }).parseDiagnostics?.length) {
		throw new Error(`the pattern doesn't parse: ${pattern}`);
	}

	return ts.isExpressionStatement(statement) ? statement.expression : statement;
}

/** A node's children as TypeScript lists them: each a node, or a list (where `$$$` can stand for a run). */
function slots(ts: typeof TS, node: TS.Node): (TS.Node | readonly TS.Node[])[] {
	const found: (TS.Node | readonly TS.Node[])[] = [];

	ts.forEachChild(node, (child) => {
		found.push(child);
	}, (list) => {
		found.push(list);
	});

	return found;
}

/** The metavariable a pattern node is, if it is one: `$X`, or `$$$` / `$$$X` (an identifier, or a statement of one). */
function metavariable(ts: typeof TS, node: TS.Node): { "name": string; "run": boolean } | undefined {
	const identifier = ts.isExpressionStatement(node) ? node.expression : node;

	if (!ts.isIdentifier(identifier)) {
		return undefined;
	}

	const text = identifier.text;

	if (RUN.test(text)) {
		return { "name": text.slice(3), "run": true };
	}

	return ONE.test(text) ? { "name": text.slice(1), "run": false } : undefined;
}

/** Whether `target` is what `pattern` says, binding its metavariables into `bound`. */
function matches(ts: typeof TS, pattern: TS.Node, target: TS.Node, bound: Map<string, Bound>, source: TS.SourceFile): boolean {
	const variable = metavariable(ts, pattern);

	if (variable !== undefined && !variable.run) {
		const known = bound.get(variable.name);

		if (known === undefined) {
			bound.set(variable.name, target);

			return true;
		}

		return !Array.isArray(known) && (known as TS.Node).getText(source) === target.getText(source);
	}

	if (pattern.kind !== target.kind) {
		return false;
	}

	const [mine, theirs] = [slots(ts, pattern), slots(ts, target)];

	// (a string is its value, whichever quotes it's in)
	if (ts.isStringLiteralLike(pattern) && ts.isStringLiteralLike(target)) {
		return pattern.text === target.text;
	}

	// (a leaf — a name, a literal, a keyword, an operator — is itself: its text)
	if (mine.length === 0 || theirs.length === 0) {
		return mine.length === theirs.length && pattern.getText() === target.getText(source);
	}

	if (mine.length !== theirs.length) {
		return false;
	}

	return mine.every((slot, index) => {
		const other = theirs[index];

		if (Array.isArray(slot) !== Array.isArray(other)) {
			return false;
		}

		return Array.isArray(slot) ? listMatches(ts, slot, other as readonly TS.Node[], bound, source) : matches(ts, slot as TS.Node, other as TS.Node, bound, source);
	});
}

/** Whether the list `targets` is what the list `patterns` says, a `$$$` standing for any run of it. */
function listMatches(ts: typeof TS, patterns: readonly TS.Node[], targets: readonly TS.Node[], bound: Map<string, Bound>, source: TS.SourceFile): boolean {
	if (patterns.length === 0) {
		return targets.length === 0;
	}

	const [first, ...rest] = patterns;
	const variable = metavariable(ts, first);

	if (variable?.run === true) {
		// (the shortest run first, then longer: a run of nothing is a run)
		for (let take = 0; take <= targets.length; take += 1) {
			const tried = new Map(bound);

			if (listMatches(ts, rest, targets.slice(take), tried, source)) {
				if (variable.name !== "") {
					tried.set(variable.name, [...targets.slice(0, take)]);
				}

				for (const [name, value] of tried) {
					bound.set(name, value);
				}

				return true;
			}
		}

		return false;
	}

	if (targets.length === 0) {
		return false;
	}

	const tried = new Map(bound);

	if (matches(ts, first, targets[0], tried, source) && listMatches(ts, rest, targets.slice(1), tried, source)) {
		for (const [name, value] of tried) {
			bound.set(name, value);
		}

		return true;
	}

	return false;
}

/** A binding's text in `source`: a node's, or a run's (from its first to its last; none, for an empty run). */
function textOf(value: Bound, source: TS.SourceFile): string {
	if (!Array.isArray(value)) {
		return value.getText(source);
	}

	return value.length === 0 ? "" : source.text.slice(value[0].getStart(source), value.at(-1)?.getEnd());
}

/** Every place in `source` that `pattern` (a `patternNode`) matches, outermost first, in order; a match inside another
 *  is listed too (a rewrite takes the outermost). */
export function matchPattern(ts: typeof TS, pattern: TS.Node, source: TS.SourceFile): PatternMatch[] {
	const found: PatternMatch[] = [];
	const visit = (node: TS.Node): void => {
		const bound = new Map<string, Bound>();

		if (matches(ts, pattern, node, bound, source)) {
			found.push({ "start": node.getStart(source), "end": node.getEnd(), "bindings": Object.fromEntries([...bound].map(([name, value]) => [name, textOf(value, source)])) });
		}

		ts.forEachChild(node, visit);
	};

	ts.forEachChild(source, visit);

	return found;
}

/** `template` with each metavariable it names (`$X`, `$$$X`) as `bindings` bound it. */
export function filledIn(template: string, bindings: Record<string, string>): string {
	return template.replaceAll(/\$\$\$([A-Z]\w*)|\$([A-Z]\w*)/gu, (whole, run: string | undefined, one: string | undefined) => bindings[run ?? one ?? ""] ?? whole);
}

/** The edits rewriting each outermost match of `matched` with `template`. */
export function rewrites(matched: PatternMatch[], template: string): { "start": number; "end": number; "text": string }[] {
	const outermost = matched.filter((match) => !matched.some((other) => other !== match && other.start <= match.start && other.end >= match.end && (other.start < match.start || other.end > match.end)));

	return outermost.map((match) => ({ "start": match.start, "end": match.end, "text": filledIn(template, match.bindings) }));
}
