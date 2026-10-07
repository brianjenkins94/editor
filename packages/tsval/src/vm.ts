import type { EventLoopOptions, Loop } from "./event-loop.ts";
import type { AsyncFrame, CallFrame, Frame, Iteration, NodeFrame, SyntheticFrame, SyntheticKind } from "./frame.ts";
import type { GuestClass } from "./handlers.ts";
import type { GuestFunction, GuestFunctionMeta } from "./values.ts";
import ts from "typescript";
import { isUncatchable, TsvalInternalError } from "./errors.ts";
import type { Choice, Result } from "./event-loop.ts";
import { arrived, choose, createLoop, forkLoop, hasRefTimers, INTRINSICS, loopGlobals, nextTimer, takeTimer, timerLabel, waitForTurn } from "./event-loop.ts";
import { syntaxKindName } from "./frontend.ts";
import { standardGlobals } from "./globals.ts";
import { bindIdentifier, bindingProgram, clonePrivateElements, closeIteration, createGuestFunction, isGuestClass, nodeHandlers, pushPattern, syntheticHandlers } from "./handlers.ts";
import { Scope } from "./scope.ts";
import { isGuestFunction } from "./values.ts";

/** Statements whose completion is UpdateEmpty(body, undefined): they yield `undefined` when their body produced nothing. */
const COMPLETION_STATEMENTS = new Set<number>([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.SwitchStatement]);

/** Brand marking a live generator/async fiber object as non-cloneable (shared across forks). */
export const FIBER_BRAND = Symbol("tsval.fiber");

/** The guest realm's constructors plus the function-family intrinsics guest functions are built from. */
export interface Realm {
	"Array": ArrayConstructor;
	"Object": ObjectConstructor;
	"RegExp": RegExpConstructor;
	"Function": FunctionConstructor;
	"Promise": PromiseConstructor;
	/** %GeneratorFunction.prototype% — [[Prototype]] of every `function*`. */
	"GeneratorFunctionPrototype": object;
	/** %GeneratorFunction.prototype.prototype% — what a `function*`'s own `.prototype` inherits from. */
	"GeneratorPrototype": object;
	"AsyncGeneratorFunctionPrototype": object;
	"AsyncGeneratorPrototype": object;
	/** %AsyncFunction.prototype% — [[Prototype]] of every `async function`. */
	"AsyncFunctionPrototype": object;
	/** `Array.prototype.values` (= `@@iterator`), %ArrayIteratorPrototype% and its pristine `next`: an
	 *  array whose iteration is untouched is iterated through a cloneable record (see getIterator). */
	"arrayValues": unknown;
	"arrayIteratorPrototype": { "next"?: unknown };
	"arrayIteratorNext": unknown;
}

/**
 * Complete a realm with its generator/async intrinsics. In the process realm they are the real ones.
 * In a foreign realm (`globalObject` from `node:vm`) none of them is reachable from the globals
 * without evaluating code there, so stand-ins are built with the right shape and parentage
 * (%IteratorPrototype% IS reachable, through an array iterator).
 */
function makeRealm(base: Pick<Realm, "Array" | "Object" | "RegExp" | "Function" | "Promise">): Realm {
	const arrayValues = base.Array.prototype.values;
	const arrayIteratorPrototype = Object.getPrototypeOf(arrayValues.call(new base.Array())) as { "next"?: unknown };
	const arrays = { "arrayValues": arrayValues, "arrayIteratorPrototype": arrayIteratorPrototype, "arrayIteratorNext": arrayIteratorPrototype.next };

	if (base.Function === Function) {
		const genFnProto = Object.getPrototypeOf(function *() { /* probe: only its prototype is read */ }) as { "prototype": object };
		const asyncGenFnProto = Object.getPrototypeOf(async function *() { /* probe: only its prototype is read */ }) as { "prototype": object };

		return { ...base, ...arrays, "GeneratorFunctionPrototype": genFnProto, "GeneratorPrototype": genFnProto.prototype, "AsyncGeneratorFunctionPrototype": asyncGenFnProto, "AsyncGeneratorPrototype": asyncGenFnProto.prototype, "AsyncFunctionPrototype": Object.getPrototypeOf(async function() { /* probe: only its prototype is read */ }) as object };
	}

	const objectCtor = base.Object;
	const iteratorPrototype = Object.getPrototypeOf(arrayIteratorPrototype) as object;
	const asyncIteratorPrototype = objectCtor.create(objectCtor.prototype) as object;

	Object.defineProperty(asyncIteratorPrototype, Symbol.asyncIterator, {
		"value": function(this: unknown) {
			return this;
		},
		"writable": true,
		"configurable": true
	});
	const family = (functionTag: string, parent: object, tag: string): { "fnProto": object; "proto": object } => {
		const fnProto = objectCtor.create(base.Function.prototype) as object;
		const proto = objectCtor.create(parent) as object;

		Object.defineProperty(fnProto, "prototype", { "value": proto, "configurable": true });
		Object.defineProperty(fnProto, Symbol.toStringTag, { "value": functionTag, "configurable": true });
		Object.defineProperty(proto, "constructor", { "value": fnProto, "configurable": true });
		Object.defineProperty(proto, Symbol.toStringTag, { "value": tag, "configurable": true });

		return { "fnProto": fnProto, "proto": proto };
	};

	const gen = family("GeneratorFunction", iteratorPrototype, "Generator");
	const asyncGen = family("AsyncGeneratorFunction", asyncIteratorPrototype, "AsyncGenerator");
	const asyncFnProto = objectCtor.create(base.Function.prototype) as object;

	Object.defineProperty(asyncFnProto, Symbol.toStringTag, { "value": "AsyncFunction", "configurable": true });

	return { ...base, ...arrays, "GeneratorFunctionPrototype": gen.fnProto, "GeneratorPrototype": gen.proto, "AsyncGeneratorFunctionPrototype": asyncGen.fnProto, "AsyncGeneratorPrototype": asyncGen.proto, "AsyncFunctionPrototype": asyncFnProto };
}

/** A generator object: inherits from `proto` (the function's `.prototype`), with its resumption
 *  methods as non-enumerable own properties (the fiber lives in their closures). */
function generatorObject(proto: object, methods: Record<string, (...args: never[]) => unknown>): object {
	const gen = Object.create(proto) as object;

	for (const [name, value] of Object.entries(methods)) {
		Object.defineProperty(gen, name, { "value": value, "writable": true, "configurable": true });
	}

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
export type { CallFrame, ConstructFrame, Frame, InitFieldsFrame, NodeFrame, PatternFrame, SyntheticFrame } from "./frame.ts";

export type Signal =
	| { "type": "return"; "value": unknown }
	| { "type": "throw"; "value": unknown }
	| { "type": "break"; "label"?: string }
	| { "type": "continue"; "label"?: string };

export type NodeHandler = (vm: Machine, frame: NodeFrame) => void;
/** One handler per synthetic frame kind, each receiving its own frame type. */
export type SyntheticHandlers = { [Kind in SyntheticKind]: (vm: Machine, frame: Extract<SyntheticFrame, { "kind": Kind }>) => void };

export interface VMOptions {
	/** Injected globals — what a host adds to (or replaces in) the global object. */
	"globals"?: Record<string, unknown>;
	/** Use this object *as* the global object (not copied — a fresh realm's `globalThis`, whose
	 *  builtins are non-enumerable, or a host's own global table). `globals` are then layered on top of
	 *  it. Default: a fresh table of ECMAScript's standard built-ins and nothing of the host's
	 *  (`standardGlobals()`). */
	"globalObject"?: Record<string, unknown>;
	/** Fall back to the host's real `globalThis` for names the global object lacks. Default FALSE: a
	 *  program sees only what it was given. The differential oracle sets it true for parity with Node. */
	"realGlobals"?: boolean;
	/** Resolve a module specifier to its namespace object (for `import` / dynamic `import()`). This is
	 *  the seam through which a host supplies (or replaces) modules. */
	"resolveModule"?: (specifier: string) => unknown;
	/** Top-level `this`. Default `undefined` (module semantics — the supported surface); a *script*
	 *  runner (test262) passes the global object. */
	"thisValue"?: unknown;
	/** Guard at the host↔guest boundary: sanitize values entering guest land and vet host callables.
	 *  This is how a sandbox stays closed — real intrinsics leak the real `Function` via
	 *  `.constructor.constructor`, and only the interpreter sees every read and every call. */
	"hostGuard"?: HostGuard;
	/** Notified with the Promise of every async guest function invoked, so a driver can track
	 *  outstanding async work (a host that must observe every effect awaits it). */
	"onAsyncFiber"?: (promise: Promise<unknown>) => void;
	/** Run async code on the main stack, steppable — a debugger's stepping, breakpoints and forks reach into it. An async
	 *  function runs until its first `await`, where its frames are cut off as a pending fiber; when what it awaited
	 *  settles, the fiber is a job the machine resumes once its stack is empty (between jobs, in the order they
	 *  settled). A guest callback a host promise calls (`then`/`catch`/`finally`) is a job too. With work pending and
	 *  none ready the machine is `idle`: its host lets the event loop turn (`whenSettled`), then steps on. A top-level
	 *  `await` suspends the program the same way. Off by default: fibers run on the host's promise queue, each to its
	 *  next suspension at once, out of the host's sight. */
	"steppedAsync"?: boolean;
	/** Stepped async with an event loop of its own, deterministic (event-loop.ts): timers (`setTimeout`, `setInterval`,
	 *  `setImmediate`, their clears, `queueMicrotask`) as steppable jobs ordered on a virtual clock, which `Date` reads,
	 *  and a seeded `Math.random` — the same run every time from the same start (`now`, `seed`), and so for every fork.
	 *  `pace`: whether a timer waits its real delay (`"real"`, the default) or none (`"fast"`). Implies `steppedAsync`. */
	"eventLoop"?: EventLoopOptions;
	/** Called at each breakpoint reached DURING a synchronous host-invoked guest call (a host callback such
	 *  as a React event handler running through `callGuestFromHost` → `runSub`). Top-level stepping is driven
	 *  by the host through `step`/`runToBreakpoint`, but a host→guest call runs a nested loop the host can't
	 *  drive — this hook is where a debugger regains control there (it may block, e.g. Atomics.wait, and read
	 *  machine state before returning to resume). Fires just before the breakpointed statement executes. */
	"onBreakpoint"?: (vm: VM) => void;
	/** A fuel limit: once `steps` exceeds this, the next `step()` throws an uncatchable error (guest try/catch
	 *  can't swallow it). Lets a host run untrusted code with a bounded cost — e.g. a language-server-resident
	 *  driver that must never hang on a `while (true)`. Default undefined = unlimited (existing behavior). */
	"maxSteps"?: number;
	/** Count how often each statement runs (see `VM.coverage`). Off by default: it's one map update per statement. */
	"coverage"?: boolean;
	/** Told what went through a few chosen sites as the program runs — the facts runtime evidence keeps of values,
	 *  branches and types. Off by default: one check per site when it's off. See `ObserveSite` for each site's node
	 *  and value. The callback must not run guest code (read values with `typeTag`, which never does). */
	"observe"?: Observer;
	/** Told each value a statement bound, returned or chose, in order, with which call and loop iteration it was in —
	 *  what a debugger shows beside each line (a live-values panel). Off by default. See `TraceEvent`. The callback
	 *  must not run guest code. */
	"trace"?: Tracer;
}

/**
 * A traced value (VMOptions.trace):
 * - `bind`: a name's new value — a declaration's (`const x = …`, an identifier only; a pattern's names each), an
 *   assignment's (`x = …`, `o.p += …`, `i++`: the target as written), a `for…of`/`for…in` identifier's each turn, and a
 *   guest function's parameters on entry (identifiers without a default).
 * - `return`: a `return` statement's value (`name` is `return`).
 * - `branch`: an `if`'s arm — 0 its then, 1 its else (`name` is `if`).
 *
 * `node` is the declaration, the assignment, the loop, the parameter, the statement: its line is the value's. `call`
 * numbers the guest call it ran in, in the order calls are made (0: the program's top level), and `callee` is that
 * call's function (none at the top level, or in a constructor); `loops` are the loops around it in that call, outermost
 * first, each with its turn (from 0); `step` is the machine's step count.
 */
export interface TraceEvent {
	"kind": "bind" | "return" | "branch";
	"node": ts.Node;
	"name": string;
	"value": unknown;
	"step": number;
	"call": number;
	"callee"?: ts.Node;
	"loops": { "node": ts.Node; "turn": number }[];
}

export type Tracer = (event: TraceEvent) => void;

/**
 * The sites `observe` is told about, with the node it's given and what `value` is:
 * - `optional`: `a?.b`, `a?.[k]` (the member expression) and `a?.()` (the call) — the value of `a` where the chain
 *   tests it (nullish: the chain stopped). Not told when an earlier link already stopped the chain.
 * - `nullish`: `a ?? b` (the binary expression) — the value of `a` (nullish: the right side ran).
 * - `branch`: an `if` statement, a conditional expression, and `a && b` / `a || b` (the binary expression) — which
 *   arm ran, as a number: 0 for the `if`'s then (or the condition's true side), 1 for its else (run or not);
 *   0 when the logical expression's right side ran, 1 when it didn't.
 * - `parameter`: each parameter declaration without a default or a pattern of a guest function called — the argument
 *   passed for it (undefined when none was), or the array a rest parameter collects.
 * - `return`: a `return` statement, or an arrow function with an expression body (the arrow itself: its body may be a
 *   site of its own) — the value returned.
 *
 * Each node is told about as one site only, so a host can key what it keeps by node.
 */
export type ObserveSite = "optional" | "nullish" | "branch" | "parameter" | "return";

export type Observer = (node: ts.Node, site: ObserveSite, value: unknown) => void;

/**
 * The host-boundary guard (see `VMOptions.hostGuard`). Both hooks default to identity.
 * - `sanitize(value)`: applied to every value that crosses from host land into guest land — property/
 *   element reads, host call & construct results, imported bindings, destructured host properties.
 *   Return a replacement (e.g. a stand-in for the real `Function`) or the value unchanged.
 * - `beforeCall(callee, thisArg, isConstruct, site)`: applied before the interpreter invokes a host
 *   callable; return the callable to actually invoke. `thisArg` lets it vet `Function.prototype.call/
 *   apply/bind` applied to a forbidden target; `site` says where and how the call was made — the
 *   callsite node and the evaluated arguments. (The static types at the site are the typed layer's
 *   business — `./typed` wraps a guard and enriches the site; the VM itself knows no checker.)
 */
export interface HostGuard {
	"sanitize"?: (value: unknown) => unknown;
	"beforeCall"?: (callee: (...args: unknown[]) => unknown, thisArg: unknown, isConstruct: boolean, site: HostCallSite) => (...args: unknown[]) => unknown;
}

/** Where a host callable is being invoked from, and with what. */
export interface HostCallSite {
	/** the call / `new` / tagged-template expression. */
	"node": ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;
	/** the arguments as evaluated (after spread), in order. */
	"args": readonly unknown[];
	"isConstruct": boolean;
}

/**
 * The host-facing VM: what `createVM` / `createTypedVM` / `new VM()` hand out — stepping, running,
 * breakpoints, forking, the host seams, and read access to the machine state. Everything the
 * handlers need beyond this lives on `Machine` (the implementation) and is not part of the API.
 */
export interface VM {
	/** The loaded program (kept for source-position lookups: `location`, breakpoints). */
	readonly "sourceFile": ts.SourceFile | undefined;
	"load": (sourceFile: ts.SourceFile) => void;

	// --- running ---
	/** Exactly one unit of work on the top frame — the primitive everything else is built on. */
	"step": () => void;
	/** Run to completion; returns the program's completion value. */
	"run": () => unknown;
	/** Run, driving top-level `await` (the main body is itself a suspendable fiber). */
	"runAsync": () => Promise<unknown>;
	/** Step until the predicate holds (checked at every step), or the program finishes/pauses. */
	"runUntil": (predicate: (vm: VM) => boolean) => void;
	/** Run to the next statement boundary. */
	"stepStatement": () => void;
	"atStatementBoundary": () => boolean;
	/** The completion value so far (script semantics: the last value-producing statement's value). */
	readonly "completion": unknown;
	readonly "finished": boolean;
	/** Suspended at a `yield`/`await` (resume with `runAsync`). */
	readonly "paused": boolean;
	/** Stepped async (VMOptions.steppedAsync): work pending and none ready — await `whenSettled`, then step on. */
	readonly "idle": boolean;
	/** Resolves when something pending settles (stepped async). */
	"whenSettled": () => Promise<void>;
	/** The choices its event loop made so far (VMOptions.eventLoop), in order — `picked` of each is a schedule to run it
	 *  again (EventLoopOptions.schedule). Empty without one. */
	readonly "choices": readonly Choice[];
	/** Its event loop (VMOptions.eventLoop): the clock, the timers pending, the results waiting, the pace — undefined
	 *  without one. A host may set `pace`. */
	readonly "loop": Loop | undefined;
	/** Monotonic count of `step()` calls — a free step budget. */
	readonly "steps": number;

	// --- position, breakpoints ---
	readonly "currentNode": ts.Node | null;
	"location": (node?: ts.Node | null) => { "line": number; "character": number; "pos": number } | null;
	/** Where a value escaping the run uncaught was first thrown (null for a primitive, or one not thrown here). */
	"throwSite": (value: unknown) => ts.Node | null;
	readonly "breakpoints": Set<number>;
	"addBreakpoint": (pos: number) => void;
	"addBreakpointsByLine": (...lines: number[]) => void;
	"atBreakpoint": () => boolean;
	"runToBreakpoint": () => void;

	/** How often each statement has run, when created with `coverage: true` (undefined otherwise) — exact, not
	 *  sampled: every statement execution passes through `step()`. A fork carries its own copy, so a fork's counts
	 *  are its own timeline's. Statements that never ran are absent. */
	readonly "coverage": ReadonlyMap<ts.Node, number> | undefined;

	/** An independent copy of the machine state (mid-expression if need be); host objects are shared. */
	"fork": () => VM;

	/** The call/`new`/tagged-template expression currently invoking a host callable — set only around
	 *  the host `apply`/`construct`, so a host function can introspect its own callsite. */
	readonly "callSite": ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression | undefined;

	// --- inspection (plain data; read, don't mutate) ---
	/** control stack: frames, top at the end. */
	readonly "frames": readonly Frame[];
	/** operand stack: sub-expression results. */
	readonly "values": readonly unknown[];
	/** a propagating non-local control transfer (return/throw/break/continue) being unwound. */
	readonly "signal": Signal | null;
	readonly "top": Frame | undefined;
	readonly "rootScope": Scope;
}

/**
 * The stepped, stack-based machine (a CEK/CESK-style explicit-continuation-stack walker) — the
 * implementation behind `VM`, and the full surface the handlers program against: the operand and
 * control stacks, frame/signal pushing, the realm, the host seams, fiber drivers.
 *
 * `step()` does exactly one unit of work on the top frame. Everything else — `run`, `stepStatement`,
 * `runUntil`, control flow, calls — is built on that single primitive (ASSIGNMENT §3).
 */
export class Machine implements VM {
	/** operand stack: sub-expression results. */
	public values: unknown[] = [];
	/** control stack: frames, top at the end. */
	public frames: Frame[] = [];
	public rootScope: Scope;
	/** a propagating non-local control transfer (return/throw/break/continue) being unwound. */
	public signal: Signal | null = null;
	/** The program's completion value (script/`eval` semantics): the last value-producing statement's
	 *  value, where a compound statement (`if`, a loop, `try`, `switch`) that produced none yields
	 *  `undefined` (the spec's UpdateEmpty). Statements inside functions never contribute. */
	public completion: unknown = undefined;
	/** bumped on every completion-value write; a compound statement compares it to know whether its body produced one. */
	public completionSerial = 0;
	public finished = false;
	/** monotonic count of `step()` calls — a free step budget (ASSIGNMENT §3). */
	public steps = 0;
	/** set by a `yield`/`await` handler to suspend the current fiber (generator/async). */
	public paused = false;
	/** which kind of suspension: an async generator can do both, and its driver must know. */
	public pauseKind: "yield" | "await" | undefined = undefined;
	/** the value carried out of a suspension point: the yielded value, or the awaited operand. */
	public pauseValue: unknown = undefined;
	/** a sync `yield*` yields the inner iterator's *result object* as-is (spec GeneratorYield(innerResult));
	 *  the driver must not re-wrap it. */
	public pauseRaw = false;
	/** the value fed back in on resume (the `.next(v)` argument / the resolved awaited value). */
	public sentValue: unknown = undefined;

	/** Module resolver for `import` / dynamic `import()` (the host's module seam). */
	public resolveModule: ((specifier: string) => unknown) | undefined;
	/** The call/new expression currently invoking a host callable — lets a host function introspect its
	 *  callsite (with `./typed`, the static type of its argument). Set only around the host
	 *  `apply`/`construct`. */
	public callSite: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression | undefined;
	public hostGuard: HostGuard | undefined;
	public onAsyncFiber: ((promise: Promise<unknown>) => void) | undefined;
	public onBreakpoint: ((vm: VM) => void) | undefined;
	/** VMOptions.steppedAsync. */
	public steppedAsync = false;
	/** VMOptions.eventLoop: this machine's event loop — its clock, timers and random generator (a fork copies it). */
	public loop: Loop | undefined;

	public get choices(): readonly Choice[] {
		return this.loop?.choices ?? [];
	}
	/** Stepped async: work pending and none ready — the host lets the event loop turn (`whenSettled`), then steps on. */
	public idle = false;
	/** Stepped async: this machine's suspended fibers, and the host-called callbacks waiting their turn, by id — its own
	 *  (a fork copies them, so each timeline resumes its own). */
	private pending = new Map<number, Pending>();
	/** Stepped async: what settled, in the order it did — shared with forks (a host promise calls back once, into it). */
	private scheduler: AsyncScheduler = { "settled": [], "ids": 0, "wakers": [] };
	/** How many nested contexts (a host-called guest function's sub-run, a fiber's) the machine is inside: stepped
	 *  async applies on the main stack only (depth 0); a nested context keeps the fiber drivers' behavior. */
	private depth = 0;
	/** Fuel limit (see VMOptions.maxSteps): once `steps` passes it, `step()` throws uncatchably. */
	public maxSteps: number | undefined;
	/** Statement execution counts (VMOptions.coverage). */
	public coverage: Map<ts.Node, number> | undefined;
	/** What chosen sites are told to (VMOptions.observe). */
	public observe: Observer | undefined;
	/** What each value bound, returned or chosen is told to (VMOptions.trace). */
	public trace: Tracer | undefined;
	/** How many calls and constructions have been made: the last one's number (FrameBase.call). */
	public calls = 0;

	/** The guest realm's Error constructors, so errors tsval itself throws (ReferenceError on an
	 *  unbound name, TypeError on a bad call, …) are instances of the *guest's* classes. Resolved
	 *  from the global object; falls back to this realm's. */
	public readonly guestErrors: Record<string, new (message?: string) => Error>;
	/** The guest realm's constructors used to *create* guest values (literals, rest arrays, class
	 *  prototypes, function prototypes), so `[] instanceof Array` and `Object.getPrototypeOf({})`
	 *  agree with the guest's own intrinsics when the global object is another realm's. */
	public readonly realm: Realm;
	/** The loaded program, kept for source-position lookups (breakpoints, `location`). */
	public sourceFile: ts.SourceFile | undefined;
	/** Breakpoints, as node start positions (see `addBreakpoint` / `addBreakpointsByLine`). */
	public readonly breakpoints = new Set<number>();
	/** Where each thrown value was first thrown — the node its throw started from — so a host that gets it uncaught (the
	 *  frames unwound by then) can say where the program crashed. A rethrow keeps the first, as a stack trace would; a
	 *  primitive thrown has none. */
	private readonly throwSites = new WeakMap<object, ts.Node>();

	public constructor(options: VMOptions = {}) {
		this.rootScope = new Scope(undefined, true);
		if (options.globalObject !== undefined) {
			const base = options.globalObject;

			for (const [name, value] of Object.entries(options.globals ?? {})) {
				base[name] = value;
			}

			this.rootScope.globalObject = base;
		} else {
			this.rootScope.globalObject = Object.assign(options.realGlobals === true ? { "undefined": undefined, "NaN": NaN, "Infinity": Infinity } : standardGlobals(), options.globals ?? {});
		}

		const globals = this.rootScope.globalObject;

		// The event loop's timers, clock and random generator, over any the host gave: they're what makes it deterministic.
		if (options.eventLoop !== undefined) {
			this.loop = createLoop(options.eventLoop);
			Object.assign(globals, loopGlobals());
		}

		this.guestErrors = {};
		for (const name of ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError"]) {
			const ctor = (globals[name] ?? (globalThis as Record<string, unknown>)[name]) as new (message?: string) => Error;

			if (typeof ctor === "function") {
				this.guestErrors[name] = ctor;
			}
		}

		const pick = (name: string): unknown => (typeof globals[name] === "function" ? globals[name] : (globalThis as Record<string, unknown>)[name]);
		const realmObject = pick("Object") as ObjectConstructor;
		// The realm's *intrinsic* Function is reached through Object (a global named `Function` may be
		// a host's stand-in, e.g. an eval guard); it's what guest function objects are created from.
		const realmFunction = (realmObject as unknown as { "constructor": FunctionConstructor }).constructor;

		this.realm = makeRealm({ "Array": pick("Array") as ArrayConstructor, "Object": realmObject, "RegExp": pick("RegExp") as RegExpConstructor, "Function": typeof realmFunction === "function" ? realmFunction : Function, "Promise": pick("Promise") as PromiseConstructor });
		this.rootScope.hasThis = true;
		this.rootScope.thisVal = options.thisValue;
		this.rootScope.realGlobals = options.realGlobals ?? false;
		this.resolveModule = options.resolveModule;
		this.hostGuard = options.hostGuard;
		this.onAsyncFiber = options.onAsyncFiber;
		this.onBreakpoint = options.onBreakpoint;
		this.steppedAsync = options.steppedAsync === true || options.eventLoop !== undefined;
		this.maxSteps = options.maxSteps;
		this.coverage = options.coverage === true ? new Map() : undefined;
		this.observe = options.observe;
		this.trace = options.trace;
	}

	/** The next call's number (FrameBase.call). */
	public nextCall(): number {
		this.calls += 1;

		return this.calls;
	}

	/** Tell the tracer (VMOptions.trace), if any, a value `node` bound, returned or chose: with the call it's in and the
	 *  turn of each loop around it there, read off the frame stack down to that call. */
	public traced(kind: TraceEvent["kind"], node: ts.Node, name: string, value: unknown): void {
		if (this.trace === undefined) {
			return;
		}

		const loops: TraceEvent["loops"] = [];
		let call = 0;
		let callee: ts.Node | undefined;

		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index]!;

			if (frame.kind === "call" || frame.kind === "construct") {
				call = frame.call ?? 0;
				callee = frame.node ?? undefined;
				break;
			}

			if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
				loops.unshift({ "node": frame.node, "turn": frame.turn });
			}
		}

		this.trace({ "kind": kind, "node": node, "name": name, "value": value, "step": this.steps, "call": call, ...callee === undefined ? {} : { "callee": callee }, "loops": loops });
	}

	public get top(): Frame | undefined {
		return this.frames[this.frames.length - 1];
	}

	/** The node the top frame is about to work on (or is working on), for inspection/UI. */
	public get currentNode(): ts.Node | null {
		return this.top?.node ?? null;
	}

	/** A value crossing from host land into guest land, passed through the guard (identity if none). */
	public fromHost(value: unknown): unknown {
		const sanitize = this.hostGuard?.sanitize;

		return sanitize === undefined ? value : sanitize(value);
	}

	/** Stepped async applies here: it's on, and this is the main stack (not a nested context). */
	public get steppedHere(): boolean {
		return this.steppedAsync && this.depth === 0;
	}

	/** Invoke a host callable from guest code, through the guard and with `callSite` exposed. */
	public invokeHost(callee: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[], site: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression, isConstruct: boolean): unknown {
		// The event loop's intrinsics act on this machine (event-loop.ts) — trusted, so ahead of the guard.
		const intrinsic = INTRINSICS.get(callee);

		if (intrinsic !== undefined) {
			return this.fromHost(intrinsic(this, thisArg, args, isConstruct));
		}

		const previousSite = this.callSite;
		const { prototype } = this.realm.Promise;

		const promising = callee === prototype.then || callee === prototype.catch || callee === prototype.finally;

		// Stepped async: a guest callback a host promise will call is a job of its own, run on the main stack.
		if (this.steppedHere && !isConstruct && promising) {
			args = args.map((arg) => (isGuestFunction(arg) ? this.deferCallback(arg) : arg));
		}

		this.callSite = site; // (set BEFORE the guard runs: a guard may read it, or the `site` argument)
		try {
			const target = this.hostGuard?.beforeCall === undefined ? callee : this.hostGuard.beforeCall(callee, thisArg, isConstruct, { "node": site, "args": args, "isConstruct": isConstruct });
			const result = isConstruct ? Reflect.construct(target as unknown as new (...ctorArgs: unknown[]) => unknown, args) : target.apply(thisArg, args);
			const value = this.fromHost(result);

			// Event loop: a promise a host call returns is external — when it settles isn't the program's to say. The
			// program gets one of its own instead, settled when the result's arrival is delivered as an event (event-loop.ts),
			// so nothing — not even Promise.race — sees it before. (Not a promise the program makes itself — `new Promise`,
			// a promise's methods and statics: that's the program chaining what it has.)
			if (this.loop !== undefined && this.steppedHere && !promising && (callee as unknown) !== this.realm.Promise && !PROMISE_STATICS.some((name) => (this.realm.Promise as unknown as Record<string, unknown>)[name] === callee) && isThenable(value)) {
				return this.awaitResult(value, this.callLabel(site, callee, args));
			}

			return value;
		} finally {
			this.callSite = previousSite;
		}
	}

	/** Resolve a module namespace, or throw a guest-catchable error if unresolved. */
	public importModule(specifier: string): unknown {
		const ns = this.resolveModule?.(specifier);

		if (ns === undefined) {
			throw new Error(`Cannot find module '${specifier}'`);
		}

		return ns;
	}

	/** Seat a parsed SourceFile as the initial frame. */
	public load(sourceFile: ts.SourceFile): void {
		this.sourceFile = sourceFile;
		this.pushNode(sourceFile, this.rootScope);
	}

	// --- frame / value helpers ------------------------------------------------

	public pushNode(node: ts.Node, scope: Scope): NodeFrame {
		const frame: NodeFrame = { "node": node, "phase": 0, "scope": scope, "valuesBase": this.values.length };

		this.frames.push(frame);

		return frame;
	}

	/** Statements inside a function (a call, a constructor, a field initializer / static block) never
	 *  contribute to the program's completion value. */
	public insideFunction(scope: Scope): boolean {
		for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
			if (current.isolated && current !== this.rootScope) {
				return true;
			}
		}

		return false;
	}

	/** Record a completion value (ExpressionStatement). */
	public setCompletion(value: unknown): void {
		this.completion = value;
		this.completionSerial += 1;
	}

	public pushFrame(frame: SyntheticFrame): void {
		this.frames.push(frame);
	}

	public push(value: unknown): void {
		this.values.push(value);
	}

	public pop(): unknown {
		return this.values.pop();
	}

	/** Raise a non-local control transfer; the next `step()` begins unwinding. */
	/** Raise `signal`; a throw notes `node` (the throw statement, say) as where its value was thrown. */
	public raise(signal: Signal, node: ts.Node | null = this.currentNode): void {
		if (signal.type === "throw") {
			this.noteThrow(signal.value, node);
		}

		this.signal = signal;
	}

	/** Where `value` was first thrown, if it was thrown here (and is an object): `location()` of it says the line. */
	public throwSite(value: unknown): ts.Node | null {
		return (typeof value === "object" && value !== null) || typeof value === "function" ? this.throwSites.get(value) ?? null : null;
	}

	private noteThrow(value: unknown, node: ts.Node | null): void {
		if (node !== null && ((typeof value === "object" && value !== null) || typeof value === "function") && !this.throwSites.has(value)) {
			this.throwSites.set(value, node);
		}
	}

	// --- the driver -----------------------------------------------------------

	/** Do exactly one unit of work. */
	public step(): void {
		if (this.finished) {
			return;
		}

		// Stepped async, between tasks (the stack empty): the next settled job, or idle while work is pending.
		if (this.steppedAsync && this.depth === 0 && this.frames.length === 0 && this.signal === null) {
			if (this.resumeSettled() || this.fireEvent()) {
				return;
			}

			if (this.pending.size > 0 || (this.loop !== undefined && (hasRefTimers(this.loop) || this.loop.results.size > 0))) {
				this.idle = true;

				return;
			}
		}

		const frame = this.top;

		if (frame === undefined) {
			// No frame left — but a signal may still be pending (a handler that pops itself *before*
			// throwing, e.g. an Identifier read in a sub-evaluation). It must escape, not be dropped.
			const { signal } = this;

			this.signal = null;
			this.finished = true;
			if (signal?.type === "throw") {
				throw signal.value;
			}

			if (signal?.type === "return") {
				this.completion = signal.value;
			}

			return;
		}

		this.steps += 1;

		// Fuel limit: bail uncatchably so untrusted code can't hang a host (e.g. a language-server-resident driver).
		if (this.maxSteps !== undefined && this.steps > this.maxSteps) {
			throw new TsvalInternalError(`step budget exceeded (${this.maxSteps})`);
		}

		if (this.signal !== null) {
			this.unwind(frame, this.signal);

			return;
		}

		// A statement's first step (phase 0) is the statement starting — the same test a breakpoint uses.
		if (this.coverage !== undefined && frame.kind === undefined && frame.phase === 0 && isStatement(frame.node)) {
			this.coverage.set(frame.node, (this.coverage.get(frame.node) ?? 0) + 1);
		}

		// (each synthetic handler is typed for its own frame; the union is dispatched on `kind` here)
		const handler = (frame.kind !== undefined ? syntheticHandlers[frame.kind] : nodeHandlers[frame.node.kind]) as ((vm: Machine, frame: Frame) => void) | undefined;

		if (handler === undefined) {
			if (frame.kind !== undefined) {
				throw new TsvalInternalError(`unimplemented: ${frame.kind}`);
			}

			throw new TsvalInternalError(`unimplemented: ${syntaxKindName(frame.node.kind)} (SyntaxKind ${frame.node.kind})`);
		}

		try {
			// A compound statement takes its completion mark when it STARTS (a block pushes all its
			// statements up front; earlier siblings run in between).
			if (frame.kind === undefined && frame.phase === 0 && frame.completionMark === undefined && COMPLETION_STATEMENTS.has(frame.node.kind)) {
				frame.completionMark = this.completionSerial;
			}

			handler(this, frame);
			if (frame.kind === undefined && frame.completionMark !== undefined && this.frames[this.frames.length - 1] !== frame && !this.frames.includes(frame)) {
				this.finishStatement(frame);
			}

			// Stepped async: an `await` on the main stack cuts its async function off, to resume when what it awaited settles.
			if (this.paused && this.pauseKind === "await" && this.steppedAsync && this.depth === 0) {
				this.cut();
			}
		} catch (error) {
			// A guest-observable runtime error (host built-in threw, bad member access, `instanceof` on a
			// non-object, …) becomes a catchable `throw` signal. Interpreter bugs and a host's uncatchable
			// aborts stay loud and propagate to the host uncaught (ASSIGNMENT working style; a host's abort must
			// not be swallowable by guest try/catch).
			if (isUncatchable(error)) {
				throw error;
			}

			this.signal = { "type": "throw", "value": this.toGuestError(error) };
			this.noteThrow(this.signal.value, frame.node);
		}
	}

	/** Run to completion, synchronously. A top-level `await` needs a driver — use `runAsync`. */
	public run(): unknown {
		while (!this.finished && !this.paused) {
			this.step();
		}

		if (this.paused) {
			throw new TsvalInternalError(`top-level ${this.pauseKind} reached in a synchronous run(); use runAsync()`);
		}

		return this.completion;
	}

	/**
	 * Run to completion, driving top-level `await`: the main context suspends like a fiber and resumes
	 * when the awaited value settles (a rejection is injected as a throw at the await; an uncatchable
	 * error propagates).
	 */
	public async runAsync(): Promise<unknown> {
		while (!this.finished) {
			this.idle = false;

			while (!this.finished && !this.paused && !this.idle) {
				this.step();
			}

			// Stepped async: work pending, none ready — let it settle.
			if (this.idle) {
				await this.whenSettled();
				continue;
			}

			if (!this.paused) {
				break;
			}

			if (this.pauseKind !== "await") {
				throw new TsvalInternalError("top-level yield outside a generator");
			}

			this.paused = false;
			try {
				this.sentValue = await this.pauseValue;
			} catch (error) {
				if (isUncatchable(error)) {
					throw error;
				}

				this.signal = { "type": "throw", "value": error };
				this.noteThrow(error, this.currentNode);
			}
		}

		return this.completion;
	}

	/** Step until the given predicate holds, the machine suspends (`paused`), or it finishes. */
	public runUntil(predicate: (vm: Machine) => boolean): void {
		this.idle = false;

		while (!this.finished && !this.paused && !this.idle && !predicate(this)) {
			this.step();
		}
	}

	/** Step until control reaches the next statement boundary (or the machine finishes). */
	public stepStatement(): void {
		// Advance at least one step, then run until the *next* fresh statement frame.
		this.step();
		this.runUntil((vm) => vm.atStatementBoundary());
	}

	/** True when the top frame is about to begin evaluating a statement node (fresh, phase 0). */
	public atStatementBoundary(): boolean {
		const frame = this.top;

		return frame !== undefined && frame.kind === undefined && frame.phase === 0 && frame.node !== null && isStatement(frame.node);
	}

	/** The 0-based line/character (and raw position) of a node, for debugger UIs. */
	public location(node: ts.Node | null = this.currentNode): { "line": number; "character": number; "pos": number } | null {
		if (node === null || node === undefined || this.sourceFile === null || this.sourceFile === undefined) {
			return null;
		}

		const pos = node.getStart(this.sourceFile);
		const { line, character } = this.sourceFile.getLineAndCharacterOfPosition(pos);

		return { "line": line, "character": character, "pos": pos };
	}

	/** Add a breakpoint at a node's start position. */
	public addBreakpoint(pos: number): void {
		this.breakpoints.add(pos);
	}

	/** Add breakpoints by 1-based source line: breaks at the first statement starting on each line. */
	public addBreakpointsByLine(...lines: number[]): void {
		if (this.sourceFile === null || this.sourceFile === undefined) {
			return;
		}

		const wanted = new Set(lines);
		const visit = (node: ts.Node): void => {
			if (isStatement(node)) {
				const line = this.sourceFile!.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).line + 1;

				if (wanted.has(line)) {
					this.breakpoints.add(node.getStart(this.sourceFile));
				}
			}

			node.forEachChild(visit);
		};

		this.sourceFile.forEachChild(visit);
	}

	/** True when the top frame is a fresh statement sitting on a breakpoint. */
	public atBreakpoint(): boolean {
		const frame = this.top;

		if (frame === undefined || frame.kind !== undefined || frame.phase !== 0 || frame.node === null || this.sourceFile === undefined) {
			return false;
		}

		// Statement-level only: a statement and a child expression can share a start position.
		return isStatement(frame.node) && this.breakpoints.has(frame.node.getStart(this.sourceFile));
	}

	/** Run until the next breakpoint (or completion). Advances at least one step. */
	public runToBreakpoint(): void {
		this.step();
		this.runUntil((vm) => vm.atBreakpoint());
	}

	// --- snapshot / fork (ASSIGNMENT §3, S4) ----------------------------------

	/**
	 * Produce an independent copy of the machine at its current point — a fork.
	 *
	 * The whole state (value stack, control stack, scope graph, signal, completion) is deep-copied so
	 * the two machines can diverge without interfering. The crucial subtlety (ASSIGNMENT §3): **guest
	 * state is cloned, host state is shared**. Injected globals, host built-ins, the root globals, AST
	 * nodes, class constructors, and live generator/async fibers keep their identity (cloning them would
	 * break `instanceof`, a host's own bookkeeping, or be impossible); only program-created objects, arrays,
	 * closures, scopes, and value-like host builtins (Date/RegExp/Map/Set) are copied. A shared `seen`
	 * map preserves reference identity and cycles *within* the fork.
	 *
	 * This is what lets a host explore more than one path from a single run.
	 */
	public fork(): Machine {
		const seen = new Map<unknown, unknown>();
		// The fork is created first so cloned closures can be rebound to *it* (not to this source VM),
		// and it needs its realm/intrinsics *before* any closure is cloned (function creation uses them).
		const forked: Machine = Object.create(Machine.prototype);

		(forked as { "realm": Machine["realm"] }).realm = this.realm; // same guest realm (intrinsics are shared)
		(forked as { "guestErrors": Machine["guestErrors"] }).guestErrors = this.guestErrors;

		function register<T>(from: unknown, to: T): T {
			seen.set(from, to);

			return to;
		}

		const cloneScope = (scope: Scope): Scope => {
			const parent = scope.parent ? (clone(scope.parent) as Scope) : undefined;
			const ns = new Scope(parent, scope.isolated);

			seen.set(scope, ns);
			ns.realGlobals = scope.realGlobals;
			ns.hasThis = scope.hasThis;
			ns.thisVal = clone(scope.thisVal);
			ns.homeObject = scope.homeObject; // guest prototype — shared (behavior, not data)
			ns.classMeta = scope.classMeta; // shared
			ns.newTarget = scope.newTarget; // constructor — shared
			ns.functionMeta = scope.functionMeta; // shared (AST + flags)
			ns.privateNames = scope.privateNames; // shared: the same class evaluation's private names
			if (scope.parent === undefined) {
				ns.globalObject = scope.globalObject; // share injected/host globals
			}

			for (const [name, binding] of scope.bindings) {
				ns.bindings.set(name, { "value": clone(binding.value), "kind": binding.kind, "initialized": binding.initialized });
			}

			return ns;
		};

		function clone(value: unknown): unknown {
			if (value === null || (typeof value !== "object" && typeof value !== "function")) {
				return value;
			}

			if (seen.has(value)) {
				return seen.get(value);
			}

			if (typeof value === "function") {
				if (isGuestFunction(value)) {
					const meta = value.__tsval;
					// Rebind to the forked VM; break the closure cycle via pre-registration.
					const fn = createGuestFunction(forked, meta.node, meta.closure, meta.homeObject);

					fn.__tsval.isGenerator = meta.isGenerator;
					fn.__tsval.isAsync = meta.isAsync;
					seen.set(value, fn);
					fn.__tsval.closure = clone(meta.closure) as Scope;

					return fn;
				}

				return value; // host functions & guest class constructors — shared
			}

			if (value instanceof Scope) {
				return cloneScope(value);
			}

			if ((value as Record<PropertyKey, unknown>)[FIBER_BRAND] === true) {
				return value; // live fiber — shared
			}

			// A guest class prototype (its `constructor` is a branded guest class) is behavior, not data:
			// share it, consistently with `cloneScope`'s `homeObject` — so a mid-construction fork keeps
			// `ClassMeta.proto === ctor.prototype`.
			if (isGuestClassPrototype(value)) {
				return value;
			}

			if (Array.isArray(value)) {
				const out: unknown[] = [];

				seen.set(value, out);
				for (let index = 0; index < value.length; index++) {
					out[index] = clone(value[index]);
				}

				return out;
			}

			if (value instanceof Date) {
				return register(value, new Date(value.getTime()));
			}

			if (value instanceof RegExp) {
				return register(value, new RegExp(value.source, value.flags));
			}

			if (value instanceof Map) {
				const out = new Map();

				seen.set(value, out);
				for (const [key, val] of value) {
					out.set(clone(key), clone(val));
				}

				return out;
			}

			if (value instanceof Set) {
				const out = new Set();

				seen.set(value, out);
				for (const val of value) {
					out.add(clone(val));
				}

				return out;
			}

			const proto = Object.getPrototypeOf(value);
			const isGuestObject = proto === Object.prototype || proto === null || isGuestClass(proto?.constructor);

			if (!isGuestObject) {
				return value; // host instance (Promise, Error, DOM, host class, …) — shared
			}

			const out = Object.create(proto); // share the (guest) prototype; copy own data

			seen.set(value, out);
			for (const key of Reflect.ownKeys(value)) {
				const desc = Object.getOwnPropertyDescriptor(value, key)!;

				if ("value" in desc) {
					desc.value = clone(desc.value);
				}

				// Accessors are closures too: rebind them like any other guest function.
				if (desc.get !== undefined) {
					desc.get = clone(desc.get) as () => unknown;
				}

				if (desc.set !== undefined) {
					desc.set = clone(desc.set) as (received: unknown) => void;
				}

				Object.defineProperty(out, key, desc);
			}

			clonePrivateElements(value, out, clone); // private (`#x`) state lives in a side table

			return out;
		}

		const cloneFrame = (frame: Frame): Frame => {
			// Field by field: every frame is plain data (frame.ts); a compiled PatternProgram is a shared
			// class instance and `clone` passes it through.
			const nf = { "node": frame.node, "phase": frame.phase, "scope": clone(frame.scope), "valuesBase": frame.valuesBase } as Record<string, unknown>;

			for (const key of Object.keys(frame)) {
				if (key !== "node" && key !== "phase" && key !== "scope" && key !== "valuesBase") {
					nf[key] = clone((frame as unknown as Record<string, unknown>)[key]);
				}
			}

			return nf as unknown as Frame;
		};

		(forked as { "rootScope": Scope }).rootScope = clone(this.rootScope) as Scope;
		(forked as { "breakpoints": Set<number> }).breakpoints = new Set(this.breakpoints);
		// Its own: the fork's guest values are clones, so the source's throw sites (keyed by its values) aren't its.
		(forked as unknown as { "throwSites": WeakMap<object, ts.Node> }).throwSites = new WeakMap();
		forked.sourceFile = this.sourceFile;
		forked.resolveModule = this.resolveModule;
		forked.hostGuard = this.hostGuard;
		forked.onAsyncFiber = this.onAsyncFiber;
		forked.onBreakpoint = this.onBreakpoint;
		forked.coverage = this.coverage === undefined ? undefined : new Map(this.coverage);
		forked.observe = this.observe;
		forked.trace = this.trace;
		forked.calls = this.calls;
		forked.callSite = undefined;
		forked.values = this.values.map(clone);
		forked.frames = this.frames.map(cloneFrame);
		forked.signal = this.signal ? ({ ...this.signal, "value": clone((this.signal as { "value"?: unknown }).value) } as Signal) : null;
		forked.completion = clone(this.completion);
		forked.finished = this.finished;
		forked.steps = this.steps;
		forked.paused = this.paused;
		forked.pauseKind = this.pauseKind;
		forked.pauseValue = clone(this.pauseValue);
		forked.sentValue = clone(this.sentValue);
		forked.steppedAsync = this.steppedAsync;
		forked.idle = this.idle;
		forked.depth = 0;
		// Its own pending fibers (their frames and closures, cloned), and the shared record of what settled.
		forked.pending = new Map([...this.pending].map(([id, each]) => [id, each.kind === "fiber" ? { "kind": "fiber", "frames": each.frames.map(cloneFrame), "values": each.values.map(clone), "base": each.base } : { "kind": "callback", "fn": clone(each.fn) as GuestFunction }]));
		forked.scheduler = this.scheduler;
		forked.loop = this.loop === undefined ? undefined : forkLoop(this.loop, clone);

		return forked;
	}

	// --- stepped async (VMOptions.steppedAsync) --------------------------------

	/** Stepped async: an async function call on the main stack — its async frame (which settles its promise), then its
	 *  call. Returns nothing: the promise reaches the caller when the body first suspends, or completes. */
	public enterAsync(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): void {
		let resolve!: (value: unknown) => void;
		let reject!: (reason: unknown) => void;
		const promise = new this.realm.Promise<unknown>((settleWith, failWith) => { resolve = settleWith; reject = failWith; });
		const frame: AsyncFrame = { "kind": "async", "node": null, "phase": 0, "scope": this.rootScope, "valuesBase": this.values.length, "promise": promise, "resolve": resolve, "reject": reject };

		this.frames.push(frame);
		this.pushCall(meta, args, thisArg);
		this.onAsyncFiber?.(promise);
	}

	/** Stepped async: `fn` (a guest callback handed to a host promise's `then`/`catch`/`finally`) as the host calls it —
	 *  a job of its own, run on the main stack between tasks; the host gets a promise of what it returns. */
	public deferCallback(fn: GuestFunction): (...args: unknown[]) => Promise<unknown> {
		this.scheduler.ids += 1;

		const id = this.scheduler.ids;
		const { scheduler } = this;

		this.pending.set(id, { "kind": "callback", "fn": fn });

		return (...args: unknown[]): Promise<unknown> => new this.realm.Promise<unknown>((resolve, reject) => {
			settle(scheduler, id, { "kind": "call", "args": args, "resolve": resolve, "reject": reject });
		});
	}

	/** Resolves when something pending settles, or the next timer may fire (the host awaits it while the machine is
	 *  `idle`). */
	public whenSettled(): Promise<void> {
		const settled = new Promise<void>((resolve) => { this.scheduler.wakers.push(resolve); });
		const turn = this.loop === undefined ? undefined : waitForTurn(this.loop, arrived(this.loop).length > 0);

		return turn === undefined ? settled : Promise.race([settled, turn]);
	}

	/** A host call as a person reads it, for a candidate's label: its callee as the code writes it, and its first argument
	 *  when that's a string — `fetch("https://a.example/")`. */
	private callLabel(site: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression, callee: unknown, args: unknown[]): string {
		const written = this.sourceFile === undefined || ts.isTaggedTemplateExpression(site) ? undefined : site.expression.getText(this.sourceFile);
		const name = written ?? (typeof callee === "function" && callee.name !== "" ? callee.name : "a host call");
		const [first] = args;

		return typeof first === "string" ? `${name}(${JSON.stringify(first.length > 60 ? first.slice(0, 57) + "…" : first)})` : `${name}(…)`;
	}

	/** Event loop: a host call's promised `value` as the program gets it — a promise of the machine's realm, settled when
	 *  the result, once it's in, is delivered as an event (fireEvent). */
	private awaitResult(value: object, label: string): Promise<unknown> {
		const loop = this.loop!;
		const { scheduler } = this;
		let resolve!: (value: unknown) => void;
		let reject!: (reason: unknown) => void;
		const promise = new this.realm.Promise<unknown>((settleWith, failWith) => { resolve = settleWith; reject = failWith; });

		loop.ids += 1;

		const result: Result = { "id": loop.ids, "label": label };

		loop.results.set(result.id, result);
		Promise.resolve(value).then(
			(settled) => { result.deliver = () => { resolve(settled); }; wake(scheduler); },
			(error: unknown) => { result.deliver = () => { reject(error); }; wake(scheduler); }
		);

		return promise;
	}

	/** Event loop: once a real turn has passed (the host's microtasks flushed), the next event — an external result, or
	 *  the next timer, whichever is chosen (event-loop.ts: `choose`) — a job of its own on the (empty) stack; true if one
	 *  came. */
	private fireEvent(): boolean {
		const { loop } = this;

		if (loop === undefined || !loop.checkpoint) {
			return false;
		}

		const results = arrived(loop);
		const timer = nextTimer(loop);
		const candidates = [...results.map((result) => ({ "kind": "result" as const, "label": result.label })), ...timer === undefined ? [] : [{ "kind": "timer" as const, "label": timerLabel(loop, timer) }]];

		if (candidates.length === 0) {
			return false;
		}

		const picked = choose(loop, candidates);

		loop.checkpoint = false;
		this.idle = false;

		// A result: its promise settled — what was waiting on it runs as its jobs come.
		if (picked < results.length) {
			const result = results[picked]!;

			loop.results.delete(result.id);
			result.deliver!();

			return true;
		}

		const fired = takeTimer(loop)!;

		this.idle = false;
		this.values.length = 0; // between tasks: nothing on it is anyone's

		if (isGuestFunction(fired.fn)) {
			this.pushCall(fired.fn.__tsval, fired.args, undefined);
		} else {
			(fired.fn as (...args: unknown[]) => unknown)(...fired.args);
		}

		return true;
	}

	/** Stepped async: an `await` on the main stack — cut the stack at the nearest async frame (or, at the top level, all
	 *  of it) into a pending fiber; hand the call its promise the first time; resume the fiber when what it awaited
	 *  settles. */
	private cut(): void {
		let at = this.frames.length - 1;

		while (at >= 0 && this.frames[at]!.kind !== "async") {
			at -= 1;
		}

		const boundary = at === -1 ? undefined : this.frames[at] as AsyncFrame;
		const bottom = Math.max(at, 0);
		const base = boundary?.valuesBase ?? 0;
		this.scheduler.ids += 1;

		const id = this.scheduler.ids;
		const awaited = this.pauseValue;
		const { scheduler } = this;

		this.pending.set(id, { "kind": "fiber", "frames": this.frames.slice(bottom), "values": this.values.slice(base), "base": base });
		this.frames.length = bottom;
		this.values.length = base;
		this.paused = false;
		this.pauseKind = undefined;
		this.pauseValue = undefined;

		if (boundary !== undefined && boundary.delivered !== true) {
			boundary.delivered = true;
			this.values.push(boundary.promise);
		}

		Promise.resolve(awaited).then(
			(value) => { settle(scheduler, id, { "kind": "next", "value": value }); },
			(error: unknown) => { settle(scheduler, id, { "kind": "throw", "value": error }); }
		);
	}

	/** Stepped async: put the first settled pending job back on the (empty) stack, to step on — true if there was one. */
	private resumeSettled(): boolean {
		const entry = this.scheduler.settled.find(({ id }) => this.pending.has(id));

		if (entry === undefined) {
			return false;
		}

		this.resume(entry);

		return true;
	}

	/** Put a settled pending job back on the (empty) stack. */
	private resume(entry: AsyncScheduler["settled"][number]): void {
		const job = this.pending.get(entry.id)!;
		const { input } = entry;

		this.pending.delete(entry.id);
		this.idle = false;

		if (job.kind === "callback") {
			if (input.kind !== "call") {
				return;
			}

			// The callback's own async frame (it settles the promise the host got), then its call.
			const frame: AsyncFrame = { "kind": "async", "node": null, "phase": 0, "scope": this.rootScope, "valuesBase": this.values.length, "promise": Promise.resolve(), "resolve": input.resolve, "reject": input.reject, "delivered": true };

			this.frames.push(frame);
			this.pushCall(job.fn.__tsval, input.args, undefined);

			return;
		}

		const delta = this.values.length - job.base;

		for (const frame of job.frames) {
			frame.valuesBase += delta;
		}

		this.frames.push(...job.frames);
		this.values.push(...job.values);

		if (input.kind === "next") {
			this.sentValue = input.value;
		} else if (input.kind === "throw") {
			this.signal = { "type": "throw", "value": input.value };
		}
	}

	// --- execution contexts (nested sub-runs & fibers) ------------------------

	/**
	 * Invoke a guest function from host code (array callbacks, host-supplied functions). Runs a nested loop to
	 * completion on a private stack; host↔guest crossings use the host stack (documented tradeoff),
	 * while guest→guest calls stay on the explicit stack. (ASSIGNMENT §3, "Calls".)
	 */
	public callGuestFromHost(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[], newTarget?: unknown): unknown {
		if (meta.isGenerator && meta.isAsync) {
			return this.createAsyncGenerator(meta, thisArg, args);
		}

		if (meta.isGenerator) {
			return this.createGenerator(meta, thisArg, args);
		}

		if (meta.isAsync) {
			return this.callAsync(meta, thisArg, args);
		}

		return this.runSub(() => this.pushCall(meta, args, thisArg, newTarget));
	}

	/**
	 * Evaluate a single expression node to a value on a private stack, synchronously. Used for the
	 * "leaf" sub-expressions of binding forms — default parameter/element values and computed
	 * destructuring keys — where a full stepped integration would be disproportionate. Nested guest
	 * calls it makes still run on the explicit (sub-)stack; only the entry uses the host stack.
	 */
	public evalNodeSync(node: ts.Node, scope: Scope): unknown {
		return this.runSub(() => this.pushNode(node, scope));
	}

	/**
	 * Construct a guest class from host code (e.g. `new` reached through a host callback). Runs a
	 * construct frame to completion on a private stack; guest `new` uses the explicit construct frame
	 * directly (steppable). The `frame.kind === "construct"` handler lives in handlers.ts.
	 */
	public constructGuestSync(ctor: GuestClass, args: unknown[], newTarget: unknown = ctor): unknown {
		return this.runSub(() => this.frames.push({ "kind": "construct", "node": null, "phase": 0, "scope": this.rootScope, "valuesBase": 0, "ctor": ctor, "args": args, "isNew": true, "newTarget": newTarget, "call": this.nextCall() }));
	}

	// --- fibers: generators & async (machine suspension, ASSIGNMENT §3) -------

	/** Create a guest generator object (lazy: the body runs on `.next()`). */
	public createGenerator(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Iterator<unknown> & Iterable<unknown> {
		const fiber = this.seedFiber(meta, thisArg, args);
		const resume = (input: FiberInput): IteratorResult<unknown> => {
			if (fiber.done) {
				if (input.kind === "throw") {
					throw input.value;
				}

				return { "value": input.kind === "return" ? input.value : undefined, "done": true };
			}

			// `return`/`throw` on a suspended-start generator completes it without running the body.
			if (!fiber.started && input.kind !== "next") {
				fiber.done = true;
				if (input.kind === "throw") {
					throw input.value;
				}

				return { "value": input.value, "done": true };
			}

			const { paused, kind, value, raw } = this.stepFiber(fiber, input);

			if (paused) {
				if (kind !== "yield") {
					throw new TsvalInternalError("await inside a (non-async) generator");
				}

				return raw === true ? (value as IteratorResult<unknown>) : { "value": value, "done": false };
			}

			fiber.done = true;

			return { "value": value, "done": true };
		};

		const gen = generatorObject(this.generatorPrototype(meta, false), {
			"next": (value?: unknown) => resume({ "kind": "next", "value": value }),
			"return": (value?: unknown) => resume({ "kind": "return", "value": value }),
			"throw": (error?: unknown) => resume({ "kind": "throw", "value": error })
		}) as Iterator<unknown> & Iterable<unknown>;

		Object.defineProperty(gen, FIBER_BRAND, { "value": true }); // non-cloneable: forks share the fiber

		return gen;
	}

	/** Invoke a guest async function: returns a real Promise, driven by `await` suspensions. */
	public callAsync(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Promise<unknown> {
		// An abrupt completion while binding an async function's parameters rejects the returned
		// promise (spec) — unlike generators, whose call throws synchronously.
		let fiber: Fiber | undefined;
		let seedError: unknown;

		try {
			fiber = this.seedFiber(meta, thisArg, args);
		} catch (error) {
			if (isUncatchable(error)) {
				throw error;
			}

			seedError = error;
		}

		const promise = new this.realm.Promise<unknown>((resolve, reject) => {
			if (fiber === undefined) {
				reject(seedError);

				return;
			}

			const drive = (input: FiberInput): void => {
				const activeFiber = fiber;
				let result: { "paused": boolean; "kind"?: "yield" | "await"; "value": unknown };

				try {
					result = this.stepFiber(activeFiber, input);
				} catch (error) {
					activeFiber.done = true;
					reject(error);

					return;
				}

				if (!result.paused) {
					activeFiber.done = true;
					resolve(result.value);

					return;
				}

				if (result.kind !== "await") {
					activeFiber.done = true;
					reject(new TsvalInternalError("yield inside an async (non-generator) function"));

					return;
				}

				// Suspended on `await result.value`; resume when it settles.
				Promise.resolve(result.value).then(
					(value) => { drive({ "kind": "next", "value": value }); },
					(error: unknown) => {
						// An uncatchable error (interpreter bug, a host's abort) that rejected an awaited promise
						// must not be injected as a guest `throw` — guest try/catch could swallow it.
						if (isUncatchable(error)) {
							activeFiber.done = true;
							reject(error);
						} else {
							drive({ "kind": "throw", "value": error });
						}
					}
				);
			};

			drive({ "kind": "next", "value": undefined });
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
	public createAsyncGenerator(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): AsyncIterator<unknown> & AsyncIterable<unknown> {
		const fiber = this.seedFiber(meta, thisArg, args);
		const drive = (input: FiberInput): Promise<IteratorResult<unknown>> => {
			if (fiber.done) {
				if (input.kind === "throw") {
					return Promise.reject(input.value);
				}

				return Promise.resolve({ "value": input.kind === "return" ? input.value : undefined, "done": true });
			}

			if (!fiber.started && input.kind !== "next") {
				fiber.done = true; // suspended-start: complete without running the body

				return input.kind === "throw" ? Promise.reject(input.value) : Promise.resolve({ "value": input.value, "done": true });
			}

			let result: { "paused": boolean; "kind"?: "yield" | "await"; "value": unknown };

			try {
				result = this.stepFiber(fiber, input);
			} catch (error) {
				fiber.done = true;

				return Promise.reject(error);
			}

			if (!result.paused) {
				fiber.done = true;

				return Promise.resolve({ "value": result.value, "done": true });
			}

			if (result.kind === "await") {
				return Promise.resolve(result.value).then(
					(value) => drive({ "kind": "next", "value": value }),
					(error: unknown) => {
						if (isUncatchable(error)) {
							fiber.done = true;

							return Promise.reject(error);
						}

						return drive({ "kind": "throw", "value": error });
					}
				);
			}

			// `yield v` in an async generator awaits v; a rejection is a *throw at the yield*, which the
			// body may catch — not a rejection of the pending `next()`.
			return Promise.resolve(result.value).then(
				(value) => ({ "value": value, "done": false }),
				(error: unknown) => drive({ "kind": "throw", "value": error })
			);
		};

		// AsyncGeneratorResumeNext: a request against a *suspended* generator runs the body synchronously
		// up to its next suspension (observable: a side effect in the body is visible right after
		// `.next()` returns); requests arriving while it's executing queue behind, in order.
		const queue: { "input": FiberInput; "resolve": (r: IteratorResult<unknown>) => void; "reject": (e: unknown) => void }[] = [];
		let busy = false;
		const pump = (): void => {
			if (busy || queue.length === 0) {
				return;
			}

			busy = true;
			const request = queue.shift()!;

			drive(request.input).then(
				(result) => {
					busy = false;
					request.resolve(result);
					pump();
				},
				(error: unknown) => {
					busy = false;
					request.reject(error);
					pump();
				}
			);
		};

		const enqueue = (input: FiberInput): Promise<IteratorResult<unknown>> => {
			const request = new this.realm.Promise<IteratorResult<unknown>>((resolve, reject) => {
				queue.push({ "input": input, "resolve": resolve, "reject": reject });
				pump();
			});

			this.onAsyncFiber?.(request);

			return request;
		};

		const gen = generatorObject(this.generatorPrototype(meta, true), {
			"next": (value?: unknown) => enqueue({ "kind": "next", "value": value }),
			"return": (value?: unknown) => enqueue({ "kind": "return", "value": value }),
			"throw": (error?: unknown) => enqueue({ "kind": "throw", "value": error })
		}) as AsyncIterator<unknown> & AsyncIterable<unknown>;

		Object.defineProperty(gen, FIBER_BRAND, { "value": true });

		return gen;
	}

	/** Push a synthetic call frame for a guest function. */
	public pushCall(meta: GuestFunctionMeta, args: unknown[], thisArg: unknown, newTarget?: unknown): CallFrame {
		const frame: CallFrame = {
			"kind": "call",
			"node": meta.node,
			"phase": 0,
			"scope": meta.closure, // real scope built in phase 0
			"valuesBase": this.values.length,
			"meta": meta,
			"args": args,
			"thisArg": thisArg,
			"newTarget": newTarget,
			"call": this.nextCall()
		};

		this.frames.push(frame);

		return frame;
	}

	/** A compound statement finished (normally or by a caught break) without its body producing a
	 *  completion value: the program's completion becomes undefined — unless it ran inside a function. */
	private finishStatement(frame: NodeFrame): void {
		if (frame.completionMark !== this.completionSerial || this.insideFunction(frame.scope)) {
			return;
		}

		this.completion = undefined;
	}

	/**
	 * An error created by tsval's own host code (this realm's `TypeError` etc.) becomes the guest
	 * realm's equivalent, so guest `instanceof`/`constructor` checks see the classes the guest knows.
	 * Errors already from another realm, or non-Error values, pass through.
	 */
	private toGuestError(error: unknown): unknown {
		if (!(error instanceof Error)) {
			return error;
		}

		const { name } = error.constructor;
		const GuestCtor = this.guestErrors[name];

		if (GuestCtor === undefined || GuestCtor === (globalThis as Record<string, unknown>)[name]) {
			return error;
		}

		const converted = new GuestCtor(error.message);

		if (error.stack !== undefined) {
			converted.stack = error.stack;
		}

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
		// Stepped async: a throw out of an async function's body (or a host-called callback) rejects its promise.
		if (frame.kind === "async" && signal.type === "throw") {
			this.frames.pop();
			this.values.length = frame.valuesBase;
			this.signal = null;
			frame.reject(signal.value);

			if (frame.delivered !== true) {
				frame.delivered = true;
				this.values.push(frame.promise);
			}

			return;
		}

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
			const { value } = signal;

			this.values.length = frame.valuesBase;
			this.signal = null;
			if ((typeof value === "object" && value !== null) || typeof value === "function") {
				(frame.construction as { "instance": unknown }).instance = value;
				frame.overridden = true; // (a derived constructor may then never have called super())
			} else if (value !== undefined && frame.derived === true) {
				this.signal = { "type": "throw", "value": this.toGuestError(new TypeError("Derived constructors may only return object or undefined")) };
				this.noteThrow(this.signal.value, frame.node);
			}

			return;
		}

		if (frame.kind === "pattern") {
			this.closeIterations(frame.iters.splice(0).reverse(), signal); // innermost first
		}

		if (frame.kind === undefined) {
			// Loop frames catch break/continue targeting them (unlabeled, or matching label).
			if (frame.isLoop === true && (signal.type === "break" || signal.type === "continue")) {
				if (signal.label === null || signal.label === undefined || signal.label === frame.label) {
					this.values.length = frame.valuesBase;
					this.signal = null;
					if (signal.type === "break") {
						this.frames.pop();
						if (frame.iteration !== undefined) {
							this.closeIterations([frame.iteration], signal);
						}

						if (frame.completionMark !== undefined) {
							this.finishStatement(frame);
						}
					} else {
						frame.phase = frame.continuePhase!;
					}

					return;
				}
			}

			// A for-of left by any other abrupt completion (return/throw/outer break) closes its iterator.
			if (frame.isLoop === true && frame.iteration !== undefined) {
				this.closeIterations([frame.iteration], signal);
			}

			// switch / labeled-block frames catch break targeting them.
			if ((frame.isSwitch === true || frame.isLabel === true) && signal.type === "break") {
				if (signal.label === null || signal.label === undefined ? frame.isSwitch === true : signal.label === frame.label) {
					this.values.length = frame.valuesBase;
					this.signal = null;
					this.frames.pop();
					if (frame.completionMark !== undefined) {
						this.finishStatement(frame);
					}

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
			if (signal.type === "throw") {
				throw signal.value;
			}

			if (signal.type === "return") {
				this.completion = signal.value;
			}
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
				if (isUncatchable(error)) {
					throw error;
				}

				this.signal = { "type": "throw", "value": this.toGuestError(error) };
				this.noteThrow(this.signal.value, this.currentNode);
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
			this.pushNode(node.finallyBlock!, frame.scope);
		};

		if (frame.state === "try") {
			if (signal.type === "throw" && node.catchClause !== null && node.catchClause !== undefined) {
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
				if (varDecl !== null && varDecl !== undefined) {
					if (ts.isIdentifier(varDecl.name)) {
						bindIdentifier(catchScope, varDecl.name.text, signal.value, "let");
					} else {
						pushPattern(this, catchScope, bindingProgram(varDecl.name, "let"), signal.value);
					}
				}

				return;
			}

			if (node.finallyBlock !== null && node.finallyBlock !== undefined) {
				runFinallyThenReraise();

				return;
			}
		} else if (frame.state === "catch") {
			if (node.finallyBlock !== null && node.finallyBlock !== undefined) {
				runFinallyThenReraise();

				return;
			}
		}
		// state === "finally": a signal from inside finally overrides any pending one → propagate.

		this.frames.pop();
		this.values.length = Math.min(this.values.length, frame.valuesBase);
		if (this.frames.length === 0) {
			this.signal = null;
			this.finished = true;
			if (signal.type === "throw") {
				throw signal.value;
			}

			if (signal.type === "return") {
				this.completion = signal.value;
			}
		}
	}

	private saveContext(): ExecContext {
		this.depth += 1;

		return { "frames": this.frames, "values": this.values, "signal": this.signal, "finished": this.finished, "paused": this.paused, "pauseKind": this.pauseKind, "pauseValue": this.pauseValue, "pauseRaw": this.pauseRaw, "sentValue": this.sentValue };
	}

	private restoreContext(ctx: ExecContext): void {
		this.depth -= 1;
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
				// Regain debugger control inside a host-invoked guest call: a fresh statement on a breakpoint
				// fires the hook (which may block and inspect state) before it executes. Only meaningful for
				// statement-bearing sub-runs (a function body); expression sub-runs never hit atBreakpoint.
				if (this.onBreakpoint !== undefined && this.atBreakpoint()) {
					this.onBreakpoint(this);
				}

				this.step();
				// A synchronous sub-run has no driver to resume it: a `yield`/`await` here (a computed key,
				// default value, or destructuring default containing one) cannot be honored. Fail loud
				// rather than silently resuming with `undefined`.
				if (this.paused) {
					throw new TsvalInternalError("yield/await inside a synchronously evaluated sub-expression (default value / computed key) is not supported");
				}
			}

			return this.values.pop();
		} finally {
			this.restoreContext(ctx);
		}
	}

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

		while (this.frames.length > bodyDepth) {
			this.step();
		}

		const signal = this.signal as Signal | null; // (asserted: TS keeps the pre-step `null` narrowing)

		if (signal !== null) {
			this.restoreContext(ctx);
			if (signal.type === "throw") {
				throw signal.value;
			}

			throw new TsvalInternalError(`unexpected ${signal.type} while binding parameters`);
		}

		const fiber: Fiber = { "frames": this.frames, "values": this.values, "signal": null, "done": false, "started": false };

		this.restoreContext(ctx);

		return fiber;
	}

	/**
	 * Run a fiber until it next suspends (`yield`/`await`) or completes. `input` is fed to the
	 * suspension point on resume: `next` supplies the value the `yield`/`await` produces; `return`/
	 * `throw` inject that signal at the suspension point. Returns `{ paused, value }` — `value` is the
	 * pause payload when paused, or the fiber's completion value when done.
	 */
	private stepFiber(fiber: Fiber, input: FiberInput): { "paused": boolean; "kind"?: "yield" | "await"; "value": unknown; "raw"?: boolean } {
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
			if (input.kind === "next") {
				this.sentValue = input.value;
			} else {
				// A `yield*` suspended on its inner iterator intercepts `throw`/`return` to forward them
				// (spec delegation); anything else is injected as a signal at the suspension point.
				const { top } = this;

				if (top !== undefined && top.kind === undefined && top.delegating === true) {
					top.received = { "kind": input.kind, "value": input.value };
				} else {
					this.signal = { "type": input.kind, "value": input.value };
				}
			}
		}

		fiber.started = true;

		try {
			while (!this.finished && !this.paused) {
				this.step();
			}

			if (this.paused) {
				return { "paused": true, "kind": this.pauseKind, "value": this.pauseValue, "raw": this.pauseRaw };
			}

			return { "paused": false, "value": this.values.pop() };
		} finally {
			fiber.frames = this.frames;
			fiber.values = this.values;
			fiber.signal = this.signal;
			this.restoreContext(ctx);
		}
	}

	/** OrdinaryCreateFromConstructor for a generator object: the function's own `.prototype` if it is an
	 *  object, else the realm's %GeneratorPrototype% / %AsyncGeneratorPrototype%. */
	private generatorPrototype(meta: GuestFunctionMeta, isAsync: boolean): object {
		const declared = (meta.self as { "prototype"?: unknown } | undefined)?.prototype;

		if ((typeof declared === "object" && declared !== null) || typeof declared === "function") {
			return declared;
		}

		return isAsync ? this.realm.AsyncGeneratorPrototype : this.realm.GeneratorPrototype;
	}
}

function isStatement(node: ts.Node): boolean {
	return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement;
}

/** True for the `prototype` object of a guest class (its own `constructor` is a branded guest class). */
function isGuestClassPrototype(value: object): boolean {
	const ctor = Object.getOwnPropertyDescriptor(value, "constructor")?.value as { "prototype"?: unknown } | undefined;

	return isGuestClass(ctor) && ctor.prototype === value;
}

/** A full snapshot of the machine's mutable execution state, for nested sub-runs and fibers. */
interface ExecContext {
	"frames": Frame[];
	"values": unknown[];
	"signal": Signal | null;
	"finished": boolean;
	"paused": boolean;
	"pauseKind": "yield" | "await" | undefined;
	"pauseValue": unknown;
	"pauseRaw": boolean;
	"sentValue": unknown;
}

/** A suspendable execution context — the backing store for a generator or async function. */
interface Fiber {
	"frames": Frame[];
	"values": unknown[];
	"signal": Signal | null;
	"done": boolean;
	"started": boolean;
}

/** Stepped async: a fiber cut off at an `await` (its frames from its async frame up, their operands, and the value-stack
 *  depth they were cut at) — or a guest callback handed to a host promise, waiting to be called. */
type Pending = { "kind": "fiber"; "frames": Frame[]; "values": unknown[]; "base": number } | { "kind": "callback"; "fn": GuestFunction };

/** How a pending job is resumed: a fiber with what it awaited (or the rejection, thrown at the `await`), a callback with
 *  the host's call. */
type Settlement = { "kind": "next"; "value": unknown } | { "kind": "throw"; "value": unknown } | { "kind": "call"; "args": unknown[]; "resolve": (value: unknown) => void; "reject": (reason: unknown) => void };

/** Stepped async: what settled, in order, for which pending job; and who waits for the next. Shared by forks. */
interface AsyncScheduler { "settled": { "id": number; "input": Settlement }[]; "ids": number; "wakers": (() => void)[] }

/** What a promise's own statics make (`Promise.resolve`, `Promise.all`, …) is the program's, not external. */
const PROMISE_STATICS = ["resolve", "reject", "all", "allSettled", "race", "any", "withResolvers"];

function isThenable(value: unknown): value is object {
	return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { "then"?: unknown }).then === "function";
}


/** Wake whoever waits for something to settle. */
function wake(scheduler: AsyncScheduler): void {
	for (const waker of scheduler.wakers.splice(0)) {
		waker();
	}
}

/** Record what settled for job `id`, and wake whoever waits. */
function settle(scheduler: AsyncScheduler, id: number, input: Settlement): void {
	scheduler.settled.push({ "id": id, "input": input });
	wake(scheduler);
}

/** How a fiber is resumed: with a value, or by injecting a return/throw at the suspension point. */
type FiberInput = { "kind": "next"; "value": unknown } | { "kind": "return"; "value": unknown } | { "kind": "throw"; "value": unknown };

/** The constructor hosts use; its instances are typed as the host-facing `VM`. */
const VMConstructor: new (options?: VMOptions) => VM = Machine;

export { VMConstructor as VM };
