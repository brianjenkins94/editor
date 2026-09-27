/**
 * Reverse-projection recognizer — maps a game's source INTO the event-sheet toolbox (objects · behaviors · rules), so
 * the code stays the source of truth and the sheet is a strong, derived view of it (see the event-sheet vision).
 *
 * TWO tools, each for its strength:
 *  - RECOGNITION (structure: "is this a component / a query / an entity config?") uses the TYPESCRIPT AST — fast, robust
 *    on real-world TS, and type-aware if run inside tsserver. That's THIS module.
 *  - ANCHORING (durable identity: "which node is this, so its attachment survives edits/moves?") uses BABLR spanAnchors,
 *    mapped to a recognized node's source range by offset. That's added at the wiring step, not here.
 *
 * IMPORTANT — the `ts` is INJECTED, never imported: the editor already runs one TypeScript (the externalized tsserver
 * instance the capabilities plugin reuses). Importing `typescript` here would bundle a second ~16MB copy into the
 * workbench. So the host passes its ambient `ts` (the tsserver plugin's, or the LSP worker's); the node test passes
 * node's. `import type` below is erased at build time — no runtime dependency.
 *
 * "Strong" = maximize what folds into the toolbox, minimize opaque custom code. Grows one idiom-matcher at a time,
 * keyed to the house-style (bitECS + Phaser). FIRST matcher = component→BEHAVIOR: it hides bitECS and is the toolbox's
 * force multiplier. Pure + cross-file: it takes the whole game's `{ path → source }` so usage in one file confirms a
 * behavior defined in another.
 */
import type * as TS from "typescript";

/** The injected TypeScript API (the editor's own instance, or node's in tests). */
export type TsApi = typeof TS;

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

const TYPED_ARRAYS = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]);
const COMPONENT_CALLS = new Set(["query", "addComponent", "hasComponent", "removeComponent"]);

/** ScriptKind from a path's extension, so TSX/JSX parse correctly. */
function scriptKind(ts: TsApi, path: string): TS.ScriptKind {
	if (path.endsWith(".tsx")) {
		return ts.ScriptKind.TSX;
	}

	if (path.endsWith(".jsx")) {
		return ts.ScriptKind.JSX;
	}

	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
		return ts.ScriptKind.JS;
	}

	return ts.ScriptKind.TS;
}

/** A property key's text (identifier or string/number literal), or undefined for a computed key. */
function propName(ts: TsApi, name: TS.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}

	return undefined;
}

/** Classify a declaration's initializer as a data component (object of TypedArrays), a tag (empty array), or neither. */
function classifyInitializer(ts: TsApi, init: TS.Expression | undefined): { "kind": "data" | "tag"; "fields": string[] } | undefined {
	if (init === undefined) {
		return undefined;
	}

	if (ts.isObjectLiteralExpression(init)) {
		const fields: string[] = [];

		for (const property of init.properties) {
			if (ts.isPropertyAssignment(property) && ts.isNewExpression(property.initializer) && ts.isIdentifier(property.initializer.expression) && TYPED_ARRAYS.has(property.initializer.expression.text)) {
				const key = propName(ts, property.name);

				if (key !== undefined) {
					fields.push(key);
				}
			}
		}

		// An object of TypedArrays is a data component; an object of plain values (the Direction enum) is not.
		return fields.length > 0 ? { "kind": "data", "fields": fields } : undefined;
	}

	if (ts.isArrayLiteralExpression(init) && init.elements.length === 0) {
		return { "kind": "tag", "fields": [] }; // empty array literal = a tag component
	}

	return undefined;
}

/** Parse each file and visit every node with its source + path. Unparsable files are skipped (don't fail the whole run). */
function eachNode(files: Record<string, string>, ts: TsApi, visit: (node: TS.Node, source: TS.SourceFile, path: string) => void): void {
	for (const [path, src] of Object.entries(files)) {
		let source: TS.SourceFile;

		try {
			source = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
		} catch {
			continue;
		}

		const walk = (node: TS.Node): void => {
			visit(node, source, path);
			ts.forEachChild(node, walk);
		};

		walk(source);
	}
}

/** 1-based line of a node's start in its source. */
function lineOf(ts: TsApi, source: TS.SourceFile, node: TS.Node): number {
	return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * Recognize the game's behaviors across all its files: every component (data or tag) that is actually USED as one
 * (queried, added, or listed in a `components:` config). Usage confirmation is what makes the projection strong — it
 * keeps enums/plain arrays out and resolves cross-file (a tag defined in schemas/, used only in game.ts's load config).
 */
export function recognizeBehaviors(files: Record<string, string>, ts: TsApi): Behavior[] {
	const defs = new Map<string, { "kind": "data" | "tag"; "fields": string[]; "path": string; "line": number }>();
	const used = new Set<string>();

	eachNode(files, ts, (node, source, path) => {
		// Definition: a `const X = <object|array>` whose shape is component-like.
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const classified = classifyInitializer(ts, node.initializer);

			if (classified !== undefined) {
				defs.set(node.name.text, { ...classified, "path": path, "line": lineOf(ts, source, node) });
			}
		}

		// Usage 1 — component calls: query/addComponent/hasComponent/removeComponent (bare-identifier callee).
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && COMPONENT_CALLS.has(node.expression.text)) {
			for (const argument of node.arguments) {
				const collect = (inner: TS.Node): void => {
					if (ts.isIdentifier(inner)) {
						used.add(inner.text);
					}

					ts.forEachChild(inner, collect);
				};

				collect(argument);
			}
		}

		// Usage 2 — a `components: [A, B]` entry in an object config (the entity spec).
		if (ts.isPropertyAssignment(node) && propName(ts, node.name) === "components" && ts.isArrayLiteralExpression(node.initializer)) {
			for (const element of node.initializer.elements) {
				if (ts.isIdentifier(element)) {
					used.add(element.text);
				}
			}
		}
	});

	const behaviors: Behavior[] = [];

	for (const [name, def] of defs) {
		if (used.has(name)) {
			behaviors.push({ "name": name, "kind": def.kind, "fields": def.fields, "defPath": def.path, "defLine": def.line });
		}
	}

	return behaviors.sort((a, b) => a.name.localeCompare(b.name));
}

/** An object = an entity type: a named thing with a list of attached behaviors, plus a few scalar attributes. */
export interface GameObject {
	"name": string;
	"behaviors": string[];
	/** Render order, when the spec sets it (`depth: N`). */
	"depth"?: number;
	/** Where it's declared (the map entry) — the deep-link target. */
	"defPath": string;
	"defLine": number;
}

/**
 * Recognize entity types by the SHAPE of their spec, NOT by a `load(...)` callee — a loader can be named anything. The
 * signature is: an object literal that MAPS names to specs, where a spec is an object carrying a `components: [...]`
 * array (its behaviors). Each such map entry is an object; other scalar keys (e.g. `depth`) become attributes. Keying on
 * the `components` shape (not the call) also means a spec assigned to a variable, or passed to any function, still reads.
 */
export function recognizeObjects(files: Record<string, string>, ts: TsApi): GameObject[] {
	const objects: GameObject[] = [];
	const seen = new Set<string>();

	eachNode(files, ts, (node, source, path) => {
		if (!ts.isObjectLiteralExpression(node)) {
			return;
		}

		// This object is an ENTITY MAP if any of its entries is itself a spec (an object with a `components:` array).
		for (const entry of node.properties) {
			if (!ts.isPropertyAssignment(entry) || !ts.isObjectLiteralExpression(entry.initializer)) {
				continue;
			}

			const name = propName(ts, entry.name);
			let behaviors: string[] | undefined;
			let depth: number | undefined;

			for (const field of entry.initializer.properties) {
				if (!ts.isPropertyAssignment(field)) {
					continue;
				}

				const key = propName(ts, field.name);

				if (key === "components" && ts.isArrayLiteralExpression(field.initializer)) {
					behaviors = field.initializer.elements.filter((element) => ts.isIdentifier(element)).map((element) => element.text);
				} else if (key === "depth" && ts.isNumericLiteral(field.initializer)) {
					depth = Number(field.initializer.text);
				}
			}

			if (name === undefined || behaviors === undefined) {
				continue; // not an entity spec — no `components` array
			}

			const line = lineOf(ts, source, entry);
			const dedupe = path + ":" + line + ":" + name;

			if (seen.has(dedupe)) {
				continue;
			}

			seen.add(dedupe);
			objects.push({ "name": name, "behaviors": behaviors, ...(depth === undefined ? {} : { "depth": depth }), "defPath": path, "defLine": line });
		}
	});

	return objects.sort((a, b) => a.defPath.localeCompare(b.defPath) || a.defLine - b.defLine);
}
