/**
 * The ceiling of compiling to closures (COMPILE.md) — a feasibility prototype, not a second engine.
 *
 * A minimal closure compiler over the same TypeScript AST tsval walks: each node compiled once into a JS closure —
 * an expression to `(env) => value`, a statement to `(env) => signal` — with every identifier resolved at compile time
 * to (depth, slot) in arrays of slots (`env[0]` the parent). Block scopes are flattened into their function's array
 * unless a closure inside them could capture a per-iteration binding. A guest function is a real JS function, so a host
 * that calls it back (map, filter, sort) calls compiled code directly. It covers what the harness's three programs use
 * and refuses anything else loudly.
 *
 * Kept honest where a real tier would have to pay: host calls go through a `callHost` that does invokeHost's checks
 * (an intrinsics lookup, the promise methods, the guard), host values read through `fromHost`, TDZ checked where a read
 * can't be proven after its declaration, `const` assignment refused, a class not callable without `new`. Modes:
 * - none: nothing else — the ceiling.
 * - `scopes`: the same closures over the frame machine's own `Scope` objects (map lookups) instead of slots.
 * - `counted`: what step-indexed features need to stay whole at statement grain — a step count, coverage (a counter per
 *   statement) and a breakpoint poll at every statement start.
 * - `traced`: plus VMOptions.trace's events, call numbers and loop turns included (`events` checks the counts match).
 *
 *   node --experimental-strip-types bench/compile-ceiling.ts          each engine × program in a process of its own
 *   node --experimental-strip-types bench/compile-ceiling.ts mixed    all in one process (shared, polymorphic feedback)
 *   node --experimental-strip-types bench/compile-ceiling.ts events   trace-event counts, frames vs closures
 */
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { createVM } from "../src/index.ts";
import { Scope } from "../src/scope.ts";

const K = ts.SyntaxKind;
const HOLE = Symbol("tdz");
const COMPILED = Symbol("compiled");
const NORMAL = 0, RETURN = 1, BREAK = 2, CONTINUE = 3;

type Env = any[];
type Expr = (env: Env) => any;
type Stmt = (env: Env) => number;

interface Binding { "slot": number; "kind": "var" | "let" | "const" | "param" | "function" | "this" | "class"; "decl": ts.Node | null }
interface CScope {
	"parent": CScope | undefined;
	/** this scope has a slot array of its own at run time. */
	"own": boolean;
	/** the scope whose array holds this one's slots (itself when `own`). */
	"holder": CScope;
	"names": Map<string, Binding>;
	"size": number;
	"fn": boolean;
	"arrow": boolean;
	/** what this scope's run-time holder declares (its own names and those of the blocks flattened into it). */
	"held": [string, Binding["kind"]][];
}

/** `traced`: told each value bound or returned, as VMOptions.trace is (its call's number and its loops' turns included). */
/** `scopes`: closures over the frame machine's own `Scope` objects (names looked up in maps, as its handlers do) instead
 *  of resolved slots — what compiling costs if both engines keep sharing today's scopes. */
export interface Mode { "counted": boolean; "traced"?: (event: any) => void; "scopes"?: boolean }

interface State { "steps": number; "coverage": Int32Array; "armed": boolean; "hits": number }

const INTRINSICS = new Map<unknown, (...args: any[]) => unknown>(); // invokeHost's lookup (empty: the cost of asking)

export function compileProgram(source: ts.SourceFile, globals: Record<string, any>, mode: Mode) {
	let ret: any; // a return's value, read by the caller the moment the body signals RETURN
	let completion: any;
	let statementIds = 0;
	const state: State = { "steps": 0, "coverage": new Int32Array(4096), "armed": false, "hits": 0 };
	const guard: { "sanitize"?: (v: any) => any } | undefined = undefined;
	const fromHost = (value: any) => (guard === undefined ? value : guard.sanitize!(value));
	const { prototype: promise } = Promise;
	// What a traced run keeps that the frame machine reads off its frames: the call it's in and the loops around it.
	const { traced } = mode;
	let calls = 0;
	let currentCall = 0;
	let loopBase = 0;
	const loopStack: { "node": ts.Node; "turn": number }[] = [];

	function emit(kind: string, node: ts.Node, name: string, value: any): void {
		const loops = [];

		for (let index = loopBase; index < loopStack.length; index++) {
			loops.push({ "node": loopStack[index]!.node, "turn": loopStack[index]!.turn });
		}

		traced!({ "kind": kind, "node": node, "name": name, "value": value, "step": state.steps, "call": currentCall, "loops": loops });
	}

	/** A write, told to the tracer when there is one. */
	function told(write: (env: Env, value: any) => any, node: ts.Node, name: string): (env: Env, value: any) => any {
		if (traced === undefined) {
			return write;
		}

		return (env, value) => {
			write(env, value);
			emit("bind", node, name, value);

			return value;
		};
	}

	function callHost(fn: any, thisArg: any, args: any[]): any {
		if (typeof fn !== "function") {
			throw new TypeError("not a function");
		}

		const intrinsic = INTRINSICS.get(fn);

		if (intrinsic !== undefined) {
			return intrinsic(thisArg, args);
		}

		if (fn === promise.then || fn === promise.catch || fn === promise.finally) {
			throw new Error("unsupported in the prototype");
		}

		return fromHost(Reflect.apply(fn, thisArg, args));
	}

	function newScope(parent: CScope | undefined, own: boolean, fn = false, arrow = false): CScope {
		const scope = { "parent": parent, "own": own, "names": new Map(), "size": 1, "fn": fn, "arrow": arrow, "held": [] } as unknown as CScope;

		scope.holder = own ? scope : parent!.holder;

		return scope;
	}

	function declare(scope: CScope, name: string, kind: Binding["kind"], decl: ts.Node | null): Binding {
		const existing = scope.names.get(name);

		if (existing !== undefined) {
			return existing;
		}

		const binding = { "slot": scope.holder.size, "kind": kind, "decl": decl };

		scope.holder.size += 1;

		scope.holder.held.push([name, kind]);

		scope.names.set(name, binding);

		return binding;
	}

	function resolve(scope: CScope, name: string): { "depth": number; "binding": Binding; "scope": CScope } | undefined {
		let depth = 0;

		for (let at: CScope | undefined = scope; at !== undefined; at = at.parent) {
			const binding = at.names.get(name);

			if (binding !== undefined) {
				return { "depth": depth, "binding": binding, "scope": at };
			}

			if (at.own && at.parent !== undefined && at.parent.holder !== at) {
				depth += 1;
			}
		}

		return undefined;
	}

	function containsClosure(node: ts.Node): boolean {
		let found = false;
		const visit = (child: ts.Node): void => {
			if (found) {
				return;
			}

			if (ts.isFunctionLike(child) || ts.isClassLike(child)) {
				found = true;

				return;
			}

			child.forEachChild(visit);
		};

		node.forEachChild(visit);

		return found;
	}

	/** Whether a read needs a TDZ check: anything but a read after its declaration in the same function. */
	function needsTdz(scope: CScope, found: { "binding": Binding; "scope": CScope }, at: ts.Node): boolean {
		const { binding } = found;

		if (binding.kind !== "let" && binding.kind !== "const" && binding.kind !== "class") {
			return false;
		}

		if (binding.decl === null || at.pos < binding.decl.end) {
			return true;
		}

		for (let s: CScope | undefined = scope; s !== undefined && s !== found.scope; s = s.parent) {
			if (s.fn) {
				return true; // read from a closure: it may run before the declaration did
			}
		}

		return false;
	}

	// --- reads and writes of a resolved name --------------------------------------------------------------

	/** A run-time Scope for a compile-time one (mode.scopes): every name its holder declares, in the TDZ as tsval has it. */
	function makeScope(cscope: CScope, parent: Scope | undefined): Scope {
		const made = new Scope(parent, cscope.fn);

		for (const [name, kind] of cscope.held) {
			const initialized = kind === "var" || kind === "param" || kind === "this";

			made.bindings.set(name, { "value": undefined, "kind": kind === "this" ? "param" : kind === "class" ? "let" : kind, "initialized": initialized });
		}

		return made;
	}

	function reader(scope: CScope, name: string, at: ts.Node): Expr {
		if (mode.scopes) {
			return (env: any) => fromHost(env.get(name));
		}

		const found = resolve(scope, name);

		if (found === undefined) {
			return () => {
				if (!(name in globals)) {
					throw new ReferenceError(`${name} is not defined`);
				}

				return fromHost(globals[name]);
			};
		}

		const { depth, binding: { slot } } = found;
		const tdz = needsTdz(scope, found, at);

		if (!tdz) {
			if (depth === 0) {
				return (env) => env[slot];
			}

			if (depth === 1) {
				return (env) => env[0][slot];
			}

			if (depth === 2) {
				return (env) => env[0][0][slot];
			}

			return (env) => {
				for (let d = depth; d > 0; d--) {
					env = env[0];
				}

				return env[slot];
			};
		}

		return (env) => {
			for (let d = depth; d > 0; d--) {
				env = env[0];
			}

			const value = env[slot];

			if (value === HOLE) {
				throw new ReferenceError(`Cannot access '${name}' before initialization`);
			}

			return value;
		};
	}

	/** (env, value) → value: an assignment to a name. */
	function writer(scope: CScope, name: string, at: ts.Node, init = false): (env: Env, value: any) => any {
		const found = resolve(scope, name);

		if (mode.scopes) {
			if (!init) {
				return (env: any, value) => { env.set(name, value); return value; };
			}

			const depth = found!.depth;

			return (env: any, value) => {
				let at = env;

				for (let d = depth; d > 0; d--) at = at.parent;
				at.initialize(name, value);

				return value;
			};
		}

		if (found === undefined) {
			return (_env, value) => {
				if (!(name in globals)) {
					throw new ReferenceError(`${name} is not defined`);
				}

				globals[name] = value;

				return value;
			};
		}

		const { depth, binding: { slot, kind } } = found;

		if (!init && kind === "const") {
			return () => {
				throw new TypeError("Assignment to constant variable.");
			};
		}

		const tdz = !init && needsTdz(scope, found, at);

		if (!tdz && depth === 0) {
			return (env, value) => (env[slot] = value);
		}

		if (!tdz && depth === 1) {
			return (env, value) => (env[0][slot] = value);
		}

		return (env, value) => {
			for (let d = depth; d > 0; d--) {
				env = env[0];
			}

			if (tdz && env[slot] === HOLE) {
				throw new ReferenceError(`Cannot access '${name}' before initialization`);
			}

			return (env[slot] = value);
		};
	}

	// --- expressions ---------------------------------------------------------------------------------------

	function binary(op: ts.SyntaxKind, l: Expr, r: Expr, rightLiteral: ts.Node): Expr {
		// A numeric literal on the right is the common case of a loop's test and step: one closure call fewer.
		if (rightLiteral.kind === K.NumericLiteral) {
			const c = Number((rightLiteral as ts.NumericLiteral).text);

			switch (op) {
				case K.PlusToken: return (env) => l(env) + c;
				case K.MinusToken: return (env) => l(env) - c;
				case K.LessThanToken: return (env) => l(env) < c;
				case K.GreaterThanToken: return (env) => l(env) > c;
				case K.LessThanEqualsToken: return (env) => l(env) <= c;
				case K.EqualsEqualsEqualsToken: return (env) => l(env) === c;
				case K.PercentToken: return (env) => l(env) % c;
				case K.AsteriskToken: return (env) => l(env) * c;
				case K.SlashToken: return (env) => l(env) / c;
				default: break;
			}
		}

		switch (op) {
			case K.PlusToken: return (env) => l(env) + r(env);
			case K.MinusToken: return (env) => l(env) - r(env);
			case K.AsteriskToken: return (env) => l(env) * r(env);
			case K.SlashToken: return (env) => l(env) / r(env);
			case K.PercentToken: return (env) => l(env) % r(env);
			case K.LessThanToken: return (env) => l(env) < r(env);
			case K.GreaterThanToken: return (env) => l(env) > r(env);
			case K.LessThanEqualsToken: return (env) => l(env) <= r(env);
			case K.GreaterThanEqualsToken: return (env) => l(env) >= r(env);
			case K.EqualsEqualsEqualsToken: return (env) => l(env) === r(env);
			case K.ExclamationEqualsEqualsToken: return (env) => l(env) !== r(env);
			case K.BarBarToken: return (env) => l(env) || r(env);
			case K.AmpersandAmpersandToken: return (env) => l(env) && r(env);
			default: throw new Error(`prototype: operator ${ts.SyntaxKind[op]}`);
		}
	}

	function compound(op: ts.SyntaxKind): (a: any, b: any) => any {
		switch (op) {
			case K.PlusEqualsToken: return (a, b) => a + b;
			case K.MinusEqualsToken: return (a, b) => a - b;
			case K.AsteriskEqualsToken: return (a, b) => a * b;
			default: throw new Error(`prototype: compound ${ts.SyntaxKind[op]}`);
		}
	}

	function args(scope: CScope, nodes: readonly ts.Expression[]): (env: Env) => any[] {
		const list = nodes.map((node) => expr(scope, node));

		switch (list.length) {
			case 0: return () => [];
			case 1: { const [a] = list; return (env) => [a(env)]; }
			case 2: { const [a, b] = list; return (env) => [a(env), b(env)]; }
			default: return (env) => list.map((each) => each(env));
		}
	}

	/** A call: a compiled guest function directly, anything else through callHost. */
	function call(scope: CScope, node: ts.CallExpression): Expr {
		const callee = node.expression;
		const argv = node.arguments;

		if (ts.isPropertyAccessExpression(callee)) {
			const object = expr(scope, callee.expression);
			const key = callee.name.text;
			const list = args(scope, argv);

			return (env) => {
				const receiver = object(env);
				const fn = receiver[key];

				return fn !== undefined && fn[COMPILED] === true ? fn.apply(receiver, list(env)) : callHost(fn, receiver, list(env));
			};
		}

		const target = expr(scope, callee);

		// Specialized arities: what a compiled guest→guest call costs when nothing is in the way.
		if (argv.length === 1) {
			const a = expr(scope, argv[0]);

			return (env) => {
				const fn = target(env);

				return fn !== undefined && fn[COMPILED] === true ? fn(a(env)) : callHost(fn, undefined, [a(env)]);
			};
		}

		const list = args(scope, argv);

		return (env) => {
			const fn = target(env);

			return fn !== undefined && fn[COMPILED] === true ? fn(...list(env)) : callHost(fn, undefined, list(env));
		};
	}

	function objectLiteral(scope: CScope, node: ts.ObjectLiteralExpression): Expr {
		const parts = node.properties.map((property): (env: Env, target: any) => void => {
			if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text !== "__proto__") {
				const key = property.name.text;
				const value = expr(scope, property.initializer);

				return (env, target) => { target[key] = value(env); };
			}

			if (ts.isShorthandPropertyAssignment(property)) {
				const key = property.name.text;
				const value = reader(scope, key, property);

				return (env, target) => { target[key] = value(env); };
			}

			if (ts.isSpreadAssignment(property)) {
				const value = expr(scope, property.expression);

				return (env, target) => { Object.assign(target, value(env)); };
			}

			throw new Error(`prototype: object literal member ${ts.SyntaxKind[property.kind]}`);
		});

		return (env) => {
			const target = {};

			for (const part of parts) {
				part(env, target);
			}

			return target;
		};
	}

	function expr(scope: CScope, node: ts.Expression): Expr {
		switch (node.kind) {
			case K.NumericLiteral: { const value = Number((node as ts.NumericLiteral).text); return () => value; }
			case K.StringLiteral: { const { text } = node as ts.StringLiteral; return () => text; }
			case K.TrueKeyword: return () => true;
			case K.FalseKeyword: return () => false;
			case K.ParenthesizedExpression: return expr(scope, (node as ts.ParenthesizedExpression).expression);
			case K.Identifier: return reader(scope, (node as ts.Identifier).text, node);
			case K.ThisKeyword: return reader(scope, "this", node);
			case K.BinaryExpression: {
				const { left, operatorToken: { kind: op }, right } = node as ts.BinaryExpression;

				if (op === K.EqualsToken) {
					if (ts.isIdentifier(left)) {
						const write = told(writer(scope, left.text, node), node, left.text);
						const value = expr(scope, right);

						return (env) => write(env, value(env));
					}

					if (ts.isPropertyAccessExpression(left)) {
						const object = expr(scope, left.expression);
						const key = left.name.text;
						const value = expr(scope, right);

						if (traced !== undefined) {
							const written = left.getText();

							return (env) => {
								const target = object(env); // (the object before the value, as an assignment evaluates them)
								const result = value(env);

								target[key] = result;

								emit("bind", node, written, result);

								return result;
							};
						}

						return (env) => (object(env)[key] = value(env));
					}

					throw new Error("prototype: assignment target");
				}

				if (op >= K.FirstCompoundAssignment && op <= K.LastCompoundAssignment) {
					if (!ts.isIdentifier(left)) {
						throw new Error("prototype: compound target");
					}

					const read = reader(scope, left.text, node);
					const write = told(writer(scope, left.text, node), node, left.text);
					const apply = compound(op);
					const value = expr(scope, right);

					if (op === K.PlusEqualsToken) {
						return (env) => write(env, read(env) + value(env));
					}

					return (env) => write(env, apply(read(env), value(env)));
				}

				return binary(op, expr(scope, left), expr(scope, right), right);
			}

			case K.PostfixUnaryExpression:
			case K.PrefixUnaryExpression: {
				const { operand, operator } = node as ts.PrefixUnaryExpression;

				if (operator === K.MinusToken) {
					const value = expr(scope, operand);

					return (env) => -value(env);
				}

				if (operator === K.ExclamationToken) {
					const value = expr(scope, operand);

					return (env) => !value(env);
				}

				if (!ts.isIdentifier(operand)) {
					throw new Error("prototype: update target");
				}

				const read = reader(scope, operand.text, node);
				const write = told(writer(scope, operand.text, node), node, operand.text);
				const delta = operator === K.PlusPlusToken ? 1 : -1;
				const postfix = node.kind === K.PostfixUnaryExpression;

				return (env) => {
					const old = +read(env); // ToNumeric (bigints aside, in the prototype)

					write(env, old + delta);

					return postfix ? old : old + delta;
				};
			}

			case K.PropertyAccessExpression: {
				const { expression, name } = node as ts.PropertyAccessExpression;
				const object = expr(scope, expression);
				const key = name.text;

				return (env) => fromHost(object(env)[key]);
			}

			case K.CallExpression: return call(scope, node as ts.CallExpression);
			case K.NewExpression: {
				const { expression, arguments: argv = [] } = node as ts.NewExpression;
				const target = expr(scope, expression);
				const list = args(scope, argv);

				return (env) => {
					const ctor = target(env);

					return ctor !== undefined && ctor[COMPILED] === true ? Reflect.construct(ctor, list(env)) : fromHost(Reflect.construct(ctor, list(env)));
				};
			}

			case K.ObjectLiteralExpression: return objectLiteral(scope, node as ts.ObjectLiteralExpression);
			case K.ArrayLiteralExpression: {
				const list = args(scope, (node as ts.ArrayLiteralExpression).elements);

				return list;
			}

			case K.ArrowFunction: return func(scope, node as ts.ArrowFunction);
			default: throw new Error(`prototype: expression ${ts.SyntaxKind[node.kind]}`);
		}
	}

	// --- functions and classes -----------------------------------------------------------------------------

	/** A guest function: a real JS function whose body is compiled, made each time its expression runs. */
	function func(scope: CScope, node: ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration, asConstructor = false): Expr {
		const arrow = node.kind === K.ArrowFunction;
		const inner = newScope(scope, true, true, arrow);

		if (!arrow) {
			declare(inner, "this", "this", null);
		}

		const params = node.parameters.map((param) => {
			if (!ts.isIdentifier(param.name) || param.initializer !== undefined || param.dotDotDotToken !== undefined) {
				throw new Error("prototype: parameter form");
			}

			return declare(inner, param.name.text, "param", param).slot;
		});
		let body: Stmt;
		let expressionBody: Expr | undefined;

		if (ts.isBlock(node.body!)) {
			body = block(inner, node.body.statements, true);
		} else {
			expressionBody = expr(inner, node.body as ts.Expression);
		}

		const size = () => inner.size;
		const thisSlot = arrow ? 0 : inner.names.get("this")!.slot;
		const [p0, p1] = params;

		const names = node.parameters.map((param) => (param.name as ts.Identifier).text);

		return (closure) => {
			const n = size();
			const enter = mode.scopes ? (self: any, a: any, b: any, rest: IArguments | undefined): any => {
				const made = makeScope(inner, closure);

				if (thisSlot !== 0) made.initialize("this", self);
				if (p0 !== undefined) made.initialize(names[0]!, a);
				if (p1 !== undefined) made.initialize(names[1]!, b);
				if (rest !== undefined) {
					for (let index = 2; index < params.length; index++) made.initialize(names[index]!, rest[index]);
				}

				return made;
			} : (self: any, a: any, b: any, rest: IArguments | undefined): Env => {
				const env: Env = new Array(n).fill(HOLE);

				env[0] = closure;
				if (thisSlot !== 0) {
					env[thisSlot] = self;
				}

				if (p0 !== undefined) env[p0] = a;
				if (p1 !== undefined) env[p1] = b;
				if (rest !== undefined) {
					for (let index = 2; index < params.length; index++) env[params[index]] = rest[index];
				}

				return env;
			};
			const plain = (env: Env): any => {
				if (expressionBody !== undefined) {
					return expressionBody(env);
				}

				return body(env) === RETURN ? ret : undefined;
			};
			const run = traced === undefined ? plain : (env: Env): any => {
				const call = currentCall;
				const base = loopBase;

				calls += 1;
				currentCall = calls;
				loopBase = loopStack.length;
				try {
					for (let index = 0; index < params.length; index++) emit("bind", node.parameters[index]!, (node.parameters[index]!.name as ts.Identifier).text, env[params[index]!]);

					return plain(env);
				} finally {
					loopStack.length = loopBase;
					currentCall = call;
					loopBase = base;
				}
			};
			let fn: any;

			if (arrow) {
				// eslint-disable-next-line prefer-rest-params -- `arguments`, not a rest parameter: no array made per call
				fn = params.length <= 2 ? (a: any, b: any) => run(enter(undefined, a, b, undefined)) : function (this: any, a: any, b: any) { return run(enter(undefined, a, b, arguments)); };
			} else if (asConstructor) {
				fn = function (this: any, a: any, b: any) {
					if (new.target === undefined) {
						throw new TypeError("Class constructor cannot be invoked without 'new'");
					}

					// eslint-disable-next-line prefer-rest-params -- (as above)
					run(enter(this, a, b, params.length > 2 ? arguments : undefined));
				};
			} else {
				// eslint-disable-next-line prefer-rest-params -- (as above)
				fn = function (this: any, a: any, b: any) { return run(enter(this, a, b, params.length > 2 ? arguments : undefined)); };
			}

			fn[COMPILED] = true;

			return fn;
		};
	}

	function classDeclaration(scope: CScope, node: ts.ClassDeclaration): Stmt {
		const write = writer(scope, node.name!.text, node, true);
		const ctorNode = node.members.find(ts.isConstructorDeclaration);
		const make = ctorNode !== undefined ? func(scope, ctorNode, true) : func(scope, ts.factory.createConstructorDeclaration(undefined, [], ts.factory.createBlock([])), true);
		const methods = node.members.filter(ts.isMethodDeclaration).map((method) => ({ "key": (method.name as ts.Identifier).text, "make": func(scope, method) }));

		return (env) => {
			const ctor = make(env);

			for (const { key, make: method } of methods) {
				Object.defineProperty(ctor.prototype, key, { "value": method(env), "writable": true, "configurable": true, "enumerable": false });
			}

			write(env, ctor);

			return NORMAL;
		};
	}

	// --- statements ------------------------------------------------------------------------------------------

	/** Each statement, counted when the mode asks: a step, its coverage, a breakpoint poll. */
	function counted(inner: Stmt): Stmt {
		if (!mode.counted) {
			return inner;
		}

		const id = statementIds;

		statementIds += 1;
		const { coverage } = state;

		return (env) => {
			state.steps += 1;
			coverage[id] += 1;
			if (state.armed) {
				state.hits += 1; // (a breakpoint set in compiled code: the deopt path, never taken here)
			}

			return inner(env);
		};
	}

	/** Hoist a statement list's declarations into `scope`: `var`s to the function, the rest here. */
	function hoistInto(scope: CScope, statements: readonly ts.Statement[]): ((env: Env) => void)[] {
		const inits: ((env: Env) => void)[] = [];

		for (const statement of statements) {
			if (ts.isVariableStatement(statement)) {
				const flags = statement.declarationList.flags;
				const kind = (flags & ts.NodeFlags.Const) !== 0 ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";

				for (const decl of statement.declarationList.declarations) {
					if (!ts.isIdentifier(decl.name)) {
						throw new Error("prototype: declaration pattern");
					}

					let target = scope;

					if (kind === "var") {
						while (!target.fn && target.parent !== undefined) {
							target = target.parent;
						}
					}

					declare(target, decl.name.text, kind, decl);
				}
			} else if (ts.isFunctionDeclaration(statement)) {
				declare(scope, statement.name!.text, "function", statement);
			} else if (ts.isClassDeclaration(statement)) {
				declare(scope, statement.name!.text, "class", statement);
			}
		}

		for (const statement of statements) {
			if (ts.isFunctionDeclaration(statement)) {
				const write = writer(scope, statement.name!.text, statement, true);
				const make = func(scope, statement);

				inits.push((env) => { write(env, make(env)); });
			}
		}

		return inits;
	}

	function block(scope: CScope, statements: readonly ts.Statement[], functionBody = false, topLevel = false): Stmt {
		// A block of its own only when a closure inside it may capture its bindings; otherwise flattened into the function's.
		const own = !functionBody && !topLevel && containsClosure(ts.factory.createBlock(statements as ts.Statement[])) && statements.some((s) => ts.isVariableStatement(s) || ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s));
		const inner = functionBody || topLevel ? scope : newScope(scope, own);
		const inits = hoistInto(inner, statements);
		const list = statements.filter((s) => !ts.isFunctionDeclaration(s)).map((s) => stmt(inner, s, topLevel));
		const n = list.length;
		const run = (env: Env): number => {
			for (const init of inits) init(env);
			for (let index = 0; index < n; index++) {
				const signal = list[index](env);

				if (signal !== NORMAL) {
					return signal;
				}
			}

			return NORMAL;
		};

		if (own) {
			return (env) => {
				if (mode.scopes) {
					return run(makeScope(inner, env as any) as any);
				}

				const blockEnv: Env = new Array(inner.size).fill(HOLE);

				blockEnv[0] = env;

				return run(blockEnv);
			};
		}

		return run;
	}

	function declarationList(scope: CScope, list: ts.VariableDeclarationList): Stmt {
		const parts = list.declarations.map((decl) => {
			const write = told(writer(scope, (decl.name as ts.Identifier).text, decl, true), decl, (decl.name as ts.Identifier).text);
			const value = decl.initializer === undefined ? () => undefined : expr(scope, decl.initializer);

			return (env: Env) => { write(env, value(env)); };
		});

		if (parts.length === 1) {
			const [only] = parts;

			return (env) => { only(env); return NORMAL; };
		}

		return (env) => { for (const part of parts) part(env); return NORMAL; };
	}

	function stmt(scope: CScope, node: ts.Statement, topLevel = false): Stmt {
		return counted(statement(scope, node, topLevel));
	}

	function statement(scope: CScope, node: ts.Statement, topLevel: boolean): Stmt {
		switch (node.kind) {
			case K.VariableStatement: return declarationList(scope, (node as ts.VariableStatement).declarationList);
			case K.ExpressionStatement: {
				const value = expr(scope, (node as ts.ExpressionStatement).expression);

				if (topLevel) {
					return (env) => { completion = value(env); return NORMAL; };
				}

				return (env) => { value(env); return NORMAL; };
			}

			case K.ReturnStatement: {
				const { expression } = node as ts.ReturnStatement;
				const value = expression === undefined ? () => undefined : expr(scope, expression);

				if (traced !== undefined) {
					return (env) => { ret = value(env); emit("return", node, "return", ret); return RETURN; };
				}

				return (env) => { ret = value(env); return RETURN; };
			}

			case K.IfStatement: {
				const { expression, thenStatement, elseStatement } = node as ts.IfStatement;
				const test = expr(scope, expression);
				const then = stmt(scope, thenStatement);
				const otherwise = elseStatement === undefined ? undefined : stmt(scope, elseStatement);

				if (traced !== undefined) {
					return (env) => {
						const arm = test(env) ? 0 : 1;

						emit("branch", node, "if", arm);

						return arm === 0 ? then(env) : otherwise === undefined ? NORMAL : otherwise(env);
					};
				}

				if (otherwise === undefined) {
					return (env) => (test(env) ? then(env) : NORMAL);
				}

				return (env) => (test(env) ? then(env) : otherwise(env));
			}

			case K.Block: return block(scope, (node as ts.Block).statements);
			case K.ClassDeclaration: return classDeclaration(scope, node as ts.ClassDeclaration);
			case K.ForStatement: return forStatement(scope, node as ts.ForStatement);
			case K.ForOfStatement: return forOfStatement(scope, node as ts.ForOfStatement);
			default: throw new Error(`prototype: statement ${ts.SyntaxKind[node.kind]}`);
		}
	}

	function forStatement(scope: CScope, node: ts.ForStatement): Stmt {
		const { initializer, condition, incrementor, statement: body } = node;
		// Per-iteration bindings are only observable through a closure: without one, the loop's `let` is a slot.
		const perIteration = initializer !== undefined && ts.isVariableDeclarationList(initializer) && (initializer.flags & ts.NodeFlags.BlockScoped) !== 0 && containsClosure(node);
		// (scopes mode: a Scope of its own, as tsval's `for` has — not per iteration, unobservable without a closure)
		const inner = newScope(scope, perIteration || mode.scopes === true);

		if (initializer !== undefined && ts.isVariableDeclarationList(initializer)) {
			const kind = (initializer.flags & ts.NodeFlags.Const) !== 0 ? "const" : (initializer.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";

			for (const decl of initializer.declarations) {
				declare(inner, (decl.name as ts.Identifier).text, kind, decl);
			}
		}

		let init: (env: Env) => any = () => undefined;

		if (initializer !== undefined) {
			init = ts.isVariableDeclarationList(initializer) ? declarationList(inner, initializer) : expr(inner, initializer);
		}

		const test = condition === undefined ? () => true : expr(inner, condition);
		const step = incrementor === undefined ? () => undefined : expr(inner, incrementor);
		const run = stmt(inner, body);
		const loop = (env: Env): number => {
			init(env);
			for (; test(env); step(env)) {
				const signal = run(env);

				if (signal === BREAK) break;
				if (signal === RETURN) return RETURN;
			}

			return NORMAL;
		};
		// Traced: the loop's turn, kept where `emit` reads it.
		const turned = (env: Env): number => {
			const entry = { "node": node as ts.Node, "turn": 0 };

			loopStack.push(entry);
			init(env);
			for (; test(env); step(env), entry.turn++) {
				const signal = run(env);

				if (signal === BREAK) break;
				if (signal === RETURN) { loopStack.pop(); return RETURN; }
			}

			loopStack.pop();

			return NORMAL;
		};

		if (!perIteration && mode.scopes) {
			return (env) => loop(makeScope(inner, env as any) as any);
		}

		if (!perIteration) {
			return traced === undefined ? loop : turned;
		}

		return (env) => {
			if (mode.scopes) throw new Error("prototype: per-iteration scopes in scopes mode");

			let iterEnv: Env = new Array(inner.size).fill(HOLE);

			iterEnv[0] = env;
			init(iterEnv);
			for (;;) {
				iterEnv = iterEnv.slice(); // CreatePerIterationEnvironment
				if (!test(iterEnv)) break;

				const signal = run(iterEnv);

				if (signal === BREAK) break;
				if (signal === RETURN) return RETURN;
				iterEnv = iterEnv.slice();
				step(iterEnv);
			}

			return NORMAL;
		};
	}

	function forOfStatement(scope: CScope, node: ts.ForOfStatement): Stmt {
		const { initializer, expression, statement: body } = node;
		const own = containsClosure(node) || mode.scopes === true;
		const inner = newScope(scope, own);
		const list = initializer as ts.VariableDeclarationList;
		const kind = (list.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";
		const [decl] = list.declarations;
		let bind: (env: Env, value: any) => void;

		if (ts.isIdentifier(decl.name)) {
			declare(inner, decl.name.text, kind, decl);
			const write = writer(inner, decl.name.text, decl, true);

			bind = (env, value) => { write(env, value); };
		} else if (ts.isObjectBindingPattern(decl.name)) {
			const parts = decl.name.elements.map((element) => {
				const name = (element.name as ts.Identifier).text;
				const key = element.propertyName === undefined ? name : (element.propertyName as ts.Identifier).text;

				declare(inner, name, kind, decl);

				return { "key": key, "write": writer(inner, name, decl, true) };
			});

			bind = (env, value) => {
				if (value === null || value === undefined) throw new TypeError("Cannot destructure");
				for (const part of parts) part.write(env, fromHost(value[part.key]));
			};
		} else {
			throw new Error("prototype: for-of binding");
		}

		const iterable = expr(scope, expression);
		const run = stmt(inner, body);

		return (env) => {
			for (const value of iterable(env)) { // the iteration protocol, IteratorClose on break/return/throw included
				let turnEnv = env;

				if (own) {
					if (mode.scopes) {
						turnEnv = makeScope(inner, env as any) as any;
					} else {
						turnEnv = new Array(inner.size).fill(HOLE);
						turnEnv[0] = env;
					}
				}

				bind(turnEnv, value);
				const signal = run(turnEnv);

				if (signal === BREAK) break;
				if (signal === RETURN) return RETURN;
			}

			return NORMAL;
		};
	}

	const top = newScope(undefined, true, true);

	declare(top, "this", "this", null);
	const body = block(top, source.statements, false, true);

	return {
		state,
		"run": (): any => {
			if (mode.scopes) {
				const root = makeScope(top, undefined);

				root.globalObject = globals;
				body(root as any);

				return completion;
			}

			const env: Env = new Array(top.size).fill(HOLE);

			env[0] = null;
			env[top.names.get("this")!.slot] = undefined;
			body(env);

			return completion;
		}
	};
}

// --- the measurement ------------------------------------------------------------------------------------------------

const programs: Record<string, string> = {
	"compute": `function isPrime(n) { for (let d = 2; d * d <= n; d += 1) { if (n % d === 0) { return false; } } return n > 1; }
let count = 0; for (let n = 0; n < 20000; n += 1) { if (isPrime(n)) { count += 1; } } count;`,
	"data": `const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i, name: "item " + i, price: (i * 7919) % 1000 / 10 }));
const cheap = rows.filter((row) => row.price < 50).map((row) => ({ ...row, label: row.name.toUpperCase() }));
cheap.sort((a, b) => a.price - b.price || a.id - b.id);
JSON.parse(JSON.stringify(cheap)).length;`,
	"objects": `class P { constructor(x, y) { this.x = x; this.y = y; } add(o) { return new P(this.x + o.x, this.y + o.y); } }
let acc = new P(0, 0); const xs = []; for (let i = 0; i < 30000; i++) { acc = acc.add(new P(i, -i)); xs.push({ i, s: String(i) }); }
let t = 0; for (const { i, s } of xs) { t += i + s.length; } t + acc.x;`
};

function best(fn: () => unknown, rounds = 7): { "ms": number; "value": unknown } {
	const times: number[] = [];
	let value: unknown;

	for (let round = 0; round < rounds; round++) {
		const started = performance.now();

		value = fn();
		times.push(performance.now() - started);
	}

	times.sort((a, b) => a - b);

	return { "ms": times[1]!, "value": value };
}

const parse = (code: string) => ts.createSourceFile("/workspace/main.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const only = process.argv[2];
const nativeContext = createContext({});

// `events`: how many values each engine traces (the closures' tracing should tell what the frame machine's does).
if (only === "events") {
	for (const [name, code] of Object.entries(programs)) {
		const count = (into: Record<string, number>) => (event: { "kind": string }) => { into[event.kind] = (into[event.kind] ?? 0) + 1; };
		const frames: Record<string, number> = {};
		const closures: Record<string, number> = {};

		createVM(code, { "fileName": "/workspace/main.js", "trace": count(frames) }).vm.run();
		compileProgram(parse(code), globalThis as any, { "counted": true, "traced": count(closures) }).run();
		console.log(name, "frames", JSON.stringify(frames), "closures", JSON.stringify(closures));
	}

	process.exit(0);
}


const engines: Record<string, (code: string) => unknown> = {
	"native": (code) => runInContext(`{${code}}`, nativeContext),
	"frames": (code) => createVM(code, { "fileName": "/workspace/main.js" }).vm.run(),
	"frames+debug": (code) => createVM(code, { "fileName": "/workspace/main.js", "coverage": true, "profile": true, "observe": () => {}, "trace": () => {} }).vm.run(),
	"closures": (code) => compileProgram(parse(code), globalThis as any, { "counted": false }).run(),
	"closures/scopes": (code) => compileProgram(parse(code), globalThis as any, { "counted": false, "scopes": true }).run(),
	"closures+counted": (code) => compileProgram(parse(code), globalThis as any, { "counted": true }).run(),
	"closures+traced": (code) => compileProgram(parse(code), globalThis as any, { "counted": true, "traced": () => {} }).run()
};

/** One engine on one program, in this process: the best of two interleavable passes of four. */
function measure(name: string, engine: string): { "ms": number; "value": unknown } {
	const code = programs[name]!;
	const first = best(() => engines[engine]!(code), 4);
	const second = best(() => engines[engine]!(code), 4);

	return first.ms <= second.ms ? first : second;
}

function table(results: Record<string, Record<string, { "ms": number; "value": unknown }>>): void {
	const rows: Record<string, Record<string, string>> = {};

	for (const [name, byEngine] of Object.entries(results)) {
		const values = new Set(Object.values(byEngine).map((r) => JSON.stringify(r.value)));

		if (values.size !== 1) {
			throw new Error(`${name}: the engines disagree: ${[...values].join(" / ")}`);
		}

		rows[name] = Object.fromEntries([
			...Object.entries(byEngine).map(([label, r]) => [label, `${r.ms.toFixed(1)}ms (×${(r.ms / byEngine.native!.ms).toFixed(0)})`]),
			["frames/closures", `${(byEngine.frames!.ms / byEngine.closures!.ms).toFixed(1)}×`]
		]);
	}

	console.table(rows);
}

// `one <program> <engine>`: a child's measurement, as JSON.
if (only === "one") {
	console.log(JSON.stringify(measure(process.argv[3]!, process.argv[4]!)));
	process.exit(0);
}

const results: Record<string, Record<string, { "ms": number; "value": unknown }>> = {};

if (only === "mixed") {
	// Every engine and program in one process, as a long-lived worker would run them: the closures' call sites see
	// every shape of closure, so their feedback is shared and polymorphic — the realistic number.
	for (let pass = 0; pass < 2; pass++) {
		for (const name of Object.keys(programs)) {
			for (const engine of Object.keys(engines)) {
				const result = measure(name, engine);
				const known = (results[name] ??= {})[engine];

				results[name]![engine] = known === undefined || result.ms < known.ms ? result : known;
			}
		}
	}
} else {
	// Isolated (the default): each engine on each program in a process of its own — the ceiling, its feedback clean.
	const { execFileSync } = await import("node:child_process");
	const self = new URL(import.meta.url).pathname;

	for (const name of Object.keys(programs)) {
		for (const engine of Object.keys(engines)) {
			const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", self, "one", name, engine], { "encoding": "utf8" });

			(results[name] ??= {})[engine] = JSON.parse(output.trim().split("\n").pop()!);
		}
	}

	const source = parse(programs.compute!);

	console.log(`parse ${best(() => parse(programs.compute!), 7).ms.toFixed(2)}ms, compile ${best(() => compileProgram(source, globalThis as any, { "counted": false }), 7).ms.toFixed(3)}ms (compute)`);
}

table(results);
