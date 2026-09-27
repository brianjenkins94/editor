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

/** Source location of a recognized node in its file: 1-based deep-link line + char offsets (for anchoring / reverse-map).
 *  `anchor` is the durable content-addressed id, attached later by anchorGame (game-anchors.ts). */
export interface NodeLoc {
	"defPath": string;
	"defLine": number;
	"start": number;
	"end": number;
	"anchor"?: string;
}

/** A behavior = an exported ECS component, presented without the bitECS wiring. */
export interface Behavior extends NodeLoc {
	"name": string;
	/** DATA carries per-entity fields; TAG is a marker (empty component). */
	"kind": "data" | "tag";
	"fields": string[];
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

/** The deep-link + range for a node (anchor is filled in later). */
function nodeLoc(ts: TsApi, source: TS.SourceFile, path: string, node: TS.Node): NodeLoc {
	return { "defPath": path, "defLine": lineOf(ts, source, node), "start": node.getStart(source), "end": node.getEnd() };
}

/**
 * Recognize the game's behaviors across all its files: every component (data or tag) that is actually USED as one
 * (queried, added, or listed in a `components:` config). Usage confirmation is what makes the projection strong — it
 * keeps enums/plain arrays out and resolves cross-file (a tag defined in schemas/, used only in game.ts's load config).
 */
export function recognizeBehaviors(files: Record<string, string>, ts: TsApi): Behavior[] {
	const defs = new Map<string, { "kind": "data" | "tag"; "fields": string[]; "loc": NodeLoc }>();
	const used = new Set<string>();

	eachNode(files, ts, (node, source, path) => {
		// Definition: a `const X = <object|array>` whose shape is component-like.
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const classified = classifyInitializer(ts, node.initializer);

			if (classified !== undefined) {
				defs.set(node.name.text, { "kind": classified.kind, "fields": classified.fields, "loc": nodeLoc(ts, source, path, node) });
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
			behaviors.push({ "name": name, "kind": def.kind, "fields": def.fields, ...def.loc });
		}
	}

	return behaviors.sort((a, b) => a.name.localeCompare(b.name));
}

/** An object = an entity type: a named thing with a list of attached behaviors, plus a few scalar attributes. */
export interface GameObject extends NodeLoc {
	"name": string;
	"behaviors": string[];
	/** Render order, when the spec sets it (`depth: N`). */
	"depth"?: number;
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

			const loc = nodeLoc(ts, source, path, entry);
			const dedupe = path + ":" + loc.defLine + ":" + name;

			if (seen.has(dedupe)) {
				continue;
			}

			seen.add(dedupe);
			objects.push({ "name": name, "behaviors": behaviors, ...(depth === undefined ? {} : { "depth": depth }), ...loc });
		}
	});

	return objects.sort((a, b) => a.defPath.localeCompare(b.defPath) || a.defLine - b.defLine);
}

/** One recognized event→action row: a condition (the "when") guarding one or more effects (the "do"). */
export interface RuleRow extends NodeLoc {
	"event": string;
	"actions": string[];
	/** Alias of defLine — the row's line (kept for the view's existing use). */
	"line": number;
}

/**
 * A rule = a system: a unit of behavior. Recognized by SHAPE — an exported function that runs an ECS `query(...)` (a
 * loader/registration naming convention isn't required) — not by name. `queries` are its subjects ("for each object with
 * these behaviors"); `rows` are the event→action pairs its body decomposes into. A rule with no rows didn't decompose
 * (custom code / runtime glue, still deep-linked); a rule with rows may still have an un-decomposed remainder.
 */
export interface Rule extends NodeLoc {
	"name": string;
	"queries": string[][];
	"rows": RuleRow[];
	/** Reusable composite behaviors this rule COMPOSES (calls) — the library units it draws on. */
	"composes": string[];
}

/** Single-line source text for a node (whitespace collapsed) — for display in the sheet. */
function cleanText(source: TS.SourceFile, node: TS.Node): string {
	return node.getText(source).replace(/\s+/gu, " ").trim();
}

/** The ACTIONS in an if's then-branch: its expression statements (assignments/calls). Control flow only (return /
 *  continue / break) and declarations are NOT actions, so guard branches produce no row. */
function actionTexts(ts: TsApi, source: TS.SourceFile, thenStatement: TS.Statement): string[] {
	const statements = ts.isBlock(thenStatement) ? thenStatement.statements : [thenStatement];
	const actions: string[] = [];

	for (const statement of statements) {
		if (ts.isExpressionStatement(statement)) {
			actions.push(cleanText(source, statement.expression));
		}
	}

	return actions;
}

/**
 * Recognize the game's rules across its files. A rule is an exported function whose body runs a `query(...)`; its
 * queried component sets are its subjects, and its `if (cond) { effects }` statements decompose into event→action rows
 * (branches whose body is only control flow — the guards in movement/win — yield no row, so those systems read as
 * not-yet-decomposed rather than as noise). Everything is deep-linked (the rule, and each row).
 */
export function recognizeRules(files: Record<string, string>, ts: TsApi, composites: Set<string> = new Set()): Rule[] {
	const rules: Rule[] = [];

	eachNode(files, ts, (node, source, path) => {
		if (!ts.isFunctionDeclaration(node) || node.name === undefined || node.body === undefined) {
			return;
		}

		const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;

		if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) {
			return; // only exported functions are rules (excludes local helpers like `entityAt`)
		}

		const queries: string[][] = [];
		const rows: RuleRow[] = [];
		const calls = new Set<string>();

		const scan = (inner: TS.Node): void => {
			if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
				// Subject: a query(world, [A, B]) — take the array-literal argument's identifiers.
				if (inner.expression.text === "query") {
					const array = inner.arguments.find((argument) => ts.isArrayLiteralExpression(argument));

					if (array !== undefined && ts.isArrayLiteralExpression(array)) {
						queries.push(array.elements.filter((element) => ts.isIdentifier(element)).map((element) => element.text));
					}
				} else {
					// Composition: a call to another function — resolved against the known composite set below.
					calls.add(inner.expression.text);
				}
			}

			// Row: an if whose then-branch performs actions (not just a guard return/continue).
			if (ts.isIfStatement(inner)) {
				const actions = actionTexts(ts, source, inner.thenStatement);

				if (actions.length > 0) {
					const loc = nodeLoc(ts, source, path, inner);

					rows.push({ "event": cleanText(source, inner.expression), "actions": actions, "line": loc.defLine, ...loc });
				}
			}

			ts.forEachChild(inner, scan);
		};

		scan(node.body);

		if (queries.length === 0) {
			return; // not a system — a rule must query
		}

		const composes = [...calls].filter((name) => composites.has(name)).sort();

		rules.push({ "name": node.name.text, "queries": queries, "rows": rows, "composes": composes, ...nodeLoc(ts, source, path, node) });
	});

	return rules.sort((a, b) => a.defPath.localeCompare(b.defPath) || a.defLine - b.defLine);
}

/** A composite = a reusable BEHAVIOR: a function composed of the primitive vocabulary (the built-in library's unit; the
 *  READ image of game-rules.ts's `Behavior`). It is NOT a `Behavior` here — that name is an ECS component (a data/tag
 *  trait attached to objects). In the product both are "behaviors"; the recognizer distinguishes the component-trait from
 *  the composed-function so the library round-trips. */
export interface Composite extends NodeLoc {
	"name": string;
	/** The components (traits) it reads or writes. */
	"uses": string[];
	/** Other composite behaviors it composes (calls). */
	"composes": string[];
}

/**
 * Recognize composed behaviors — the reusable functions the built-in library is made of, and that a kid writes. A
 * composite is recognized by SHAPE: an exported function that references at least one recognized component (so it is game
 * logic, not a plain utility) but does NOT itself drive a `query(...)` loop (that shape is a rule/system). Local helpers
 * (`entityAt`, `isWall`, `pressed`) are excluded because they aren't exported; rules are excluded because they query. So
 * `gridPush` — exported, touches Position/Pushable, delegates iteration to a helper — reads back as a composite.
 */
export function recognizeComposites(files: Record<string, string>, ts: TsApi, componentNames?: Set<string>): Composite[] {
	const components = componentNames ?? new Set(recognizeBehaviors(files, ts).map((behavior) => behavior.name));
	const candidates: { "name": string; "uses": string[]; "calls": Set<string>; "loc": NodeLoc }[] = [];

	eachNode(files, ts, (node, source, path) => {
		if (!ts.isFunctionDeclaration(node) || node.name === undefined || node.body === undefined) {
			return;
		}

		const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;

		if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) {
			return; // only exported functions can be library behaviors (excludes local helpers)
		}

		const firstParam = node.parameters[0]?.name;

		if (firstParam !== undefined && ts.isIdentifier(firstParam) && firstParam.text === "scene") {
			return; // a Phaser scene lifecycle hook (init/preload/create/update/load), not a reusable behavior
		}

		let callsQuery = false;
		const uses = new Set<string>();
		const calls = new Set<string>();

		const scan = (inner: TS.Node): void => {
			if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
				if (inner.expression.text === "query") {
					callsQuery = true;
				} else {
					calls.add(inner.expression.text);
				}
			}

			if (ts.isIdentifier(inner) && components.has(inner.text)) {
				uses.add(inner.text);
			}

			ts.forEachChild(inner, scan);
		};

		scan(node.body);

		if (callsQuery || uses.size === 0) {
			return; // a query-loop is a rule; touching no component is a plain utility — neither is a behavior
		}

		candidates.push({ "name": node.name.text, "uses": [...uses].sort(), "calls": calls, "loc": nodeLoc(ts, source, path, node) });
	});

	const names = new Set(candidates.map((candidate) => candidate.name));

	return candidates
		.map((candidate) => ({ "name": candidate.name, "uses": candidate.uses, "composes": [...candidate.calls].filter((name) => names.has(name) && name !== candidate.name).sort(), ...candidate.loc }))
		.sort((a, b) => a.defPath.localeCompare(b.defPath) || a.defLine - b.defLine);
}

/** The whole reverse-projection of a game: the nouns (objects + their behaviors) and the verbs (rules). Plain JSON, so
 *  it can cross a worker boundary — the recognizer runs where `ts` lives; only this model reaches the auxpane. */
export interface GameModel {
	"behaviors": Behavior[];
	/** The composed reusable behaviors — the built-in library, and the kid's own — that rules draw on. */
	"composites": Composite[];
	"objects": GameObject[];
	"rules": Rule[];
}

/** Run all recognizers over a game's `{ path → source }` with an injected `ts`. Composites are recognized first so rules
 *  can report which of them they compose (`rule.composes`), and so the library round-trips as first-class nodes. */
export function recognizeGame(files: Record<string, string>, ts: TsApi): GameModel {
	const behaviors = recognizeBehaviors(files, ts);
	const composites = recognizeComposites(files, ts, new Set(behaviors.map((behavior) => behavior.name)));
	const compositeNames = new Set(composites.map((composite) => composite.name));

	return { "behaviors": behaviors, "composites": composites, "objects": recognizeObjects(files, ts), "rules": recognizeRules(files, ts, compositeNames) };
}
