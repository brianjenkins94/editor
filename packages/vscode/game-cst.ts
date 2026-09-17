/**
 * A tiny query layer over BABLR's `cstSpans` — the real concrete syntax tree behind history/comments/identity.
 *
 * The game-maker surfaces are PROJECTIONS OF THE CST, not regex over the text: we parse the source into typed
 * nodes (CallExpression, MemberExpression, Array, ArrayElement, String, Number, Identifier, …), query them by
 * type/callee/field, and read values from concrete node spans. Every node carries its exact source span, so a
 * projection edit (e.g. painting a tile) is a surgical replacement of one node's `[start, end)` — the same
 * mechanism that will carry write-back and, later, BABLR-identity anchoring.
 *
 * `cstSpans` emits spans in close order with a `field` (the reference a node was emitted under) and a `cover`
 * flag (wrapper nodes like `Expression`/`JSONExpression` that share their child's span). We build a containment
 * tree (covers nested outside their concrete node) and, when walking, flatten cover wrappers while propagating
 * their `field` down — so `kids(call)` yields the concrete arguments already tagged `field: "arguments"`.
 */
import { cstSpans, reidentify } from "@brianjenkins94/bablr";

import type { IdSnapshot } from "./game-model";

export interface Node {
	"type": string | null;
	"field": string | null;
	"start": number;
	"end": number;
	"token": boolean;
	"cover": boolean;
	"text": string;
	"children": Node[];
}

/** The raw span shape `cstSpans` emits (close order, with trivia/cover/token flags). */
type RawSpan = { "type": string | null; "field": string | null; "start": number; "end": number; "token": boolean; "cover": boolean; "trivia": boolean };

/** Build the CST tree from already-computed spans (a synthetic `Program` root spanning the source). */
function buildTree(spans: RawSpan[], code: string): Node {
	// Pre-order: outer node first; for an equal span (a cover chain) the outer one closed LATER, i.e. has the
	// higher original (close-order) index — so break ties by index descending.
	const ordered = spans.map((span, index) => ({ span, index }))
		.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end || b.index - a.index);

	const root: Node = { "type": "Program", "field": null, "start": 0, "end": code.length, "token": false, "cover": false, "text": code, "children": [] };
	const stack: Node[] = [root];

	for (const { span } of ordered) {
		const node: Node = { "type": span.type, "field": span.field, "start": span.start, "end": span.end, "token": span.token, "cover": span.cover, "text": code.slice(span.start, span.end), "children": [] };

		while (stack.length > 1) {
			const top = stack[stack.length - 1];

			if (node.start >= top.start && node.end <= top.end) {
				break; // contained (equal spans nest, since the outer was sorted first)
			}

			stack.pop();
		}

		stack[stack.length - 1].children.push(node);
		stack.push(node);
	}

	return root;
}

/** Parse `code` into a CST tree (a synthetic `Program` root spanning the whole source). */
export function parse(code: string): Node {
	return buildTree((cstSpans(code) as { "spans": RawSpan[] }).spans, code);
}

/**
 * Parse ONCE, returning both the CST tree and the stable-identity view — a single `cstSpans` pass feeds both.
 * BABLR is slow, so a file is never parsed more than once (previously extraction, the identity spans, and
 * `nodeAtoms` each re-parsed — three passes; this is one).
 */
export function parseSource(code: string, prior: IdSnapshot | null = null): { "root": Node; "identity": Identity } {
	const spans = (cstSpans(code) as { "spans": RawSpan[] }).spans;

	return { "root": buildTree(spans, code), "identity": identityFromSpans(spans, code, prior) };
}

/** Direct children with cover wrappers flattened away, propagating a cover's `field` onto its concrete child. */
export function kids(node: Node): Node[] {
	const out: Node[] = [];

	for (const child of node.children) {
		if (child.cover) {
			for (const grandchild of kids(child)) {
				out.push(grandchild.field === null && child.field !== null ? { ...grandchild, "field": child.field } : grandchild);
			}
		} else {
			out.push(child);
		}
	}

	return out;
}

/** Every node in the subtree (covers included) matching `predicate`, pre-order. */
export function findAll(node: Node, predicate: (node: Node) => boolean): Node[] {
	const out: Node[] = [];

	const walk = (current: Node): void => {
		if (predicate(current)) {
			out.push(current);
		}

		for (const child of current.children) {
			walk(child);
		}
	};

	for (const child of node.children) {
		walk(child);
	}

	return out;
}

/** The method/function name a CallExpression invokes: `obj.foo(...)` → "foo", bare `foo(...)` → "foo". */
export function calleeName(call: Node): string | undefined {
	// The callee is the non-argument child that is a name expression — an Identifier (bare call, a token) or a
	// MemberExpression (`obj.foo`, whose `property` Identifier is the method).
	const callee = kids(call).find((child) => child.field !== "arguments" && (child.type === "Identifier" || child.type === "MemberExpression"));

	if (callee === undefined) {
		return undefined;
	}

	return callee.type === "MemberExpression" ? kids(callee).find((child) => child.field === "property")?.text : callee.text;
}

/** A CallExpression's concrete argument nodes, in order. */
export function callArguments(call: Node): Node[] {
	return kids(call).filter((child) => child.field === "arguments");
}

/** All CallExpressions in `root` whose callee name is `name`. */
export function callsNamed(root: Node, name: string): Node[] {
	return findAll(root, (node) => node.type === "CallExpression" && calleeName(node) === name);
}

/** The string value of a String node (its `StringContent`, else the text with the quotes stripped). */
export function stringValue(node: Node): string {
	const content = findAll(node, (inner) => inner.type === "StringContent" || inner.field === "content")[0];

	return content !== undefined ? content.text : node.text.replace(/^["'`]|["'`]$/gu, "");
}

/** The numeric value of a Number node. */
export function numberValue(node: Node): number {
	return Number(node.text.trim());
}

/** The concrete element nodes of an Array node, in order (each is the element's value node). */
export function arrayElements(node: Node): Node[] {
	// Each element's value carries field "value" (propagated from its cover); this keeps holes/identifiers like
	// `_` (token Identifiers) that a `!token` filter would wrongly drop.
	return kids(node)
		.filter((child) => child.field === "elements")
		.map((element) => kids(element).find((inner) => inner.field === "value"))
		.filter((value): value is Node => value !== undefined);
}

/** Stable-identity view of a file: a concrete node → its durable BABLR node id (fileHash:ordinal, carried across
 *  edits by `reidentify`) and its 1-based line. This is the anchoring spine — data pins to node ids, not spans. */
export interface Identity {
	/** The stable node id for a concrete node (by its `[start,end)` span), or undefined if unidentified. */
	"idOf": (node: Node) => string | undefined;
	/** The 1-based line a node starts on. */
	"lineOf": (node: Node) => number;
	/** Every identified node's line (id → line) — for the reverse (a line → its node ids). */
	"nodeLines": Record<string, number>;
	/** The identity snapshot this derivation produced — persist it as the `.ts.bablr` index + next `reidentify`
	 *  baseline (so the following edit carries ids forward). */
	"snapshot": IdSnapshot;
}

/** 1-based line at a source offset. */
function lineAt(code: string, offset: number): number {
	let line = 1;

	for (let index = 0; index < offset && index < code.length; index += 1) {
		if (code[index] === "\n") {
			line += 1;
		}
	}

	return line;
}

/** The trivia-insensitive atom of each non-trivia span — a local, verified-identical replica of BABLR's own
 *  `atomsFromSpans` (`type\t<JSON tokenText>`), so we derive atoms from the spans we ALREADY have instead of
 *  re-parsing via `nodeAtoms`. Identical atoms → identical ids, consistent with the comments/history spine. */
function atomsFromSpans(code: string, spans: RawSpan[]): string[] {
	const atoms: string[] = [];

	for (const span of spans) {
		if (span.trivia) {
			continue;
		}

		atoms.push((span.type ?? "") + "\t" + (span.token ? JSON.stringify(code.slice(span.start, span.end)) : ""));
	}

	return atoms;
}

/**
 * Stable node identity from already-computed spans: `reidentify(null, atoms)` yields a snapshot whose nodes align
 * 1:1 with the non-trivia spans (the alignment history-identity uses), so each concrete node gets a durable id +
 * line. Ids survive edits via `reidentify` — the basis for anchoring event-sheet data, dispositions, breakpoints,
 * comments and history to a node as it moves. No re-parse: atoms come from the passed spans.
 */
function identityFromSpans(spans: RawSpan[], code: string, prior: IdSnapshot | null): Identity {
	const nonTrivia = spans.filter((span) => !span.trivia);
	const byRange = new Map<string, string>();
	const nodeLines: Record<string, number> = {};

	let snapshot: IdSnapshot = { "nodes": [] };

	try {
		// Reidentify FROM the prior snapshot so ids carry across edits (an insertion keeps every unchanged node's
		// id, rather than re-bootstrapping ordinals). null prior → first derivation bootstraps.
		snapshot = reidentify(prior, atomsFromSpans(code, spans)) as IdSnapshot;
	} catch { /* unparsable — no identity, callers fall back to spans */ }

	snapshot.nodes.forEach((node, index) => {
		const span = nonTrivia[index];

		if (span === undefined) {
			return;
		}

		const id = String(node.id);
		const key = `${span.start}:${span.end}`;

		// Concrete (non-cover) wins a shared range (a Number vs its Expression cover) — element spans are concrete.
		if (!byRange.has(key) || !span.cover) {
			byRange.set(key, id);
		}

		nodeLines[id] = lineAt(code, span.start);
	});

	return {
		"idOf": (node) => byRange.get(`${node.start}:${node.end}`),
		"lineOf": (node) => lineAt(code, node.start),
		"nodeLines": nodeLines,
		"snapshot": snapshot
	};
}

/** Stable node identity for `code` (parses once), reidentified from an optional prior `.ts.bablr` snapshot so ids
 *  carry across edits. Prefer `parseSource` when you also need the tree. */
export function identify(code: string, prior: IdSnapshot | null = null): Identity {
	return identityFromSpans((cstSpans(code) as { "spans": RawSpan[] }).spans, code, prior);
}

/** Concrete property entries of an `Object` node: `[keyText, valueNode]` per property.
 *  Shape: Object → ObjectElement(field="elements") → Property → { ObjectKey (cover, wraps the key), Expression
 *  (cover, field="value", wraps the value) }. The key and value both carry field "value" once covers are
 *  flattened, so we read the Property's RAW children and tell them apart by node TYPE (ObjectKey vs Expression). */
export function objectProperties(node: Node): [string, Node][] {
	const out: [string, Node][] = [];

	for (const element of kids(node).filter((child) => child.field === "elements")) {
		const property = element.type === "Property" ? element : kids(element).find((inner) => inner.type === "Property");

		if (property === undefined) {
			continue;
		}

		const keyCover = property.children.find((child) => child.type === "ObjectKey");
		const valueCover = property.children.find((child) => child.type === "Expression" && child.field === "value");
		const key = keyCover !== undefined ? kids(keyCover)[0] : undefined;
		const value = valueCover !== undefined ? kids(valueCover)[0] : undefined;

		if (key !== undefined && value !== undefined) {
			out.push([key.type === "String" ? stringValue(key) : key.text, value]);
		}
	}

	return out;
}
