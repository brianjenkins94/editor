/**
 * Reverse-projection recognizer — maps a game's BABLR CST INTO the event-sheet toolbox (objects · behaviors · rules),
 * so the code stays the source of truth and the sheet is a strong, derived view of it (see the event-sheet vision).
 *
 * "Strong" = maximize what folds into the toolbox and minimize opaque custom code. This module grows one idiom-matcher
 * at a time, keyed to the house-style (bitECS + Phaser). The FIRST and highest-leverage matcher is component→BEHAVIOR:
 * it's what hides bitECS and creates the toolbox's force multiplier (attach behaviors to an object → it gains
 * capabilities). A behavior is an exported component — a DATA component (`{ field: new Uint8Array(N) }`) or a TAG
 * (`export const X: number[] = []`) — CONFIRMED by usage in `query(...)`/`addComponent(...)`/a `components: [...]` config
 * (which excludes look-alikes like the `Direction` enum, an object of plain numbers, that's never queried).
 *
 * Pure + framework-only (BABLR via cstSpans); no vscode. Runs off-thread when wired to the worker. Cross-file: it takes
 * the whole game's `{ path → source }` so usage in one file confirms a behavior defined in another.
 */
import { cstSpans } from "@brianjenkins94/bablr";

/** A containment node built from the flat CST spans — type, the reference `field` it was emitted under, source text. */
export interface CstNode {
	"type": string | null;
	"field": string | null;
	"start": number;
	"end": number;
	"text": string;
	"children": CstNode[];
}

/** Build a containment tree from BABLR's flat close-order spans (drop trivia, anonymous punctuation, and cover wrappers). */
export function cstTree(src: string, production = "Program"): CstNode {
	const spans = cstSpans(src, production).spans.filter((span) => span.type !== null && !span.trivia && !span.cover);

	// close-order is children-before-parents; reverse so equal-span wrappers land OUTER-first, then stable-sort to preorder.
	spans.reverse();

	const nodes: CstNode[] = spans
		.map((span) => ({ "type": span.type, "field": span.field, "start": span.start, "end": span.end, "text": src.slice(span.start, span.end), "children": [] as CstNode[] }))
		.sort((a, b) => a.start - b.start || b.end - a.end);

	const root = nodes[0] ?? { "type": "Program", "field": null, "start": 0, "end": src.length, "text": src, "children": [] };
	const stack: CstNode[] = [root];

	for (let index = 1; index < nodes.length; index += 1) {
		const node = nodes[index];

		while (stack.length > 0 && !(stack[stack.length - 1].start <= node.start && stack[stack.length - 1].end >= node.end)) {
			stack.pop();
		}

		stack[stack.length - 1]?.children.push(node);
		stack.push(node);
	}

	return root;
}

function* walk(node: CstNode): Generator<CstNode> {
	yield node;

	for (const child of node.children) {
		yield* walk(child);
	}
}

/** First direct child emitted under `field`. */
function childField(node: CstNode, field: string): CstNode | undefined {
	return node.children.find((child) => child.field === field);
}

/** First descendant (or self) of `type`, in preorder. */
function firstType(node: CstNode, type: string): CstNode | undefined {
	for (const descendant of walk(node)) {
		if (descendant.type === type) {
			return descendant;
		}
	}

	return undefined;
}

/** All descendants (or self) of `type`. */
function allType(node: CstNode, type: string): CstNode[] {
	return [...walk(node)].filter((descendant) => descendant.type === type);
}

/** 1-based line of a source offset. */
function lineAt(src: string, offset: number): number {
	let line = 1;

	for (let index = 0; index < offset && index < src.length; index += 1) {
		if (src[index] === "\n") {
			line += 1;
		}
	}

	return line;
}

const TYPED_ARRAYS = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]);
const COMPONENT_CALLS = new Set(["query", "addComponent", "hasComponent", "removeComponent"]);
const LEADING_IDENT = /^\s*([A-Za-z_$][\w$]*)\s*\(/u;
const NEW_CALLEE = /new\s+([A-Za-z_$][\w$]*)/u;

/** A behavior = an exported ECS component, presented without the bitECS wiring. */
export interface Behavior {
	"name": string;
	/** DATA carries per-entity fields; TAG is a marker (empty component). */
	"kind": "data" | "tag";
	"fields": string[];
	/** Where it's defined — the deep-link target. */
	"defPath": string;
	"defLine": number;
}

/** Classify an exported const's initializer as a data component (object of TypedArrays), a tag (empty array), or neither. */
function classifyDeclarator(declarator: CstNode): { "kind": "data" | "tag"; "fields": string[] } | undefined {
	// The initializer is found by TYPE, not by the `value` field: that field rides on an Expression COVER node, which
	// cstTree drops, leaving the Object/Array sitting directly under the declarator. `Object`/`Array` only occur in the
	// value (the receiver is an Identifier, a type annotation uses ObjectType/ArrayType), so this is unambiguous.
	const object = firstType(declarator, "Object");
	const array = firstType(declarator, "Array");

	if (object === undefined && array === undefined) {
		return undefined; // no object/array initializer (e.g. a for-of binding, `new Set()`, a scalar)
	}

	if (object !== undefined && (array === undefined || object.start <= array.start)) {
		const fields: string[] = [];

		for (const property of allType(object, "Property")) {
			const created = firstType(property, "NewExpression");
			const callee = created?.text.match(NEW_CALLEE);

			if (callee !== null && callee !== undefined && TYPED_ARRAYS.has(callee[1])) {
				const key = firstType(property, "StringContent") ?? firstType(property, "Identifier");

				if (key !== undefined) {
					fields.push(key.text.trim());
				}
			}
		}

		// An object of TypedArrays is a data component; an object of plain values (the Direction enum) is not.
		return fields.length > 0 ? { "kind": "data", "fields": fields } : undefined;
	}

	if (array !== undefined) {
		// Empty array literal = a tag component; a populated array export is something else.
		return allType(array, "ArrayElement").length === 0 ? { "kind": "tag", "fields": [] } : undefined;
	}

	return undefined;
}

/**
 * Recognize the game's behaviors across all its files: every exported component (data or tag) that is actually USED as
 * one (queried, added, or listed in a `components:` config). Usage confirmation is what makes the projection strong —
 * it keeps enums/plain arrays out and resolves cross-file (a tag defined in schemas/, used in game.ts's load config).
 */
export function recognizeBehaviors(files: Record<string, string>): Behavior[] {
	const defs = new Map<string, { "kind": "data" | "tag"; "fields": string[]; "path": string; "line": number }>();
	const used = new Set<string>();

	for (const [path, src] of Object.entries(files)) {
		let root: CstNode;

		try {
			root = cstTree(src);
		} catch {
			continue; // unparsable file — skip, don't fail the whole projection
		}

		for (const declarator of allType(root, "VariableDeclarator")) {
			const name = childField(declarator, "receiver")?.text.trim();
			const classified = name === undefined ? undefined : classifyDeclarator(declarator);

			if (name !== undefined && classified !== undefined) {
				defs.set(name, { ...classified, "path": path, "line": lineAt(src, declarator.start) });
			}
		}

		// Usage 1 — component calls: query/addComponent/hasComponent/removeComponent (callee via leading identifier,
		// since BABLR labels the callee field inconsistently across call forms).
		for (const call of allType(root, "CallExpression")) {
			const callee = call.text.match(LEADING_IDENT);

			if (callee !== null && COMPONENT_CALLS.has(callee[1])) {
				for (const identifier of allType(call, "Identifier")) {
					used.add(identifier.text.trim());
				}
			}
		}

		// Usage 2 — a `components: [A, B]` entry in an object config (the load(...) entity spec).
		for (const property of allType(root, "Property")) {
			if (firstType(property, "StringContent")?.text.trim() === "components") {
				const array = firstType(property, "Array");

				if (array !== undefined) {
					for (const identifier of allType(array, "Identifier")) {
						used.add(identifier.text.trim());
					}
				}
			}
		}
	}

	const behaviors: Behavior[] = [];

	for (const [name, def] of defs) {
		if (used.has(name)) {
			behaviors.push({ "name": name, "kind": def.kind, "fields": def.fields, "defPath": def.path, "defLine": def.line });
		}
	}

	return behaviors.sort((a, b) => a.name.localeCompare(b.name));
}
