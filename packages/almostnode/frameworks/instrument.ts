/**
 * Instrumenting a workspace module for runtime evidence (packages/vscode/RUNTIME-EVIDENCE.md, the third slice): a
 * TypeScript `before` transformer for the dev server's compile. It sees the original source's syntax tree, so every
 * range it records is in the original file's lines and characters, and the source map the compile emits stays right.
 *
 * What it records is tsval's (its `observe` sites, packages/tsval/src/vm.ts), so evidence from a preview means what
 * evidence from a tsval run does:
 *  - each statement, as it starts (coverage);
 *  - `a?.b`, `a?.[k]`, `a?.()`: the value of `a` the chain tests;
 *  - `a ?? b`: the value of `a`;
 *  - `if`, `c ? x : y`, `a && b`, `a || b`: which arm ran;
 *  - a parameter without a default or a pattern: the value passed for it;
 *  - `return`, an arrow function's expression body: the value returned.
 * Each wrapper returns what it was given and reads each value once, so the program does what it did before; an optional
 * call on a member keeps its `this` (its object and callee go through temporaries the compile hoists). An optional call
 * whose callee is itself inside an optional chain isn't observed: splitting it would change when the chain stops.
 *
 * A later link of an optional chain (`a?.b?.c`'s `?.c`) names the link before it (`c(site, before, value)`), so the
 * runtime can leave it untold when that one stopped the chain, as tsval does.
 *
 * The module calls `__ev.<op>(site, …)`, where `__ev` is what the page runtime hands back for the module's file and
 * version (`globalThis.__evidence.module(file, version, sites)`); without a runtime, the prelude's stand-in does nothing.
 *
 * A recorded stop (packages/vscode/RUNNING.md: a breakpoint in a page): before the first statement starting on each of
 * `stops`' lines, `__ev.p(range, scope, self, where)` — its range written in (not a site: the page keeps a version's
 * table, and a breakpoint changes no source), what's in scope read by a closure (`() => ({ a, b })`: the parameters of
 * the functions around it, its imports, and what's declared before it in the blocks around it, so nothing is read
 * before it's set), `this` by another (`() => this`, called carefully: before `super()` it throws), and the functions it
 * sits in by name (`App › onClick`).
 *
 * And the function a stop is in, made replayable (RUNNING.md: stepping a recorded handler) — a function or an arrow, its
 * arguments recoverable (not a method, a generator, or an arrow with a pattern for a parameter): on entry
 * `__ev.e(range, free, self, args)` — what it reads from outside itself (`free`, by a closure: each name it uses and
 * doesn't declare, but JavaScript's own globals, each through `typeof` so an undeclared one can't throw), `this` and its
 * arguments — and `__ev.x(…)` as it leaves (a `finally`); each call in it `__ev.k(at, call)`, the call made as before and
 * its result recorded where it was made, so a replay can hand a call it can't make what it returned.
 */
import ts from "typescript";

/** What a site records: `statement` (coverage) or one of tsval's observe sites. */
export type SiteKind = "statement" | "optional" | "nullish" | "branch" | "parameter" | "return";

/** A site in the module: its kind and its node's range in the original source (0-based line and character). */
export interface Site { "kind": SiteKind; "start": [number, number]; "end": [number, number] }

/** How much to record: everything, or statements only. */
export type InstrumentLevel = "full" | "coverage";

/** The name the instrumented module calls the runtime by. */
const EV = "__ev";

/** The runtime's operations: s(statement), v(value), b(branch: if/?:), a(&&), o(||), c(a later link of an optional
 *  chain: its value, told only if the chain's link before it didn't stop it — tsval isn't told then either), and p(a
 *  recorded stop). */
type Op = "s" | "v" | "b" | "a" | "o" | "c";

/** At most this many names a recorded stop reads, innermost first. */
const MAX_SCOPE = 40;

/** JavaScript's own globals: a replay has its own (a replayable function's free names leave them out). */
const STANDARD = new Set(["undefined", "NaN", "Infinity", "globalThis", "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy", "Reflect", "Intl", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent", "ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "arguments"]);

/**
 * A transformer that instruments one module, and the module's sites once it has run. `prelude` is the line that goes in
 * front of the compiled module (shift its source map down one line): it fetches the module's counters from the page
 * runtime by `file` and `version`, or stands in for them.
 */
export function instrument(file: string, version: string, level: InstrumentLevel = "full", stops: ReadonlySet<number> = new Set()): { "before": ts.TransformerFactory<ts.SourceFile>; "sites": () => Site[]; "prelude": () => string } {
	const sites: Site[] = [];

	const before: ts.TransformerFactory<ts.SourceFile> = (context) => (sourceFile) => {
		const { factory } = context;
		// Each original node's parent (the compile may not have set them): what a stop reads of its scope walks up.
		const parents = new Map<ts.Node, ts.Node>();

		if (stops.size > 0) {
			(function link(node: ts.Node): void {
				node.forEachChild((child) => { parents.set(child, node); link(child); });
			})(sourceFile);
		}

		/** The functions stops are in that a replay can step (see the header): their original nodes. */
		const replayable = new Set<ts.Node>();

		if (stops.size > 0) {
			const firsts = new Set<number>();

			(function find(node: ts.Node): void {
				if (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement) {
					const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

					if (stops.has(line) && !firsts.has(line)) {
						firsts.add(line);

						let around = parents.get(node);

						while (around !== undefined && !ts.isFunctionLike(around)) {
							around = parents.get(around);
						}

						if (around !== undefined && replayableFunction(around)) {
							replayable.add(around);
						}
					}
				}

				node.forEachChild(find);
			})(sourceFile);
		}

		/** How deep the visit is in a replayable function: each call there records its result. */
		let replaying = 0;

		/** The lines (1-based) whose stop is placed: the first statement starting on each. */
		const placed = new Set<number>();
		/** A recorded stop before `statement`, if one of `stops` is its line and none is placed there yet. */
		const stopBefore = (statement: ts.Statement): ts.Statement[] => {
			const start = statement.getStart(sourceFile);
			const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;

			if (!stops.has(line) || placed.has(line)) {
				return [];
			}

			placed.add(line);

			const { names, where } = scopeOf(statement, start, parents);
			const range = factory.createArrayLiteralExpression([...position(start), ...position(statement.getEnd())].map((each) => factory.createNumericLiteral(each)));
			const scope = factory.createArrowFunction(undefined, undefined, [], undefined, factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), factory.createParenthesizedExpression(factory.createObjectLiteralExpression(names.map((name) => factory.createShorthandPropertyAssignment(name)))));
			const self = factory.createArrowFunction(undefined, undefined, [], undefined, factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), factory.createThis());

			return [factory.createExpressionStatement(factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(EV), "p"), undefined, [range, scope, self, factory.createStringLiteral(where)]))];
		};
		const position = (offset: number): [number, number] => {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);

			return [line, character];
		};
		const site = (kind: SiteKind, node: ts.Node): number => {
			sites.push({ "kind": kind, "start": position(node.getStart(sourceFile)), "end": position(node.getEnd()) });

			return sites.length - 1;
		};
		const call = (op: Op, index: number, ...args: ts.Expression[]): ts.Expression => factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(EV), op), undefined, [factory.createNumericLiteral(index), ...args]);
		const full = level === "full";
		/** Each optional link's site, by its original node: a later link names the one before it. */
		const links = new Map<ts.Node, number>();
		/** The nearest optional link inside `base`'s own chain, if any (its site). */
		const linkBefore = (base: ts.Expression): number | undefined => {
			for (let inner: ts.Expression = base; ; ) {
				if (links.has(inner)) {
					return links.get(inner);
				}

				if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) || ts.isCallExpression(inner) || ts.isNonNullExpression(inner)) {
					inner = inner.expression;
				} else {
					return undefined;
				}
			}
		};
		/** What an optional link's base goes through: `v`, or `c` naming the link before it in the chain. */
		const tested = (node: ts.Node, base: ts.Expression): ts.Expression => {
			const visited = ts.visitNode(base, visit) as ts.Expression;
			const index = site("optional", node);
			const before = linkBefore(base);

			links.set(node, index);

			return before === undefined ? call("v", index, visited) : call("c", index, factory.createNumericLiteral(before), visited);
		};

		/** A statement tsval counts: a real one (not a declaration), not ambient. */
		const counted = (node: ts.Node): node is ts.Statement => node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement && !(ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));

		/** `statements` with each counted one preceded by its counter (and, on a stop's line, its recorded stop). */
		const counting = (statements: ts.NodeArray<ts.Statement>): ts.Statement[] => statements.flatMap((statement) => {
			const counter = counted(statement) ? [...stopBefore(statement), factory.createExpressionStatement(call("s", site("statement", statement)))] : [];

			return [...counter, ts.visitNode(statement, visit) as ts.Statement];
		});

		/** A statement in a place that holds one (an `if`'s arm, a loop's body): counted inside a block of its own. */
		const embedded = (statement: ts.Statement | undefined): ts.Statement | undefined => {
			if (statement === undefined || ts.isBlock(statement) || !counted(statement)) {
				return statement === undefined ? undefined : ts.visitNode(statement, visit) as ts.Statement;
			}

			return factory.createBlock(counting(factory.createNodeArray([statement])), true);
		};

		/** A function's body, with its observed parameters' values first. */
		const withParameters = (node: ts.SignatureDeclaration, body: ts.ConciseBody): ts.ConciseBody => {
			const observed = full ? node.parameters.filter((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text !== "this" && parameter.initializer === undefined).map((parameter) => call("v", site("parameter", parameter), factory.createIdentifier((parameter.name as ts.Identifier).text))) : [];

			if (ts.isBlock(body)) {
				// A prologue ("use strict") stays first.
				const prologue = body.statements.filter((statement, index) => body.statements.slice(0, index + 1).every((each) => ts.isExpressionStatement(each) && ts.isStringLiteral(each.expression)));

				return factory.updateBlock(body, [...prologue.map((statement) => ts.visitNode(statement, visit) as ts.Statement), ...observed.map((expression) => factory.createExpressionStatement(expression)), ...counting(factory.createNodeArray(body.statements.slice(prologue.length)))]);
			}

			// An arrow's expression body: what it returns is observed on the arrow itself (tsval's `return` site).
			const value = ts.visitNode(body, visit) as ts.Expression;
			const returned = full && ts.isArrowFunction(node) ? call("v", site("return", node), value) : value;

			return observed.length === 0 ? (full && ts.isArrowFunction(node) ? factory.createParenthesizedExpression(returned) : returned) : factory.createParenthesizedExpression(factory.createCommaListExpression([...observed, returned]));
		};

		/** `callee` of an optional call, unwrapped of its parentheses (which keep a member's `this`). */
		const memberOf = (callee: ts.Expression): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined => {
			let inner = callee;

			while (ts.isParenthesizedExpression(inner)) {
				inner = inner.expression;
			}

			return ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) ? inner : undefined;
		};

		const visit = (node: ts.Node): ts.Node => {
			if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
				const statements = counting(node.statements);

				if (ts.isSourceFile(node)) {
					return factory.updateSourceFile(node, statements);
				}

				if (ts.isBlock(node)) {
					return factory.updateBlock(node, statements);
				}

				if (ts.isModuleBlock(node)) {
					return factory.updateModuleBlock(node, statements);
				}

				return ts.isCaseClause(node) ? factory.updateCaseClause(node, ts.visitNode(node.expression, visit) as ts.Expression, statements) : factory.updateDefaultClause(node, statements);
			}

			// In a replayable function: each call made as before, its result recorded where it was made — but a call in an
			// optional chain (wrapping it would change where the chain stops), `super(…)` and `import(…)`.
			if (replaying > 0 && (ts.isCallExpression(node) || ts.isNewExpression(node)) && !ts.isOptionalChain(node) && !(ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.SuperKeyword || node.expression.kind === ts.SyntaxKind.ImportKeyword)) && !ts.isOptionalChain(parents.get(node) ?? node)) {
				const at = factory.createArrayLiteralExpression(position(node.getStart(sourceFile)).map((each) => factory.createNumericLiteral(each)));

				return factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(EV), "k"), undefined, [at, ts.visitEachChild(node, visit, context) as ts.Expression]);
			}

			if (ts.isIfStatement(node)) {
				const condition = ts.visitNode(node.expression, visit) as ts.Expression;

				return factory.updateIfStatement(node, full ? call("b", site("branch", node), condition) : condition, embedded(node.thenStatement)!, embedded(node.elseStatement));
			}

			if (ts.isIterationStatement(node, false) || ts.isLabeledStatement(node) || ts.isWithStatement(node)) {
				// Their bodies are statements in a place that holds one.
				const body = node.statement;

				return ts.visitEachChild(node, (child) => (child === body ? embedded(body) : visit(child)), context);
			}

			if (!full) {
				return ts.isFunctionLike(node) && "body" in node && node.body !== undefined ? visitFunction(node) : ts.visitEachChild(node, visit, context);
			}

			if (ts.isConditionalExpression(node)) {
				return factory.updateConditionalExpression(node, call("b", site("branch", node), ts.visitNode(node.condition, visit) as ts.Expression), node.questionToken, ts.visitNode(node.whenTrue, visit) as ts.Expression, node.colonToken, ts.visitNode(node.whenFalse, visit) as ts.Expression);
			}

			if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
				const operator = node.operatorToken.kind;
				const left = ts.visitNode(node.left, visit) as ts.Expression;
				const observed = operator === ts.SyntaxKind.QuestionQuestionToken ? call("v", site("nullish", node), left) : call(operator === ts.SyntaxKind.AmpersandAmpersandToken ? "a" : "o", site("branch", node), left);

				return factory.updateBinaryExpression(node, observed, node.operatorToken, ts.visitNode(node.right, visit) as ts.Expression);
			}

			if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.questionDotToken !== undefined) {
				// The base goes through the runtime and comes back as itself, so `a?.m()` still calls `m` on `a`.
				const base = tested(node, node.expression);

				return ts.isPropertyAccessExpression(node)
					? factory.updatePropertyAccessChain(node as ts.PropertyAccessChain, base, node.questionDotToken, ts.visitNode(node.name, visit) as ts.MemberName)
					: factory.updateElementAccessChain(node as ts.ElementAccessChain, base, node.questionDotToken, ts.visitNode(node.argumentExpression, visit) as ts.Expression);
			}

			if (ts.isCallExpression(node) && node.questionDotToken !== undefined) {
				const args = node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression);
				const member = memberOf(node.expression);

				if (member === undefined) {
					return factory.updateCallChain(node as ts.CallChain, tested(node, node.expression), node.questionDotToken, node.typeArguments, args);
				}

				// `obj.m?.(…)`: its object and callee read once, through temporaries, and called with its `this` —
				// unless the member is itself in an optional chain (splitting it would change where the chain stops)
				// or on `super`.
				if (ts.isOptionalChain(member) || member.expression.kind === ts.SyntaxKind.SuperKeyword || containsOptionalChain(member.expression)) {
					return ts.visitEachChild(node, visit, context);
				}

				const index = site("optional", node);
				const object = factory.createTempVariable(context.hoistVariableDeclaration);
				const callee = factory.createTempVariable(context.hoistVariableDeclaration);
				const read = ts.isPropertyAccessExpression(member)
					? factory.createPropertyAccessExpression(object, member.name)
					: factory.createElementAccessExpression(object, ts.visitNode(member.argumentExpression, visit) as ts.Expression);
				const reads = factory.createParenthesizedExpression(factory.createCommaListExpression([
					factory.createAssignment(object, ts.visitNode(member.expression, visit) as ts.Expression),
					factory.createAssignment(callee, read),
					call("v", index, callee),
					callee
				]));

				return factory.createCallChain(factory.createPropertyAccessChain(reads, factory.createToken(ts.SyntaxKind.QuestionDotToken), "call"), undefined, undefined, [object, ...args]);
			}

			if (ts.isReturnStatement(node)) {
				return factory.updateReturnStatement(node, call("v", site("return", node), node.expression === undefined ? factory.createVoidZero() : ts.visitNode(node.expression, visit) as ts.Expression));
			}

			if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
				return visitFunction(node);
			}

			return ts.visitEachChild(node, visit, context);
		};

		/** Whether `node` holds an optional chain anywhere along its own chain. */
		const containsOptionalChain = (node: ts.Expression): boolean => {
			for (let inner: ts.Expression = node; ; ) {
				if (ts.isOptionalChain(inner)) {
					return true;
				}

				if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) || ts.isCallExpression(inner) || ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner)) {
					inner = inner.expression;
				} else {
					return false;
				}
			}
		};

		/** A function: its parameters' own children (defaults, decorators) visited, its body with its observed parameters. */
		const visitFunction = (node: ts.SignatureDeclaration & { "body"?: ts.ConciseBody }): ts.Node => {
			const replays = replayable.has(ts.getOriginalNode(node));

			replaying += replays ? 1 : 0;

			// Parameters are visited first, so their sites come before the body's (tsval tells them in that order).
			const visited = withParameters(node, node.body!);
			const updated = ts.visitEachChild(node, (child) => (child === node.body ? child : visit(child)), context) as ts.SignatureDeclaration & { "body"?: ts.ConciseBody };

			replaying -= replays ? 1 : 0;

			return replaceBody(factory, updated, replays ? recording(node, visited) : visited);
		};

		/** A replayable function's body, recording: `__ev.e(…)` on entry, its body in a `try`, `__ev.x(…)` as it leaves. */
		const recording = (node: ts.SignatureDeclaration, body: ts.ConciseBody): ts.Block => {
			const arrow = (expression: ts.Expression): ts.ArrowFunction => factory.createArrowFunction(undefined, undefined, [], undefined, factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expression);
			const free = freeNames(node, parents).map((name) => factory.createPropertyAssignment(name, factory.createConditionalExpression(factory.createStrictEquality(factory.createTypeOfExpression(factory.createIdentifier(name)), factory.createStringLiteral("undefined")), undefined, factory.createVoidZero(), undefined, factory.createIdentifier(name))));
			const args = ts.isArrowFunction(node) ? factory.createArrayLiteralExpression(node.parameters.map((parameter) => factory.createIdentifier((parameter.name as ts.Identifier).text))) : factory.createIdentifier("arguments");
			const range = factory.createArrayLiteralExpression([...position(node.getStart(sourceFile)), ...position(node.getEnd())].map((each) => factory.createNumericLiteral(each)));
			const entry = factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration("__evr", undefined, undefined, factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(EV), "e"), undefined, [range, arrow(factory.createParenthesizedExpression(factory.createObjectLiteralExpression(free))), arrow(factory.createThis()), args]))], ts.NodeFlags.Const));
			const statements = ts.isBlock(body) ? [...body.statements] : [factory.createReturnStatement(body)];
			const leave = factory.createBlock([factory.createExpressionStatement(factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(EV), "x"), undefined, [factory.createIdentifier("__evr")]))], true);

			return factory.createBlock([entry, factory.createTryStatement(factory.createBlock(statements, true), undefined, leave)], true);
		};

		return ts.visitNode(sourceFile, visit) as ts.SourceFile;
	};

	return {
		"before": before,
		"sites": () => sites,
		"prelude": () => `const ${EV} = globalThis.__evidence?.module(${JSON.stringify(file)}, ${JSON.stringify(version)}, ${JSON.stringify(sites.map((each) => [each.kind, ...each.start, ...each.end]))}) ?? { s() {}, v(_, x) { return x; }, b(_, x) { return x; }, a(_, x) { return x; }, o(_, x) { return x; }, c(_, __, x) { return x; }, p() {}, e() {}, k(_, x) { return x; }, x() {} };`
	};
}

/** Whether a replay can step `node`: a function or an arrow, its arguments recoverable — not a method, a constructor, an
 *  accessor or a generator, nor an arrow with a pattern for a parameter (its arguments aren't to hand). */
function replayableFunction(node: ts.Node): boolean {
	if (ts.isArrowFunction(node)) {
		return node.parameters.every((parameter) => ts.isIdentifier(parameter.name) && parameter.dotDotDotToken === undefined);
	}

	return (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.asteriskToken === undefined && node.body !== undefined;
}

/** What `fn` reads from outside itself: each name it uses as a value and doesn't declare (anywhere in it — a name it
 *  declares in an inner block is taken as its own), but JavaScript's own globals. */
function freeNames(fn: ts.SignatureDeclaration, parents: Map<ts.Node, ts.Node>): string[] {
	const declared = new Set<string>();
	const used = new Set<string>();

	(function walk(node: ts.Node): void {
		if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			return;
		}

		if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && !ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)) {
			declared.add((node.name as ts.Identifier).text);
		} else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name !== undefined) {
			declared.add(node.name.text);
		}

		if (ts.isIdentifier(node)) {
			const parent = parents.get(node);
			const name = parent !== undefined && (
				(ts.isPropertyAccessExpression(parent) && parent.name === node)
				|| (ts.isPropertyAssignment(parent) && parent.name === node)
				|| ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node)
				|| (ts.isBindingElement(parent) && parent.propertyName === node)
				|| ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)
				|| ((ts.isJsxAttribute(parent) || ts.isJsxNamespacedName(parent)) && parent.name === node)
				|| ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node && /^[a-z]/u.test(node.text))
			);

			if (!name) {
				used.add(node.text);
			}
		}

		node.forEachChild(walk);
	})(fn);

	return [...used].filter((name) => !declared.has(name) && !STANDARD.has(name)).slice(0, MAX_SCOPE);
}

/** A function passed to a call, named by the call: `addEventListener("click")`, `map`, `setTimeout`. */
function callbackName(call: ts.CallExpression): string {
	const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : "anonymous";
	const first = call.arguments[0];

	return first !== undefined && ts.isStringLiteral(first) ? `${callee}(${JSON.stringify(first.text)})` : callee;
}

/** The names a binding pattern binds. */
function boundNames(name: ts.BindingName): string[] {
	return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

/** What a recorded stop before `statement` (starting at `start`) reads of its scope, innermost first — the parameters of
 *  the functions around it, the loop and catch variables it's inside, its imports, functions declared in the blocks
 *  around it, and what's declared before it there (nothing read before it's set) — and the functions it's in, by name. */
function scopeOf(statement: ts.Statement, start: number, parents: Map<ts.Node, ts.Node>): { "names": string[]; "where": string } {
	const names: string[] = [];
	const functions: string[] = [];
	const add = (...each: string[]): void => {
		for (const name of each) {
			if (name !== "this" && !names.includes(name) && names.length < MAX_SCOPE) {
				names.push(name);
			}
		}
	};

	for (let node: ts.Node = statement, parent = parents.get(node); parent !== undefined; node = parent, parent = parents.get(node)) {
		if (ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
			for (const each of parent.statements) {
				const before = each.getEnd() <= start;

				if (ts.isVariableStatement(each) && before && !each.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
					add(...each.declarationList.declarations.flatMap((declaration) => boundNames(declaration.name)));
				} else if (ts.isFunctionDeclaration(each) && each.name !== undefined && each.body !== undefined) {
					add(each.name.text); // hoisted
				} else if (ts.isClassDeclaration(each) && each.name !== undefined && before) {
					add(each.name.text);
				} else if (ts.isImportDeclaration(each) && each.importClause !== undefined && !each.importClause.isTypeOnly) {
					const clause = each.importClause;

					add(...clause.name === undefined ? [] : [clause.name.text]);

					if (clause.namedBindings !== undefined) {
						add(...ts.isNamespaceImport(clause.namedBindings) ? [clause.namedBindings.name.text] : clause.namedBindings.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text));
					}
				}
			}
		} else if (ts.isFunctionLike(parent)) {
			add(...parent.parameters.flatMap((parameter) => boundNames(parameter.name)));

			const named = (parent as { "name"?: ts.Node }).name;
			const holder = parents.get(parent);

			functions.unshift(named !== undefined && (ts.isIdentifier(named) || ts.isPrivateIdentifier(named)) ? named.text : holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : holder !== undefined && ts.isPropertyAssignment(holder) && ts.isIdentifier(holder.name) ? holder.name.text : holder !== undefined && ts.isCallExpression(holder) ? callbackName(holder) : "anonymous");
		} else if ((ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer !== undefined && ts.isVariableDeclarationList(parent.initializer) && node !== parent.initializer) {
			add(...parent.initializer.declarations.flatMap((declaration) => boundNames(declaration.name)));
		} else if (ts.isCatchClause(parent) && parent.variableDeclaration !== undefined) {
			add(...boundNames(parent.variableDeclaration.name));
		}
	}

	return { "names": names, "where": functions.join(" › ") };
}

/** `node` with `body` as its body — made by the compile's own `factory` (the transformer never makes nodes with another,
 *  so it works with whichever copy of TypeScript compiles). */
function replaceBody(factory: ts.NodeFactory, node: ts.SignatureDeclaration & { "body"?: ts.ConciseBody }, body: ts.ConciseBody): ts.Node {

	if (ts.isFunctionDeclaration(node)) {
		return factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body as ts.Block);
	}

	if (ts.isFunctionExpression(node)) {
		return factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body as ts.Block);
	}

	if (ts.isArrowFunction(node)) {
		return factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, body);
	}

	if (ts.isMethodDeclaration(node)) {
		return factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, body as ts.Block);
	}

	if (ts.isConstructorDeclaration(node)) {
		return factory.updateConstructorDeclaration(node, node.modifiers, node.parameters, body as ts.Block);
	}

	if (ts.isGetAccessorDeclaration(node)) {
		return factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.type, body as ts.Block);
	}

	if (ts.isSetAccessorDeclaration(node)) {
		return factory.updateSetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, body as ts.Block);
	}

	return node;
}
