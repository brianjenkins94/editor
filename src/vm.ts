import ts from "typescript";
import { Scope } from "./scope.ts";
import { syntaxKindName } from "./frontend.ts";
import type { GuestFunctionMeta } from "./values.ts";
import type { Frame, NodeFrame, CallFrame, SyntheticFrame, SyntheticKind, Iteration } from "./frame.ts";
import { isGuestFunction } from "./values.ts";
import { nodeHandlers, syntheticHandlers, createGuestFunction, bindIdentifier, bindingProgram, pushPattern, closeIteration, clonePrivateElements, isGuestClass, type GuestClass } from "./handlers.ts";
import { isUncatchable, TsvalInternalError } from "./errors.ts";

/** Statements whose completion is UpdateEmpty(body, undefined): they yield `undefined` when their body produced nothing. */
const COMPLETION_STATEMENTS = new Set<number>([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.SwitchStatement]);

/** Brand marking a live generator/async fiber object as non-cloneable (shared across forks). */
export const FIBER_BRAND = Symbol("tsval.fiber");

/** The guest realm's constructors plus the function-family intrinsics guest functions are built from. */
export interface Realm {
	Array: ArrayConstructor;
	Object: ObjectConstructor;
	RegExp: RegExpConstructor;
	Function: FunctionConstructor;
	Promise: PromiseConstructor;
	/** %GeneratorFunction.prototype% — [[Prototype]] of every `function*`. */
	GeneratorFunctionPrototype: object;
	/** %GeneratorFunction.prototype.prototype% — what a `function*`'s own `.prototype` inherits from. */
	GeneratorPrototype: object;
	AsyncGeneratorFunctionPrototype: object;
	AsyncGeneratorPrototype: object;
	/** %AsyncFunction.prototype% — [[Prototype]] of every `async function`. */
	AsyncFunctionPrototype: object;
	/** `Array.prototype.values` (= `@@iterator`), %ArrayIteratorPrototype% and its pristine `next`: an
	 *  array whose iteration is untouched is iterated through a cloneable record (see getIterator). */
	arrayValues: unknown;
	arrayIteratorPrototype: { next?: unknown };
	arrayIteratorNext: unknown;
}

/**
 * Complete a realm with its generator/async intrinsics. In the process realm they are the real ones.
 * In a foreign realm (`globalObject` from `node:vm`) none of them is reachable from the globals
 * without evaluating code there, so stand-ins are built with the right shape and parentage
 * (%IteratorPrototype% IS reachable, through an array iterator).
 */
function makeRealm(base: Pick<Realm, "Array" | "Object" | "RegExp" | "Function" | "Promise">): Realm {
	const arrayValues = base.Array.prototype.values;
	const arrayIteratorPrototype = Object.getPrototypeOf(arrayValues.call(new base.Array())) as { next?: unknown };
	const arrays = { arrayValues, arrayIteratorPrototype, arrayIteratorNext: arrayIteratorPrototype.next };
	if (base.Function === Function) {
		const genFnProto = Object.getPrototypeOf(function* () {}) as { prototype: object };
		const asyncGenFnProto = Object.getPrototypeOf(async function* () {}) as { prototype: object };
		return { ...base, ...arrays, GeneratorFunctionPrototype: genFnProto, GeneratorPrototype: genFnProto.prototype, AsyncGeneratorFunctionPrototype: asyncGenFnProto, AsyncGeneratorPrototype: asyncGenFnProto.prototype, AsyncFunctionPrototype: Object.getPrototypeOf(async function () {}) as object };
	}
	const O = base.Object;
	const iteratorPrototype = Object.getPrototypeOf(arrayIteratorPrototype) as object;
	const asyncIteratorPrototype = O.create(O.prototype) as object;
	Object.defineProperty(asyncIteratorPrototype, Symbol.asyncIterator, {
		value: function (this: unknown) {
			return this;
		},
		writable: true,
		configurable: true,
	});
	const family = (functionTag: string, parent: object, tag: string): { fnProto: object; proto: object } => {
		const fnProto = O.create(base.Function.prototype) as object;
		const proto = O.create(parent) as object;
		Object.defineProperty(fnProto, "prototype", { value: proto, configurable: true });
		Object.defineProperty(fnProto, Symbol.toStringTag, { value: functionTag, configurable: true });
		Object.defineProperty(proto, "constructor", { value: fnProto, configurable: true });
		Object.defineProperty(proto, Symbol.toStringTag, { value: tag, configurable: true });
		return { fnProto, proto };
	};
	const gen = family("GeneratorFunction", iteratorPrototype, "Generator");
	const asyncGen = family("AsyncGeneratorFunction", asyncIteratorPrototype, "AsyncGenerator");
	const asyncFnProto = O.create(base.Function.prototype) as object;
	Object.defineProperty(asyncFnProto, Symbol.toStringTag, { value: "AsyncFunction", configurable: true });
	return { ...base, ...arrays, GeneratorFunctionPrototype: gen.fnProto, GeneratorPrototype: gen.proto, AsyncGeneratorFunctionPrototype: asyncGen.fnProto, AsyncGeneratorPrototype: asyncGen.proto, AsyncFunctionPrototype: asyncFnProto };
}

/** A generator object: inherits from `proto` (the function's `.prototype`), with its resumption
 *  methods as non-enumerable own properties (the fiber lives in their closures). */
function generatorObject(proto: object, methods: Record<string, (...a: never[]) => unknown>): object {
	const gen = Object.create(proto) as object;
	for (const [name, value] of Object.entries(methods)) Object.defineProperty(gen, name, { value, writable: true, configurable: true });
	return gen;
}

/**
 * A control-stack frame — the reified recursion (ASSIGNMENT §3).
 *
 * `node` + `phase` say *what to evaluate next / what to do once children resolve*; `scope` is the
 * lexical environment the frame runs in. Synthetic frames (no direct 1:1 node, e.g. a function call)
 * carry a `kind` tag and dispatch through `syntheticHandlers`; all others dispatch by `node.kind`.
 *
 * Frames are plain data (no closures) so the whole machine state is cloneable for snapshot/fork (S4).
 */
export type { Frame, NodeFrame, CallFrame, ConstructFrame, InitFieldsFrame, PatternFrame, SyntheticFrame } from "./frame.ts";

export type Signal =
	| { type: "return"; value: unknown }
	| { type: "throw"; value: unknown }
	| { type: "break"; label?: string }
	| { type: "continue"; label?: string };

export type NodeHandler = (vm: VM, frame: NodeFrame) => void;
/** One handler per synthetic frame kind, each receiving its own frame type. */
export type SyntheticHandlers = { [Kind in SyntheticKind]: (vm: VM, frame: Extract<SyntheticFrame, { kind: Kind }>) => void };

export interface VMOptions {
	/** Injected globals / capability shims (checked before real globals). */
	globals?: Record<string, unknown>;
	/** Use this object *as* the global object (not copied — a fresh realm's `globalThis`, whose
	 *  builtins are non-enumerable, or a shared shim table). `globals` are then layered on top of it. */
	globalObject?: Record<string, unknown>;
	/** Fall back to the host's real `globalThis` for unresolved names. Default true (max differential
	 *  parity). A sandboxing host sets this false for a controlled environment. */
	realGlobals?: boolean;
	/** Resolve a module specifier to its namespace object (for `import` / dynamic `import()`). This is
	 *  the injection seam for capability shims (ASSIGNMENT §5): return shimmed built-ins here. */
	resolveModule?: (specifier: string) => unknown;
	/** Optional `TypeChecker` for type-aware evaluation (a host can ask for the static type at a node). */
	typeChecker?: ts.TypeChecker;
	/** Top-level `this`. Default `undefined` (module semantics — the supported surface); a *script*
	 *  runner (test262) passes the global object. */
	thisValue?: unknown;
	/** Guard at the host↔guest boundary: sanitize values entering guest land and vet host callables.
	 *  This is how a sandbox stays closed — real intrinsics leak the real `Function` via
	 *  `.constructor.constructor`, and only the interpreter sees every read and every call. */
	hostGuard?: HostGuard;
	/** Notified with the Promise of every async guest function invoked, so a driver can track
	 *  outstanding async work (a host that must observe every effect awaits it). */
	onAsyncFiber?: (promise: Promise<unknown>) => void;
}

/**
 * The host-boundary guard (see `VMOptions.hostGuard`). Both hooks default to identity.
 * - `sanitize(value)`: applied to every value that crosses from host land into guest land — property/
 *   element reads, host call & construct results, imported bindings, destructured host properties.
 *   Return a replacement (e.g. a shim for the real `Function`) or the value unchanged.
 * - `beforeCall(callee, thisArg, isConstruct)`: applied before the interpreter invokes a host callable;
 *   return the callable to actually invoke. `thisArg` lets it vet `Function.prototype.call/apply/bind`
 *   applied to a forbidden target.
 */
export interface HostGuard {
	sanitize?(value: unknown): unknown;
	beforeCall?(callee: (...a: unknown[]) => unknown, thisArg: unknown, isConstruct: boolean): (...a: unknown[]) => unknown;
}

/**
 * The stepped, stack-based VM (a CEK/CESK-style explicit-continuation-stack walker).
 *
 * `step()` does exactly one unit of work on the top frame. Everything else — `run`, `stepStatement`,
 * `runUntil`, control flow, calls — is built on that single primitive (ASSIGNMENT §3).
 */
export class VM {
	/** operand stack: sub-expression results. */
	values: unknown[] = [];
	/** control stack: frames, top at the end. */
	frames: Frame[] = [];
	rootScope: Scope;
	/** a propagating non-local control transfer (return/throw/break/continue) being unwound. */
	signal: Signal | null = null;
	/** The program's completion value (script/`eval` semantics): the last value-producing statement's
	 *  value, where a compound statement (`if`, a loop, `try`, `switch`) that produced none yields
	 *  `undefined` (the spec's UpdateEmpty). Statements inside functions never contribute. */
	completion: unknown = undefined;
	/** bumped on every completion-value write; a compound statement compares it to know whether its body produced one. */
	completionSerial = 0;
	finished = false;
	/** monotonic count of `step()` calls — a free step budget (ASSIGNMENT §3). */
	steps = 0;
	/** set by a `yield`/`await` handler to suspend the current fiber (generator/async). */
	paused = false;
	/** which kind of suspension: an async generator can do both, and its driver must know. */
	pauseKind: "yield" | "await" | undefined = undefined;
	/** the value carried out of a suspension point: the yielded value, or the awaited operand. */
	pauseValue: unknown = undefined;
	/** a sync `yield*` yields the inner iterator's *result object* as-is (spec GeneratorYield(innerResult));
	 *  the driver must not re-wrap it. */
	pauseRaw = false;
	/** the value fed back in on resume (the `.next(v)` argument / the resolved awaited value). */
	sentValue: unknown = undefined;

	/** Module resolver for `import` / dynamic `import()` (the shim-injection seam, ASSIGNMENT §5). */
	resolveModule: ((specifier: string) => unknown) | undefined;
	/** Optional `TypeChecker` — present in type-aware runs (ASSIGNMENT S6). */
	typeChecker: ts.TypeChecker | undefined;
	/** The call/new expression currently invoking a host callable — lets a shim introspect its
	 *  callsite (e.g. the static type of its argument) via `typeChecker`. Set only around the host
	 *  `apply`/`construct`. */
	callSite: ts.CallExpression | ts.NewExpression | undefined;
	hostGuard: HostGuard | undefined;
	onAsyncFiber: ((promise: Promise<unknown>) => void) | undefined;

	/** The guest realm's Error constructors, so errors tsval itself throws (ReferenceError on an
	 *  unbound name, TypeError on a bad call, …) are instances of the *guest's* classes. Resolved
	 *  from the global object; falls back to this realm's. */
	readonly guestErrors: Record<string, new (message?: string) => Error>;
	/** The guest realm's constructors used to *create* guest values (literals, rest arrays, class
	 *  prototypes, function prototypes), so `[] instanceof Array` and `Object.getPrototypeOf({})`
	 *  agree with the guest's own intrinsics when the global object is another realm's. */
	readonly realm: Realm;

	constructor(options: VMOptions = {}) {
		this.rootScope = new Scope(undefined, true);
		if (options.globalObject !== undefined) {
			const base = options.globalObject;
			for (const [name, value] of Object.entries(options.globals ?? {})) base[name] = value;
			this.rootScope.globalObject = base;
		} else {
			this.rootScope.globalObject = { undefined, NaN, Infinity, ...(options.globals ?? {}) };
		}
		const g = this.rootScope.globalObject as Record<string, unknown>;
		this.guestErrors = {};
		for (const name of ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError"]) {
			const ctor = (g[name] ?? (globalThis as Record<string, unknown>)[name]) as new (message?: string) => Error;
			if (typeof ctor === "function") this.guestErrors[name] = ctor;
		}
		const pick = <T>(name: string): T => (typeof g[name] === "function" ? g[name] : (globalThis as Record<string, unknown>)[name]) as T;
		const realmObject = pick<ObjectConstructor>("Object");
		// The realm's *intrinsic* Function is reached through Object (a global named `Function` may be
		// a shim — a host's eval guard); it's what guest function objects are created from.
		const realmFunction = (realmObject as unknown as { constructor: FunctionConstructor }).constructor;
		this.realm = makeRealm({ Array: pick("Array"), Object: realmObject, RegExp: pick("RegExp"), Function: typeof realmFunction === "function" ? realmFunction : Function, Promise: pick("Promise") });
		this.rootScope.hasThis = true;
		this.rootScope.thisVal = options.thisValue;
		this.rootScope.realGlobals = options.realGlobals ?? true;
		this.resolveModule = options.resolveModule;
		this.typeChecker = options.typeChecker;
		this.hostGuard = options.hostGuard;
		this.onAsyncFiber = options.onAsyncFiber;
	}

	/** A value crossing from host land into guest land, passed through the guard (identity if none). */
	fromHost(value: unknown): unknown {
		const sanitize = this.hostGuard?.sanitize;
		return sanitize === undefined ? value : sanitize(value);
	}

	/** Invoke a host callable from guest code, through the guard and with `callSite` exposed. */
	invokeHost(callee: (...a: unknown[]) => unknown, thisArg: unknown, args: unknown[], site: ts.CallExpression | ts.NewExpression, isConstruct: boolean): unknown {
		const target = this.hostGuard?.beforeCall === undefined ? callee : this.hostGuard.beforeCall(callee, thisArg, isConstruct);
		const previousSite = this.callSite;
		this.callSite = site;
		try {
			const result = isConstruct ? Reflect.construct(target as unknown as new (...a: unknown[]) => unknown, args) : target.apply(thisArg, args);
			return this.fromHost(result);
		} finally {
			this.callSite = previousSite;
		}
	}

	/** Resolve a module namespace, or throw a guest-catchable error if unresolved. */
	importModule(specifier: string): unknown {
		const ns = this.resolveModule?.(specifier);
		if (ns === undefined) throw new Error(`Cannot find module '${specifier}'`);
		return ns;
	}

	/** The loaded program, kept for source-position lookups (breakpoints, `location`). */
	sourceFile: ts.SourceFile | undefined;
	/** Breakpoints, as node start positions (see `addBreakpoint` / `addBreakpointsByLine`). */
	readonly breakpoints = new Set<number>();

	/** Seat a parsed SourceFile as the initial frame. */
	load(sourceFile: ts.SourceFile): void {
		this.sourceFile = sourceFile;
		this.pushNode(sourceFile, this.rootScope);
	}

	// --- frame / value helpers ------------------------------------------------

	pushNode(node: ts.Node, scope: Scope): NodeFrame {
		const frame: NodeFrame = { node, phase: 0, scope, valuesBase: this.values.length };
		this.frames.push(frame);
		return frame;
	}

	/** Statements inside a function (a call, a constructor, a field initializer / static block) never
	 *  contribute to the program's completion value. */
	insideFunction(scope: Scope): boolean {
		for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) if (s.isolated && s !== this.rootScope) return true;
		return false;
	}

	/** Record a completion value (ExpressionStatement). */
	setCompletion(value: unknown): void {
		this.completion = value;
		this.completionSerial++;
	}

	/** A compound statement finished (normally or by a caught break) without its body producing a
	 *  completion value: the program's completion becomes undefined — unless it ran inside a function. */
	private finishStatement(frame: NodeFrame): void {
		if (frame.completionMark !== this.completionSerial || this.insideFunction(frame.scope)) return;
		this.completion = undefined;
	}

	pushFrame(frame: SyntheticFrame): void {
		this.frames.push(frame);
	}

	get top(): Frame | undefined {
		return this.frames[this.frames.length - 1];
	}

	push(value: unknown): void {
		this.values.push(value);
	}

	pop(): unknown {
		return this.values.pop();
	}

	/** Raise a non-local control transfer; the next `step()` begins unwinding. */
	raise(signal: Signal): void {
		this.signal = signal;
	}

	// --- the driver -----------------------------------------------------------

	/** Do exactly one unit of work. */
	step(): void {
		if (this.finished) return;
		const frame = this.top;
		if (frame === undefined) {
			// No frame left — but a signal may still be pending (a handler that pops itself *before*
			// throwing, e.g. an Identifier read in a sub-evaluation). It must escape, not be dropped.
			const signal = this.signal;
			this.signal = null;
			this.finished = true;
			if (signal?.type === "throw") throw signal.value;
			if (signal?.type === "return") this.completion = signal.value;
			return;
		}
		this.steps++;

		if (this.signal !== null) {
			this.unwind(frame, this.signal);
			return;
		}

		// (each synthetic handler is typed for its own frame; the union is dispatched on `kind` here)
		const handler = (frame.kind !== undefined ? syntheticHandlers[frame.kind] : nodeHandlers[frame.node.kind]) as ((vm: VM, frame: Frame) => void) | undefined;
		if (handler === undefined) {
			if (frame.kind !== undefined) throw new TsvalInternalError(`unimplemented: ${frame.kind}`);
			throw new TsvalInternalError(`unimplemented: ${syntaxKindName(frame.node.kind)} (SyntaxKind ${frame.node.kind})`);
		}
		try {
			// A compound statement takes its completion mark when it STARTS (a block pushes all its
			// statements up front; earlier siblings run in between).
			if (frame.kind === undefined && frame.phase === 0 && frame.completionMark === undefined && COMPLETION_STATEMENTS.has(frame.node.kind)) frame.completionMark = this.completionSerial;
			handler(this, frame);
			if (frame.kind === undefined && frame.completionMark !== undefined && this.frames[this.frames.length - 1] !== frame && !this.frames.includes(frame)) this.finishStatement(frame);
		} catch (error) {
			// A guest-observable runtime error (host built-in threw, bad member access, `instanceof` on a
			// non-object, …) becomes a catchable `throw` signal. Interpreter bugs and a host's uncatchable
			// aborts stay loud and propagate to the host uncaught (ASSIGNMENT working style; a host tripwire must
			// not be swallowable by guest try/catch).
			if (isUncatchable(error)) throw error;
			this.signal = { type: "throw", value: this.toGuestError(error) };
		}
	}

	/**
	 * An error created by tsval's own host code (this realm's `TypeError` etc.) becomes the guest
	 * realm's equivalent, so guest `instanceof`/`constructor` checks see the classes the guest knows.
	 * Errors already from another realm, or non-Error values, pass through.
	 */
	private toGuestError(error: unknown): unknown {
		if (!(error instanceof Error)) return error;
		const name = error.constructor.name;
		const guestCtor = this.guestErrors[name];
		if (guestCtor === undefined || guestCtor === (globalThis as Record<string, unknown>)[name]) return error;
		const converted = new guestCtor(error.message);
		if (error.stack !== undefined) converted.stack = error.stack;
		return converted;
	}

	/**
	 * Unwind one frame for a propagating signal (ASSIGNMENT §3: "control flow = unwinding").
	 *
	 * - `call` frames catch `return`.
	 * - loop frames catch matching `break`/`continue` (break ends the loop; continue resumes it at
	 *   its `continuePhase`).
	 * - `switch` and labeled-block frames catch matching `break`.
	 * - `try` frames route `throw` to `catch` and run `finally` on the way out, re-raising any pending
	 *   signal afterward.
	 * - everything else is discarded, its operands truncated away.
	 *
	 * If the signal escapes the program, a `throw` is rethrown to the host and a top-level `return`
	 * becomes the completion value.
	 */
	private unwind(frame: Frame, signal: Signal): void {
		if (frame.kind === "call" && signal.type === "return") {
			this.frames.pop();
			this.values.length = frame.valuesBase;
			this.values.push(signal.value);
			this.signal = null;
			return;
		}
		if (frame.kind === "construct" && signal.type === "return") {
			// A constructor's `return`: an object replaces the instance; a derived constructor returning
			// any other non-undefined value is a TypeError; otherwise the instance stands. The frame is
			// kept — its completion step (this-TDZ check, pushing the instance) still runs.
			const value = signal.value;
			this.values.length = frame.valuesBase;
			this.signal = null;
			if ((typeof value === "object" && value !== null) || typeof value === "function") {
				(frame.construction as { instance: unknown }).instance = value;
				frame.overridden = true; // (a derived constructor may then never have called super())
			} else if (value !== undefined && frame.derived === true) this.signal = { type: "throw", value: this.toGuestError(new TypeError("Derived constructors may only return object or undefined")) };
			return;
		}

		if (frame.kind === "pattern") this.closeIterations(frame.iters.splice(0).reverse(), signal); // innermost first

		if (frame.kind === undefined) {
			// Loop frames catch break/continue targeting them (unlabeled, or matching label).
			if (frame.isLoop === true && (signal.type === "break" || signal.type === "continue")) {
				if (signal.label == null || signal.label === frame.label) {
					this.values.length = frame.valuesBase;
					this.signal = null;
					if (signal.type === "break") {
						this.frames.pop();
						if (frame.iteration !== undefined) this.closeIterations([frame.iteration], signal);
						if (frame.completionMark !== undefined) this.finishStatement(frame);
					} else frame.phase = frame.continuePhase as number;
					return;
				}
			}
			// A for-of left by any other abrupt completion (return/throw/outer break) closes its iterator.
			if (frame.isLoop === true && frame.iteration !== undefined) this.closeIterations([frame.iteration], signal);

			// switch / labeled-block frames catch break targeting them.
			if ((frame.isSwitch === true || frame.isLabel === true) && signal.type === "break") {
				if (signal.label == null ? frame.isSwitch === true : signal.label === frame.label) {
					this.values.length = frame.valuesBase;
					this.signal = null;
					this.frames.pop();
					if (frame.completionMark !== undefined) this.finishStatement(frame);
					return;
				}
			}

			if (frame.node.kind === ts.SyntaxKind.TryStatement) {
				this.unwindTry(frame, signal);
				return;
			}
		}

		// Not handled here: discard this frame and keep unwinding.
		this.frames.pop();
		this.values.length = Math.min(this.values.length, frame.valuesBase);

		if (this.frames.length === 0) {
			this.signal = null;
			this.finished = true;
			if (signal.type === "throw") throw signal.value;
			if (signal.type === "return") this.completion = signal.value;
			// stray break/continue at top level would be a SyntaxError; parse-time concern.
		}
	}

	/**
	 * IteratorClose for iterations a frame still has open when a signal unwinds through it (a loop's,
	 * or a pattern frame's, innermost first). A `throw` wins over anything `return()` throws; for any
	 * other completion (`break`, `return`, `continue` past the loop) an error from `return()` replaces
	 * it — thrown while unwinding, it becomes the propagating signal.
	 */
	private closeIterations(iterations: Iteration[], signal: Signal): void {
		for (const it of iterations) {
			try {
				closeIteration(it, signal.type === "throw");
			} catch (error) {
				if (isUncatchable(error)) throw error;
				this.signal = { type: "throw", value: this.toGuestError(error) };
			}
		}
	}

	/**
	 * Try/catch/finally unwinding. `frame.state` records where we were: in the `try` block, the
	 * `catch` block, or a `finally`. A `throw` in `try` with a catch clause routes to `catch`; any
	 * other escaping signal (or a throw with no catch) runs `finally` then re-raises. The phases here
	 * pair with `handleTry` in handlers.ts.
	 */
	private unwindTry(frame: NodeFrame, signal: Signal): void {
		const node = frame.node as ts.TryStatement;
		const runFinallyThenReraise = () => {
			this.values.length = frame.valuesBase;
			frame.pendingSignal = signal;
			this.signal = null;
			frame.state = "finally";
			frame.phase = 5;
			this.pushNode(node.finallyBlock as ts.Block, frame.scope);
		};

		if (frame.state === "try") {
			if (signal.type === "throw" && node.catchClause != null) {
				this.values.length = frame.valuesBase;
				this.signal = null;
				const clause = node.catchClause;
				const catchScope = new Scope(frame.scope, false);
				const varDecl = clause.variableDeclaration;
				frame.state = "catch";
				frame.phase = 3;
				this.pushNode(clause.block, catchScope);
				// A destructuring catch parameter (`catch ([x, y = d])`) binds through a pattern frame above
				// the block (its defaults may even suspend); a throw while binding replaces the caught error
				// and unwinds through this frame's `catch` state, so a finally still runs.
				if (varDecl != null) {
					if (ts.isIdentifier(varDecl.name)) bindIdentifier(catchScope, varDecl.name.text, signal.value, "let");
					else pushPattern(this, catchScope, bindingProgram(varDecl.name, "let"), signal.value);
				}
				return;
			}
			if (node.finallyBlock != null) return runFinallyThenReraise();
		} else if (frame.state === "catch") {
			if (node.finallyBlock != null) return runFinallyThenReraise();
		}
		// state === "finally": a signal from inside finally overrides any pending one → propagate.

		this.frames.pop();
		this.values.length = Math.min(this.values.length, frame.valuesBase);
		if (this.frames.length === 0) {
			this.signal = null;
			this.finished = true;
			if (signal.type === "throw") throw signal.value;
			if (signal.type === "return") this.completion = signal.value;
		}
	}

	/** Run to completion, synchronously. A top-level `await` needs a driver — use `runAsync`. */
	run(): unknown {
		while (!this.finished && !this.paused) this.step();
		if (this.paused) throw new TsvalInternalError(`top-level ${this.pauseKind} reached in a synchronous run(); use runAsync()`);
		return this.completion;
	}

	/**
	 * Run to completion, driving top-level `await`: the main context suspends like a fiber and resumes
	 * when the awaited value settles (a rejection is injected as a throw at the await; an uncatchable
	 * error propagates).
	 */
	async runAsync(): Promise<unknown> {
		while (!this.finished) {
			while (!this.finished && !this.paused) this.step();
			if (!this.paused) break;
			if (this.pauseKind !== "await") throw new TsvalInternalError("top-level yield outside a generator");
			this.paused = false;
			try {
				this.sentValue = await this.pauseValue;
			} catch (error) {
				if (isUncatchable(error)) throw error;
				this.signal = { type: "throw", value: error };
			}
		}
		return this.completion;
	}

	/** Step until the given predicate holds, the machine suspends (`paused`), or it finishes. */
	runUntil(predicate: (vm: VM) => boolean): void {
		while (!this.finished && !this.paused && !predicate(this)) this.step();
	}

	/** Step until control reaches the next statement boundary (or the machine finishes). */
	stepStatement(): void {
		// Advance at least one step, then run until the *next* fresh statement frame.
		this.step();
		this.runUntil((vm) => vm.atStatementBoundary());
	}

	/** True when the top frame is about to begin evaluating a statement node (fresh, phase 0). */
	atStatementBoundary(): boolean {
		const f = this.top;
		return f !== undefined && f.kind === undefined && f.phase === 0 && f.node !== null && isStatement(f.node);
	}

	/** The node the top frame is about to work on (or is working on), for inspection/UI. */
	get currentNode(): ts.Node | null {
		return this.top?.node ?? null;
	}

	/** The 0-based line/character (and raw position) of a node, for debugger UIs. */
	location(node: ts.Node | null = this.currentNode): { line: number; character: number; pos: number } | null {
		if (node == null || this.sourceFile == null) return null;
		const pos = node.getStart(this.sourceFile);
		const { line, character } = this.sourceFile.getLineAndCharacterOfPosition(pos);
		return { line, character, pos };
	}

	/** Add a breakpoint at a node's start position. */
	addBreakpoint(pos: number): void {
		this.breakpoints.add(pos);
	}

	/** Add breakpoints by 1-based source line: breaks at the first statement starting on each line. */
	addBreakpointsByLine(...lines: number[]): void {
		if (this.sourceFile == null) return;
		const wanted = new Set(lines);
		const visit = (node: ts.Node): void => {
			if (isStatement(node)) {
				const line = this.sourceFile!.getLineAndCharacterOfPosition(node.getStart(this.sourceFile!)).line + 1;
				if (wanted.has(line)) this.breakpoints.add(node.getStart(this.sourceFile!));
			}
			node.forEachChild(visit);
		};
		this.sourceFile.forEachChild(visit);
	}

	/** True when the top frame is a fresh statement sitting on a breakpoint. */
	atBreakpoint(): boolean {
		const f = this.top;
		if (f === undefined || f.kind !== undefined || f.phase !== 0 || f.node === null || this.sourceFile === undefined) return false;
		// Statement-level only: a statement and a child expression can share a start position.
		return isStatement(f.node) && this.breakpoints.has(f.node.getStart(this.sourceFile));
	}

	/** Run until the next breakpoint (or completion). Advances at least one step. */
	runToBreakpoint(): void {
		this.step();
		this.runUntil((vm) => vm.atBreakpoint());
	}

	// --- snapshot / fork (ASSIGNMENT §3, S4) ----------------------------------

	/**
	 * Produce an independent copy of the machine at its current point — a fork.
	 *
	 * The whole state (value stack, control stack, scope graph, signal, completion) is deep-copied so
	 * the two machines can diverge without interfering. The crucial subtlety (ASSIGNMENT §3): **guest
	 * state is cloned, host state is shared**. Injected shims, host built-ins, the root globals, AST
	 * nodes, class constructors, and live generator/async fibers keep their identity (cloning them would
	 * break `instanceof`, capability recording, or be impossible); only program-created objects, arrays,
	 * closures, scopes, and value-like host builtins (Date/RegExp/Map/Set) are copied. A shared `seen`
	 * map preserves reference identity and cycles *within* the fork.
	 *
	 * This is what lets a host explore more than one path from a single run.
	 */
	fork(): VM {
		const seen = new Map<unknown, unknown>();
		// The fork is created first so cloned closures can be rebound to *it* (not to this source VM),
		// and it needs its realm/intrinsics *before* any closure is cloned (function creation uses them).
		const forked: VM = Object.create(VM.prototype);
		(forked as { realm: VM["realm"] }).realm = this.realm; // same guest realm (intrinsics are shared)
		(forked as { guestErrors: VM["guestErrors"] }).guestErrors = this.guestErrors;

		const cloneScope = (s: Scope): Scope => {
			const parent = s.parent ? (clone(s.parent) as Scope) : undefined;
			const ns = new Scope(parent, s.isolated);
			seen.set(s, ns);
			ns.realGlobals = s.realGlobals;
			ns.hasThis = s.hasThis;
			ns.thisVal = clone(s.thisVal);
			ns.homeObject = s.homeObject; // guest prototype — shared (behavior, not data)
			ns.classMeta = s.classMeta; // shared
			ns.newTarget = s.newTarget; // constructor — shared
			ns.functionMeta = s.functionMeta; // shared (AST + flags)
			ns.privateNames = s.privateNames; // shared: the same class evaluation's private names
			if (s.parent === undefined) ns.globalObject = s.globalObject; // share injected/host globals
			for (const [name, b] of s.bindings) ns.bindings.set(name, { value: clone(b.value), kind: b.kind, initialized: b.initialized });
			return ns;
		};

		const clone = (v: unknown): unknown => {
			if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
			if (seen.has(v)) return seen.get(v);

			if (typeof v === "function") {
				if (isGuestFunction(v)) {
					const meta = v.__tsval;
					// Rebind to the forked VM; break the closure cycle via pre-registration.
					const fn = createGuestFunction(forked, meta.node, meta.closure, meta.homeObject);
					fn.__tsval.isGenerator = meta.isGenerator;
					fn.__tsval.isAsync = meta.isAsync;
					seen.set(v, fn);
					fn.__tsval.closure = clone(meta.closure) as Scope;
					return fn;
				}
				return v; // host functions & guest class constructors — shared
			}
			if (v instanceof Scope) return cloneScope(v);
			if ((v as Record<PropertyKey, unknown>)[FIBER_BRAND] === true) return v; // live fiber — shared
			// A guest class prototype (its `constructor` is a branded guest class) is behavior, not data:
			// share it, consistently with `cloneScope`'s `homeObject` — so a mid-construction fork keeps
			// `ClassMeta.proto === ctor.prototype`.
			if (isGuestClassPrototype(v)) return v;

			if (Array.isArray(v)) {
				const out: unknown[] = [];
				seen.set(v, out);
				for (let i = 0; i < v.length; i++) out[i] = clone(v[i]);
				return out;
			}
			if (v instanceof Date) return register(v, new Date(v.getTime()));
			if (v instanceof RegExp) return register(v, new RegExp(v.source, v.flags));
			if (v instanceof Map) {
				const out = new Map();
				seen.set(v, out);
				for (const [k, val] of v) out.set(clone(k), clone(val));
				return out;
			}
			if (v instanceof Set) {
				const out = new Set();
				seen.set(v, out);
				for (const val of v) out.add(clone(val));
				return out;
			}

			const proto = Object.getPrototypeOf(v);
			const isGuestObject = proto === Object.prototype || proto === null || isGuestClass(proto?.constructor);
			if (!isGuestObject) return v; // host instance (Promise, Error, DOM, host class, …) — shared

			const out = Object.create(proto); // share the (guest) prototype; copy own data
			seen.set(v, out);
			for (const key of Reflect.ownKeys(v)) {
				const desc = Object.getOwnPropertyDescriptor(v, key)!;
				if ("value" in desc) desc.value = clone(desc.value);
				// Accessors are closures too: rebind them like any other guest function.
				if (desc.get !== undefined) desc.get = clone(desc.get) as () => unknown;
				if (desc.set !== undefined) desc.set = clone(desc.set) as (v: unknown) => void;
				Object.defineProperty(out, key, desc);
			}
			clonePrivateElements(v, out, clone); // private (`#x`) state lives in a side table
			return out;
		};

		const register = <T>(from: unknown, to: T): T => {
			seen.set(from, to);
			return to;
		};

		const cloneFrame = (f: Frame): Frame => {
			// Field by field: every frame is plain data (frame.ts); a compiled PatternProgram is a shared
			// class instance and `clone` passes it through.
			const nf = { node: f.node, phase: f.phase, scope: clone(f.scope) as Scope, valuesBase: f.valuesBase } as Record<string, unknown>;
			for (const key of Object.keys(f)) {
				if (key === "node" || key === "phase" || key === "scope" || key === "valuesBase") continue;
				nf[key] = clone((f as unknown as Record<string, unknown>)[key]);
			}
			return nf as unknown as Frame;
		};

		(forked as { rootScope: Scope }).rootScope = clone(this.rootScope) as Scope;
		(forked as { breakpoints: Set<number> }).breakpoints = new Set(this.breakpoints);
		forked.sourceFile = this.sourceFile;
		forked.resolveModule = this.resolveModule;
		forked.typeChecker = this.typeChecker;
		forked.hostGuard = this.hostGuard;
		forked.onAsyncFiber = this.onAsyncFiber;
		forked.callSite = undefined;
		forked.values = this.values.map(clone);
		forked.frames = this.frames.map(cloneFrame);
		forked.signal = this.signal ? ({ ...this.signal, value: clone((this.signal as { value?: unknown }).value) } as Signal) : null;
		forked.completion = clone(this.completion);
		forked.finished = this.finished;
		forked.steps = this.steps;
		forked.paused = this.paused;
		forked.pauseKind = this.pauseKind;
		forked.pauseValue = clone(this.pauseValue);
		forked.sentValue = clone(this.sentValue);
		return forked;
	}

	// --- execution contexts (nested sub-runs & fibers) ------------------------

	private saveContext(): ExecContext {
		return { frames: this.frames, values: this.values, signal: this.signal, finished: this.finished, paused: this.paused, pauseKind: this.pauseKind, pauseValue: this.pauseValue, pauseRaw: this.pauseRaw, sentValue: this.sentValue };
	}

	private restoreContext(ctx: ExecContext): void {
		this.frames = ctx.frames;
		this.values = ctx.values;
		this.signal = ctx.signal;
		this.finished = ctx.finished;
		this.paused = ctx.paused;
		this.pauseKind = ctx.pauseKind;
		this.pauseValue = ctx.pauseValue;
		this.pauseRaw = ctx.pauseRaw;
		this.sentValue = ctx.sentValue;
	}

	/** Run a fresh private context seeded by `seed`, to completion, and return the top value. */
	private runSub(seed: () => void): unknown {
		const ctx = this.saveContext();
		this.frames = [];
		this.values = [];
		this.signal = null;
		this.finished = false;
		this.paused = false;
		seed();
		try {
			while (!this.finished) {
				this.step();
				// A synchronous sub-run has no driver to resume it: a `yield`/`await` here (a computed key,
				// default value, or destructuring default containing one) cannot be honored. Fail loud
				// rather than silently resuming with `undefined`.
				if (this.paused) throw new TsvalInternalError("yield/await inside a synchronously evaluated sub-expression (default value / computed key) is not supported");
			}
			return this.values.pop();
		} finally {
			this.restoreContext(ctx);
		}
	}

	/**
	 * Invoke a guest function from host code (array callbacks, shims). Runs a nested loop to
	 * completion on a private stack; host↔guest crossings use the host stack (documented tradeoff),
	 * while guest→guest calls stay on the explicit stack. (ASSIGNMENT §3, "Calls".)
	 */
	callGuestFromHost(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[], newTarget?: unknown): unknown {
		if (meta.isGenerator && meta.isAsync) return this.createAsyncGenerator(meta, thisArg, args);
		if (meta.isGenerator) return this.createGenerator(meta, thisArg, args);
		if (meta.isAsync) return this.callAsync(meta, thisArg, args);
		return this.runSub(() => this.pushCall(meta, args, thisArg, newTarget));
	}

	/**
	 * Evaluate a single expression node to a value on a private stack, synchronously. Used for the
	 * "leaf" sub-expressions of binding forms — default parameter/element values and computed
	 * destructuring keys — where a full stepped integration would be disproportionate. Nested guest
	 * calls it makes still run on the explicit (sub-)stack; only the entry uses the host stack.
	 */
	evalNodeSync(node: ts.Node, scope: Scope): unknown {
		return this.runSub(() => this.pushNode(node, scope));
	}

	/**
	 * Construct a guest class from host code (e.g. `new` reached through a host callback). Runs a
	 * construct frame to completion on a private stack; guest `new` uses the explicit construct frame
	 * directly (steppable). The `frame.kind === "construct"` handler lives in handlers.ts.
	 */
	constructGuestSync(ctor: GuestClass, args: unknown[], newTarget: unknown = ctor): unknown {
		return this.runSub(() => this.frames.push({ kind: "construct", node: null, phase: 0, scope: this.rootScope, valuesBase: 0, ctor, args, isNew: true, newTarget }));
	}

	// --- fibers: generators & async (machine suspension, ASSIGNMENT §3) -------

	/** Build a suspended execution context (a "fiber") seeded with a call frame, without running it. */
	private seedFiber(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Fiber {
		const ctx = this.saveContext();
		this.frames = [];
		this.values = [];
		this.signal = null;
		this.finished = false;
		this.paused = false;
		this.pushCall(meta, args, thisArg);
		// FunctionDeclarationInstantiation — parameter binding (defaults, destructuring) and hoisting —
		// happens at CALL time, before the generator object / promise exists (spec). Run the call frame's
		// phase 0 and the parameter frame it pushes above the body to completion now (it cannot suspend:
		// a `yield`/`await` in a parameter is an early error); a throw there surfaces at the call site.
		this.step();
		// Step until the parameter frame is gone: on completion, or by a throw unwinding it (a `return`
		// inside a default's nested function is consumed by that function's own call frame on the way).
		const bodyDepth = this.frames.length - (this.top?.kind === "pattern" ? 1 : 0);
		while (this.frames.length > bodyDepth) this.step();
		const signal = this.signal as Signal | null; // (asserted: TS keeps the pre-step `null` narrowing)
		if (signal !== null) {
			this.restoreContext(ctx);
			if (signal.type === "throw") throw signal.value;
			throw new TsvalInternalError(`unexpected ${signal.type} while binding parameters`);
		}
		const fiber: Fiber = { frames: this.frames, values: this.values, signal: null, done: false, started: false };
		this.restoreContext(ctx);
		return fiber;
	}

	/**
	 * Run a fiber until it next suspends (`yield`/`await`) or completes. `input` is fed to the
	 * suspension point on resume: `next` supplies the value the `yield`/`await` produces; `return`/
	 * `throw` inject that signal at the suspension point. Returns `{ paused, value }` — `value` is the
	 * pause payload when paused, or the fiber's completion value when done.
	 */
	private stepFiber(fiber: Fiber, input: FiberInput): { paused: boolean; kind?: "yield" | "await"; value: unknown; raw?: boolean } {
		const ctx = this.saveContext();
		this.frames = fiber.frames;
		this.values = fiber.values;
		this.signal = fiber.signal;
		this.finished = false;
		this.paused = false;
		this.pauseKind = undefined;
		this.pauseRaw = false;
		this.sentValue = undefined;

		if (fiber.started) {
			if (input.kind === "next") this.sentValue = input.value;
			else {
				// A `yield*` suspended on its inner iterator intercepts `throw`/`return` to forward them
				// (spec delegation); anything else is injected as a signal at the suspension point.
				const top = this.top;
				if (top !== undefined && top.kind === undefined && top.delegating === true) top.received = { kind: input.kind, value: input.value };
				else this.signal = { type: input.kind, value: input.value };
			}
		}
		fiber.started = true;

		try {
			while (!this.finished && !this.paused) this.step();
			if (this.paused) return { paused: true, kind: this.pauseKind, value: this.pauseValue, raw: this.pauseRaw };
			return { paused: false, value: this.values.pop() };
		} finally {
			fiber.frames = this.frames;
			fiber.values = this.values;
			fiber.signal = this.signal;
			this.restoreContext(ctx);
		}
	}

	/** Create a guest generator object (lazy: the body runs on `.next()`). */
	createGenerator(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Iterator<unknown> & Iterable<unknown> {
		const fiber = this.seedFiber(meta, thisArg, args);
		const vm = this;
		const resume = (input: FiberInput): IteratorResult<unknown> => {
			if (fiber.done) {
				if (input.kind === "throw") throw input.value;
				return { value: input.kind === "return" ? input.value : undefined, done: true };
			}
			// `return`/`throw` on a suspended-start generator completes it without running the body.
			if (!fiber.started && input.kind !== "next") {
				fiber.done = true;
				if (input.kind === "throw") throw input.value;
				return { value: input.value, done: true };
			}
			const { paused, kind, value, raw } = vm.stepFiber(fiber, input);
			if (paused) {
				if (kind !== "yield") throw new TsvalInternalError("await inside a (non-async) generator");
				return raw === true ? (value as IteratorResult<unknown>) : { value, done: false };
			}
			fiber.done = true;
			return { value, done: true };
		};
		const gen = generatorObject(this.generatorPrototype(meta, false), {
			next: (v?: unknown) => resume({ kind: "next", value: v }),
			return: (v?: unknown) => resume({ kind: "return", value: v }),
			throw: (e?: unknown) => resume({ kind: "throw", value: e }),
		}) as Iterator<unknown> & Iterable<unknown>;
		Object.defineProperty(gen, FIBER_BRAND, { value: true }); // non-cloneable: forks share the fiber
		return gen;
	}

	/** Invoke a guest async function: returns a real Promise, driven by `await` suspensions. */
	callAsync(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Promise<unknown> {
		// An abrupt completion while binding an async function's parameters rejects the returned
		// promise (spec) — unlike generators, whose call throws synchronously.
		let fiber: Fiber | undefined;
		let seedError: unknown;
		try {
			fiber = this.seedFiber(meta, thisArg, args);
		} catch (error) {
			if (isUncatchable(error)) throw error;
			seedError = error;
		}
		const promise = new this.realm.Promise<unknown>((resolve, reject) => {
			if (fiber === undefined) return void reject(seedError);
			const drive = (input: FiberInput): void => {
				const f = fiber as Fiber;
				let result: { paused: boolean; kind?: "yield" | "await"; value: unknown };
				try {
					result = this.stepFiber(f, input);
				} catch (error) {
					f.done = true;
					reject(error);
					return;
				}
				if (!result.paused) {
					f.done = true;
					resolve(result.value);
					return;
				}
				if (result.kind !== "await") {
					f.done = true;
					reject(new TsvalInternalError("yield inside an async (non-generator) function"));
					return;
				}
				// Suspended on `await result.value`; resume when it settles.
				Promise.resolve(result.value).then(
					(v) => drive({ kind: "next", value: v }),
					(e) => {
						// An uncatchable error (interpreter bug, a host's abort) that rejected an awaited promise
						// must not be injected as a guest `throw` — guest try/catch could swallow it.
						if (isUncatchable(e)) {
							f.done = true;
							reject(e);
						} else drive({ kind: "throw", value: e });
					},
				);
			};
			drive({ kind: "next", value: undefined });
		});
		this.onAsyncFiber?.(promise);
		return promise;
	}

	/**
	 * Invoke a guest `async function*`: an async iterator whose `next/return/throw` return Promises.
	 * The fiber may suspend on `await` (drive on: settle, resume, keep stepping) or on `yield` (settle
	 * the pending `next()` with `{value, done:false}`; the yielded value is itself awaited, per spec).
	 * Requests are serialized through a promise chain, as the spec's request queue requires.
	 */
	createAsyncGenerator(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): AsyncIterator<unknown> & AsyncIterable<unknown> {
		const fiber = this.seedFiber(meta, thisArg, args);
		const drive = (input: FiberInput): Promise<IteratorResult<unknown>> => {
			if (fiber.done) {
				if (input.kind === "throw") return Promise.reject(input.value);
				return Promise.resolve({ value: input.kind === "return" ? input.value : undefined, done: true });
			}
			if (!fiber.started && input.kind !== "next") {
				fiber.done = true; // suspended-start: complete without running the body
				return input.kind === "throw" ? Promise.reject(input.value) : Promise.resolve({ value: input.value, done: true });
			}
			let result: { paused: boolean; kind?: "yield" | "await"; value: unknown };
			try {
				result = this.stepFiber(fiber, input);
			} catch (error) {
				fiber.done = true;
				return Promise.reject(error);
			}
			if (!result.paused) {
				fiber.done = true;
				return Promise.resolve({ value: result.value, done: true });
			}
			if (result.kind === "await") {
				return Promise.resolve(result.value).then(
					(v) => drive({ kind: "next", value: v }),
					(e) => {
						if (isUncatchable(e)) {
							fiber.done = true;
							return Promise.reject(e);
						}
						return drive({ kind: "throw", value: e });
					},
				);
			}
			// `yield v` in an async generator awaits v; a rejection is a *throw at the yield*, which the
			// body may catch — not a rejection of the pending `next()`.
			return Promise.resolve(result.value).then(
				(v) => ({ value: v, done: false }),
				(e) => drive({ kind: "throw", value: e }),
			);
		};
		// AsyncGeneratorResumeNext: a request against a *suspended* generator runs the body synchronously
		// up to its next suspension (observable: a side effect in the body is visible right after
		// `.next()` returns); requests arriving while it's executing queue behind, in order.
		const queue: { input: FiberInput; resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void }[] = [];
		let busy = false;
		const pump = (): void => {
			if (busy || queue.length === 0) return;
			busy = true;
			const request = queue.shift()!;
			drive(request.input).then(
				(result) => {
					busy = false;
					request.resolve(result);
					pump();
				},
				(error) => {
					busy = false;
					request.reject(error);
					pump();
				},
			);
		};
		const enqueue = (input: FiberInput): Promise<IteratorResult<unknown>> => {
			const request = new this.realm.Promise<IteratorResult<unknown>>((resolve, reject) => {
				queue.push({ input, resolve, reject });
				pump();
			});
			this.onAsyncFiber?.(request);
			return request;
		};
		const gen = generatorObject(this.generatorPrototype(meta, true), {
			next: (v?: unknown) => enqueue({ kind: "next", value: v }),
			return: (v?: unknown) => enqueue({ kind: "return", value: v }),
			throw: (e?: unknown) => enqueue({ kind: "throw", value: e }),
		}) as AsyncIterator<unknown> & AsyncIterable<unknown>;
		Object.defineProperty(gen, FIBER_BRAND, { value: true });
		return gen;
	}

	/** OrdinaryCreateFromConstructor for a generator object: the function's own `.prototype` if it is an
	 *  object, else the realm's %GeneratorPrototype% / %AsyncGeneratorPrototype%. */
	private generatorPrototype(meta: GuestFunctionMeta, isAsync: boolean): object {
		const declared = (meta.self as { prototype?: unknown } | undefined)?.prototype;
		if ((typeof declared === "object" && declared !== null) || typeof declared === "function") return declared;
		return isAsync ? this.realm.AsyncGeneratorPrototype : this.realm.GeneratorPrototype;
	}

	/** Push a synthetic call frame for a guest function. */
	pushCall(meta: GuestFunctionMeta, args: unknown[], thisArg: unknown, newTarget?: unknown): CallFrame {
		const frame: CallFrame = {
			kind: "call",
			node: meta.node,
			phase: 0,
			scope: meta.closure, // real scope built in phase 0
			valuesBase: this.values.length,
			meta,
			args,
			thisArg,
			newTarget,
		};
		this.frames.push(frame);
		return frame;
	}
}

function isStatement(node: ts.Node): boolean {
	return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement;
}

/** True for the `prototype` object of a guest class (its own `constructor` is a branded guest class). */
function isGuestClassPrototype(v: object): boolean {
	const ctor = Object.getOwnPropertyDescriptor(v, "constructor")?.value as { prototype?: unknown } | undefined;
	return isGuestClass(ctor) && ctor.prototype === v;
}

/** A full snapshot of the machine's mutable execution state, for nested sub-runs and fibers. */
interface ExecContext {
	frames: Frame[];
	values: unknown[];
	signal: Signal | null;
	finished: boolean;
	paused: boolean;
	pauseKind: "yield" | "await" | undefined;
	pauseValue: unknown;
	pauseRaw: boolean;
	sentValue: unknown;
}

/** A suspendable execution context — the backing store for a generator or async function. */
interface Fiber {
	frames: Frame[];
	values: unknown[];
	signal: Signal | null;
	done: boolean;
	started: boolean;
}

/** How a fiber is resumed: with a value, or by injecting a return/throw at the suspension point. */
type FiberInput = { kind: "next"; value: unknown } | { kind: "return"; value: unknown } | { kind: "throw"; value: unknown };
