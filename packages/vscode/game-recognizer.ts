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

/**
 * Recognize the game's behaviors across all its files: every component (data or tag) that is actually USED as one
 * (queried, added, or listed in a `components:` config). Usage confirmation is what makes the projection strong — it
 * keeps enums/plain arrays out and resolves cross-file (a tag defined in schemas/, used only in game.ts's load config).
 */
export function recognizeBehaviors(files: Record<string, string>, ts: TsApi): Behavior[] {
	const defs = new Map<string, { "kind": "data" | "tag"; "fields": string[]; "path": string; "line": number }>();
	const used = new Set<string>();

	for (const [path, src] of Object.entries(files)) {
		let source: TS.SourceFile;

		try {
			source = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
		} catch {
			continue; // unparsable file — skip, don't fail the whole projection
		}

		const visit = (node: TS.Node): void => {
			// Definition: a `const X = <object|array>` whose shape is component-like.
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
				const classified = classifyInitializer(ts, node.initializer);

				if (classified !== undefined) {
					defs.set(node.name.text, { ...classified, "path": path, "line": source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
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

			// Usage 2 — a `components: [A, B]` entry in an object config (the load(...) entity spec).
			if (ts.isPropertyAssignment(node) && propName(ts, node.name) === "components" && ts.isArrayLiteralExpression(node.initializer)) {
				for (const element of node.initializer.elements) {
					if (ts.isIdentifier(element)) {
						used.add(element.text);
					}
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(source);
	}

	const behaviors: Behavior[] = [];

	for (const [name, def] of defs) {
		if (used.has(name)) {
			behaviors.push({ "name": name, "kind": def.kind, "fields": def.fields, "defPath": def.path, "defLine": def.line });
		}
	}

	return behaviors.sort((a, b) => a.name.localeCompare(b.name));
}
