import type { AsyncContext, EventLoopOptions, Loop } from "./event-loop.ts";
import type { AsyncFrame, CallFrame, Frame, Iteration, ModuleFrame, NodeFrame, SyntheticFrame, SyntheticKind } from "./frame.ts";
import { FOR_AWAIT_CLOSED } from "./frame.ts";
import type { ModuleLoader, ModuleRecord } from "./modules.ts";
import type { GuestClass } from "./handlers.ts";
import type { GuestFunction, GuestFunctionMeta } from "./values.ts";
import ts from "typescript";
import { isUncatchable, TsvalInternalError } from "./errors.ts";
import type { Choice, Result } from "./event-loop.ts";
import { arrived, choose, createLoop, forkLoop, hasRefTimers, hostCalling, INTRINSICS, loopGlobals, nextTimer, takeTimer, timerLabel, waitForTurn } from "./event-loop.ts";
import { syntaxErrorIn, syntaxKindName } from "./frontend.ts";
import { STANDARD_GLOBAL_NAMES, standardGlobals } from "./globals.ts";
import { bindIdentifier, bindingProgram, clonePrivateElements, closeIteration, createGuestFunction, isGuestClass, isSimpleTree, nodeHandlers, pushHostCall, pushPattern, simpleValue, syntheticHandlers } from "./handlers.ts";
import { defineExports, directoryOf, linkedSpecifiers, makeRequire, moduleOf, requireOf, setModuleOf } from "./modules.ts";
import { Scope } from "./scope.ts";
import type { Site } from "./stacks.ts";
import type { Capability, JobHost, JobInput, Settlers } from "./promises.ts";
import { isOwnResolve, OwnPromises } from "./promises.ts";
import { giveStack, hasProgramStack } from "./stacks.ts";
import { ownedBy } from "./values.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions and kinds used here are read off it once.
const { createSourceFile, isIdentifier, isSourceFile, isTaggedTemplateExpression } = ts;
const FIRST_STATEMENT = ts.SyntaxKind.FirstStatement;
const LAST_STATEMENT = ts.SyntaxKind.LastStatement;
const TRY_STATEMENT = ts.SyntaxKind.TryStatement;
const BLOCK = ts.SyntaxKind.Block;

/** The declarations that take a step of their own without being of a statement kind (the profile tallies them). */
const DECLARATIONS = new Uint8Array(ts.SyntaxKind.Count);

for (const kind of [ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration]) {
	DECLARATIONS[kind] = 1;
}
const IDENTIFIER = ts.SyntaxKind.Identifier;
const NUMERIC_LITERAL = ts.SyntaxKind.NumericLiteral;
const TRUE_KEYWORD = ts.SyntaxKind.TrueKeyword;
const FALSE_KEYWORD = ts.SyntaxKind.FalseKeyword;
const NULL_KEYWORD = ts.SyntaxKind.NullKeyword;

/** Statements whose completion is UpdateEmpty(body, undefined): they yield `undefined` when their body produced nothing. */
const COMPLETION_STATEMENTS = new Uint8Array(ts.SyntaxKind.Count);

for (const kind of [ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.SwitchStatement]) {
	COMPLETION_STATEMENTS[kind] = 1; // (a table by kind: it's read at every statement's first step)
}

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
	/** Names the global object lacks, looked up here before anywhere else — and assigned here, when they're here: the
	 *  globals the program shares with code that isn't interpreted (a run's packages: almostnode's run global's own
	 *  names, what they set on it). Only these: none of the host's own come through. */
	"sharedGlobals"?: Record<PropertyKey, unknown>;
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
	/** Stepped async: the host's async context (an AsyncLocalStorage's store, almostnode's), carried through the
	 *  program's jobs as Node carries it — an await resumes in the context it suspended in, a promise callback or a timer
	 *  runs in the one it was handed over in. */
	"asyncContext"?: AsyncContext;
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
	 *  as a server's request handler running through `callGuestFromHost` → `runSub`). Top-level stepping is driven
	 *  by the host through `step`/`runToBreakpoint`, but a host→guest call runs a nested loop the host can't
	 *  drive — this hook is where a debugger regains control there (it may block, e.g. Atomics.wait, and read
	 *  machine state before returning to resume). Fires just before the breakpointed statement executes. */
	"onBreakpoint"?: (vm: VM) => void;
	/** A fuel limit: once `steps` exceeds this, the next `step()` throws an uncatchable error (guest try/catch
	 *  can't swallow it). Lets a host run untrusted code with a bounded cost — e.g. a language-server-resident
	 *  driver that must never hang on a `while (true)`. Default undefined = unlimited (existing behavior). */
	"maxSteps"?: number;
	/** Count how often each statement runs (see `VM.coverage`). Off by default: it's one count per statement. */
	"coverage"?: boolean;
	/** Tally where the run's work goes (see `VM.profile`): per top-level statement. Off by default: a count a statement. */
	"profile"?: boolean;
	/** The program's modules (modules.ts, README.md, *Modules*): its host's loader — resolution, what isn't the program's loaded
	 *  natively, a program file's source, the module cache. tsval evaluates the program's own files, each in a module
	 *  frame on the stack that required or imported it, so stepping goes into them; breakpoints and locations are by
	 *  file. Without one, an import is `resolveModule`'s. */
	"modules"?: ModuleLoader;
	/** Told what went through a few chosen sites as the program runs — the facts runtime evidence keeps of values,
	 *  branches and types. Off by default: one check per site when it's off. See `ObserveSite` for each site's node
	 *  and value. The callback must not run guest code (read values with `typeTag`, which never does). */
	"observe"?: Observer;
	/** Told each value a statement bound, returned or chose, in order, with which call and loop iteration it was in —
	 *  what a debugger shows beside each line (a live-values panel). Off by default. See `TraceEvent`. The callback
	 *  must not run guest code. */
	"trace"?: Tracer;
	/** Told each write a call makes that escapes it: to a binding of a scope, or an object, made before the call began (a
	 *  module's variable, an argument, `this` outside its constructor, what a closure holds) — directly, or by a built-in
	 *  that mutates its receiver or first argument (`push`, `Map.set`, `Object.assign`). Off by default. See `EscapeEvent`.
	 *  The callback must not run guest code. Told too, for each call on the stack, what else makes a call impure: a
	 *  nondeterministic read, an effect, and a call into code it can't see into (`EscapeEvent.kind`). */
	"escapes"?: Escaper;
	/** With `escapes`, the host functions the embedder watches itself — it tells their effects (`Machine.impure`) — so a
	 *  call of one isn't `unwatched` (its console, its stand-ins for the file system and the network). */
	"watches"?: WeakSet<object>;
	/** Told each call of a guest function as it begins (its node): with `escapes`, how often a function ran, impure or
	 *  not. Off by default. */
	"called"?: (fn: ts.Node) => void;
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
 * first, each with its turn (from 0) — shared by the events of a turn, so read-only; `step` is the statement clock's
 * reading (VM.statements): the events of one statement share it.
 */
export interface TraceEvent {
	"kind": "bind" | "return" | "branch";
	"node": ts.Node;
	"name": string;
	"value": unknown;
	"step": number;
	"call": number;
	"callee"?: ts.Node;
	"loops": readonly { readonly "node": ts.Node; readonly "turn": number }[];
}

/** What a loop frame in a turn tells its turn's trace events (NodeFrame.traceContext): its call, and the loops around
 *  the values, itself last — the same for each value of the turn. */
export interface TraceContext {
	"turn": number;
	"call": number;
	"callee": ts.Node | undefined;
	"loops": TraceEvent["loops"];
}

/** The loops of a value in no loop (in its call). */
const NO_LOOPS: TraceEvent["loops"] = Object.freeze([]);

export type Tracer = (event: TraceEvent) => void;

/** A write a call made to a binding or object that was there before the call began — what a pure function doesn't do
 *  (silo README, *Purity*): the function whose call it was (`function`, its node), the call's number, what was written
 *  (a binding's name, a property's key, a mutating method's name) and where (`node`, the node being evaluated). */
export interface EscapeEvent { "function": ts.Node; "call": number; "kind": ImpureKind; "what": string; "node": ts.Node | null }

/**
 * What made a call impure, as escapes tells it:
 * - `write`: to a binding or object that was there before the call began;
 * - `effect`: something done to the world — a timer set, or what the embedder tells (`Machine.impure`): its console,
 *   a file read or written, a request;
 * - `nondeterministic`: a read of the clock or of random numbers (`Date.now()`, `new Date()`, `Math.random()`,
 *   `performance.now()`, `crypto.randomUUID()`) — seeded under an event loop, so the run repeats, yet not the same
 *   from one real run to the next;
 * - `unwatched`: a call into code it can't see into — a host function that isn't one of ECMAScript's built-ins or the
 *   embedder's watched ones (a package's, almostnode's `path`): it may do any of the others.
 */
export type ImpureKind = "write" | "effect" | "nondeterministic" | "unwatched";

export type Escaper = (event: EscapeEvent) => void;

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
	/** Monotonic count of `step()` calls — a free step budget. How many steps a stretch of code takes is the frame
	 *  machine's own business (an operand may be read in its parent's step); for a position in the run, `statements`. */
	readonly "steps": number;
	/** The statement clock: how many statements have started. The engine-independent reading of where a run is
	 *  (README.md, *A compiled tier*) — a trace event's `step`, the profile's. */
	readonly "statements": number;

	// --- position, breakpoints ---
	readonly "currentNode": ts.Node | null;
	"location": (node?: ts.Node | null) => { "file": string; "line": number; "character": number; "pos": number } | null;
	/** Where a value escaping the run uncaught was first thrown (null for a primitive, or one not thrown here). */
	"throwSite": (value: unknown) => ts.Node | null;
	/** Breakpoints, by file and position: `file:pos`. */
	readonly "breakpoints": Set<string>;
	"addBreakpoint": (pos: number, file?: string) => void;
	/** Add breakpoints by 1-based line in a program file (VMOptions.modules) — loaded yet or not. */
	"addBreakpointsInFile": (file: string, ...lines: number[]) => void;
	/** Evaluate a module its loader made and cached already (a program file a package required), in a nested run. */
	"evaluateModule": (record: ModuleRecord) => unknown;
	"addBreakpointsByLine": (...lines: number[]) => void;
	"atBreakpoint": () => boolean;
	"runToBreakpoint": () => void;

	/** How often each statement has run, when created with `coverage: true` (undefined otherwise) — exact, not
	 *  sampled: every statement execution passes through `step()`. By program file, for each file a statement of it ran
	 *  in: its statements in source order and a count for each (0, never ran). A fork carries its own copy, so a fork's
	 *  counts are its own timeline's. */
	readonly "coverage": ReadonlyMap<ts.SourceFile, FileCoverage> | undefined;

	/** Where the run's work went, when created with `profile: true` (undefined otherwise): per top-level statement of the
	 *  program, by where the code is — a function's statement gets the work done in its body, wherever it was called
	 *  from — the statements run in its code, the virtual time waited before its code ran again (a timer firing: the
	 *  event loop's clock moving on), and the statement clock's reading when it first ran (`statements`). Deterministic,
	 *  as the run is. A fork carries its own copy. */
	readonly "profile": ReadonlyMap<ts.Statement, StatementProfile> | undefined;

	/** An independent copy of the machine state (mid-expression if need be); host objects are shared. */
	"fork": () => VM;

	/** Something other than a write made each call on the stack impure (VMOptions.escapes): what the embedder watches
	 *  (VMOptions.watches) tells its effects here — its console's output, a file read, a request. */
	"impure": (kind: "effect" | "nondeterministic" | "unwatched", what: string) => void;

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
	/** The statement clock (VM.statements): statements started. */
	public statements = 0;
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
	/** VMOptions.asyncContext. */
	public asyncContext: AsyncContext | undefined;
	/** This machine and its forks: whose guest functions it steps into (values.ts ownedBy). */
	public family: object = {};
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
	/** Stepped async: an awaited promise's awaiter — the frames of the async function cut off waiting on it — as V8
	 *  follows an await back to its caller for a stack's `at async …` (sitesHere). */
	private awaitedBy = new WeakMap<object, Frame[]>();
	/** Stepped async: what settled, in the order it did — shared with forks (a host promise calls back once, into it). */
	private scheduler: AsyncScheduler = { "settled": [], "ids": 0, "wakers": [], "promises": new OwnPromises() };
	/** Stepped async: where in what settled this machine's next job may be — before it, none is pending here. */
	private settledFrom = 0;
	/** How many nested contexts (a host-called guest function's sub-run, a fiber's) the machine is inside: stepped
	 *  async applies on the main stack only (depth 0); a nested context keeps the fiber drivers' behavior. */
	private depth = 0;
	/** The contexts saved on entering a nested one, by depth, reused (with the stacks a sub-run there runs on): a callback
	 *  a host built-in calls — map's, sort's, a server's handler — enters and leaves one each call, so it allocates none. */
	private contexts: ExecContext[] = [];
	/** Fuel limit (see VMOptions.maxSteps): once `steps` passes it, `step()` throws uncatchably. */
	public maxSteps: number | undefined;
	/** Statement execution counts (VMOptions.coverage), by file. */
	public coverage: Map<ts.SourceFile, FileCoverage> | undefined;
	/** The file statements last counted in, and its counts (cover): a run stays in one file for long stretches. */
	private covering: { "table": StatementTable; "counts": number[] } | undefined;
	/** Where the work went (VMOptions.profile), and the virtual time waited that the next step's statement is owed. */
	public profile: Map<ts.Statement, StatementProfile> | undefined;
	private waitedPending = 0;
	/** Each node's top-level statement (a profile's key), as found. */
	private readonly topOf = new WeakMap<ts.Node, ts.Statement | null>();
	/** Each node's entry in `profile` (null: none, it's in no top-level statement), as found: a fork's are its own. */
	private tallies: { "profile": Map<ts.Statement, StatementProfile>; "entries": WeakMap<ts.Node, StatementProfile | null> } | undefined;
	/** What chosen sites are told to (VMOptions.observe). */
	public observe: Observer | undefined;
	/** What each value bound, returned or chosen is told to (VMOptions.trace). */
	public trace: Tracer | undefined;
	/** How many calls and constructions have been made: the last one's number (FrameBase.call). */
	public calls = 0;
	/** What escaping writes are told to (VMOptions.escapes). */
	public escapes: Escaper | undefined;
	/** Each object's `calls` when it was made (VMOptions.escapes): one made before a call began is outside it. */
	public readonly madeIn = new WeakMap<object, number>();
	/** The host's built-ins that write into their receiver (`this`) or their first argument, by function (built once). */
	private writers: Map<unknown, { "name": string; "first"?: true }> | undefined;
	/** The host's built-ins that hand back a new array or object. */
	private freshMakers: Set<unknown> | undefined;
	/** VMOptions.watches and VMOptions.called. */
	public watches: WeakSet<object> | undefined;
	public called: ((fn: ts.Node) => void) | undefined;
	/** What a host call is to purity, by function (VMOptions.escapes; built once): a nondeterministic read (`clock`; a
	 *  `Date` only with no arguments), an effect, or a built-in it sees into (`watched`). */
	private hostKinds: { "clock": Map<unknown, { "name": string; "bare"?: true }>; "effects": Map<unknown, string>; "watched": Set<unknown> } | undefined;
	/** The event loop's globals this machine was given (its timers, clock and random generator). */
	private loopFns: Record<string, unknown> | undefined;

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
	/** VMOptions.modules: the program's module loader, and its files as parsed (shared with forks). */
	public modules: ModuleLoader | undefined;
	private parsed = new Map<string, ts.SourceFile>();
	/** Breakpoints, as `file:pos` (see `addBreakpoint` / `addBreakpointsByLine` / `addBreakpointsInFile`). */
	public readonly breakpoints = new Set<string>();
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
			this.loop.wake = () => { wake(this.scheduler); };
			this.loopFns = loopGlobals();
			Object.assign(globals, this.loopFns);
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
		this.rootScope.sharedGlobals = options.sharedGlobals;
		this.resolveModule = options.resolveModule;
		this.hostGuard = options.hostGuard;
		this.onAsyncFiber = options.onAsyncFiber;
		this.asyncContext = options.asyncContext;
		this.onBreakpoint = options.onBreakpoint;
		this.steppedAsync = options.steppedAsync === true || options.eventLoop !== undefined;
		this.maxSteps = options.maxSteps;
		this.coverage = options.coverage === true ? new Map() : undefined;
		this.profile = options.profile === true ? new Map() : undefined;
		this.modules = options.modules;
		this.observe = options.observe;
		this.trace = options.trace;
		this.escapes = options.escapes;
		this.watches = options.watches;
		this.called = options.called;
	}

	/** A statement started (`node`), to its file's coverage: its counts found once per change of file. */
	private cover(node: ts.Node): void {
		const { table, index } = statementPoint(node);
		let covering = this.covering;

		if (covering?.table !== table) {
			let entry = this.coverage!.get(table.file);

			if (entry === undefined) {
				entry = { "statements": table.statements, "counts": Array.from(table.statements, () => 0) };
				this.coverage!.set(table.file, entry);
			}

			covering = { "table": table, "counts": entry.counts };
			this.covering = covering;
		}

		covering.counts[index] += 1;
	}

	/** A statement started in `node`'s code (or a declaration's step, a concise arrow body entered), to its top-level
	 *  statement's profile — with the virtual time waited before it, if any. */
	public tally(node: ts.Node): void {
		const profile = this.profile!;

		// Each node's entry, as found (null: not in a top-level statement), for the profile it's in: one lookup a step.
		if (this.tallies?.profile !== profile) {
			this.tallies = { "profile": profile, "entries": new WeakMap() };
		}

		const { entries } = this.tallies;
		let entry = entries.get(node);

		if (entry === undefined) {
			let top = this.topOf.get(node);

			if (top === undefined) {
				let at: ts.Node | undefined = node;

				while (at !== undefined && at.parent !== undefined && !isSourceFile(at.parent)) {
					at = at.parent;
				}

				top = at !== undefined && at.parent !== undefined && isSourceFile(at.parent) ? at as ts.Statement : null;
				this.topOf.set(node, top);
			}

			entry = top === null ? null : profile.get(top) ?? null;

			if (top !== null && entry === null) {
				entry = { "statements": 0, "waited": 0, "first": this.statements };
				profile.set(top, entry);
			}

			entries.set(node, entry);
		}

		if (entry === null) {
			return;
		}

		entry.statements += 1;
		entry.waited += this.waitedPending;
		this.waitedPending = 0;
	}

	/** The next call's number (FrameBase.call). */
	public nextCall(): number {
		this.calls += 1;
		Scope.clock = this.calls;

		return this.calls;
	}

	/** `value`, made now (VMOptions.escapes: a call that began after now didn't make it). */
	public made<T>(value: T): T {
		if (this.escapes !== undefined && ((typeof value === "object" && value !== null) || typeof value === "function")) {
			this.madeIn.set(value as object, this.calls);
		}

		return value;
	}

	/** A write to `target` — a binding's scope (undefined: a global), or an object — told (VMOptions.escapes) for each call
	 *  on the stack that began after it was made: the call making it, and each caller it escapes too (a function is impure
	 *  by what it calls, as silo's purity check judges). A constructor writing its own instance, or a field initializer,
	 *  escapes nothing. */
	public wrote(target: Scope | object | undefined, what: string, kind: ImpureKind = "write"): void {
		if (this.escapes === undefined) {
			return;
		}

		const born = target === undefined ? -1 : target instanceof Scope ? target.born : this.madeIn.get(target) ?? -1;
		// (a nested run — a getter, a callback the host calls — has a stack of its own; the ones around it were saved as it
		// began, innermost last)
		const stacks: Frame[][] = [this.frames];

		for (let depth = this.depth - 1; depth >= 0; depth -= 1) {
			const saved = this.contexts[depth];

			if (saved !== undefined) {
				stacks.push(saved.frames);
			}
		}

		for (const frame of stacks.flatMap((stack) => [...stack].reverse())) {
			if (frame.kind === "construct") {
				return;
			}

			if (frame.kind !== "call") {
				continue;
			}

			const call = frame.call ?? 0;

			// (a constructor writing its own instance: the instance is what it makes)
			if (target !== undefined && target === frame.thisArg && ts.isConstructorDeclaration(frame.node)) {
				return;
			}

			// (calls began in order: an outer one that began after the target was made, the target is its own too)
			if (born >= call) {
				return;
			}

			this.escapes({ "function": frame.node, "call": call, "kind": kind, "what": what, "node": this.currentNode });
		}
	}

	/** Something other than a write made each call on the stack impure (VMOptions.escapes): an effect the embedder
	 *  watches (`what`: its console's method, a capability), say — told to every call, as a write to the world. */
	public impure(kind: Exclude<ImpureKind, "write">, what: string): void {
		this.wrote(undefined, what, kind);
	}

	/** A host call, as purity sees it (VMOptions.escapes): a nondeterministic read, an effect, or — neither one of
	 *  ECMAScript's built-ins nor watched by the embedder — code it can't see into. */
	private watchHost(callee: unknown, args: unknown[]): void {
		const kinds = this.hostKindsOf();
		const clock = kinds.clock.get(callee);

		if (clock !== undefined) {
			if (clock.bare !== true || args.length === 0) {
				this.wrote(undefined, clock.name, "nondeterministic");
			}

			return;
		}

		const effect = kinds.effects.get(callee);

		if (effect !== undefined) {
			this.wrote(undefined, effect, "effect");
		} else if (!kinds.watched.has(callee) && !INTRINSICS.has(callee as object) && this.watches?.has(callee as object) !== true) {
			this.wrote(undefined, (callee as { "name"?: string }).name || "(a host function)", "unwatched");
		}
	}

	/** The host's nondeterministic reads, its effects and the built-ins seen into, from this machine's globals and the
	 *  event loop's (built the first time they're asked for). */
	private hostKindsOf(): NonNullable<Machine["hostKinds"]> {
		if (this.hostKinds === undefined) {
			const globals = this.rootScope.globalObject as Record<string, unknown>;
			const host = globalThis as unknown as Record<string, Record<string, unknown> | undefined>;
			const clock = new Map<unknown, { "name": string; "bare"?: true }>();
			const effects = new Map<unknown, string>();
			const watched = new Set<unknown>();
			const functionsOf = (holder: unknown): unknown[] => (holder === null || (typeof holder !== "object" && typeof holder !== "function") ? [] : Object.getOwnPropertyNames(holder).flatMap((name) => {
				const descriptor = Object.getOwnPropertyDescriptor(holder, name);

				return typeof descriptor?.value === "function" ? [descriptor.value] : [];
			}));

			for (const name of STANDARD_GLOBAL_NAMES) {
				const value = (globals[name] ?? (globalThis as Record<string, unknown>)[name]) as { "prototype"?: unknown } | undefined;

				if (typeof value === "function") {
					watched.add(value);
					functionsOf(value.prototype).forEach((each) => watched.add(each));
				}

				functionsOf(value).forEach((each) => watched.add(each));
			}

			// (the prototypes no global names: typed arrays', iterators')
			const typedArray = Object.getPrototypeOf(Int8Array) as { "prototype": unknown };

			for (const holder of [typedArray, typedArray.prototype, Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(new Map().entries()), Object.getPrototypeOf(new Set().values()), Object.getPrototypeOf(""[Symbol.iterator]()), Object.getPrototypeOf(/a/u[Symbol.matchAll](""))]) {
				functionsOf(holder).forEach((each) => watched.add(each));
			}

			for (const [dates, maths] of [[globalThis.Date, globalThis.Math], [this.loopFns?.["Date"], this.loopFns?.["Math"]]] as [DateConstructor | undefined, Math | undefined][]) {
				if (dates !== undefined) {
					clock.set(dates, { "name": "Date", "bare": true });
					clock.set(dates.now, { "name": "Date.now" });
				}

				if (maths !== undefined) {
					clock.set(maths.random, { "name": "Math.random" });
				}
			}

			const loopCrypto = this.loopFns?.["crypto"] as Record<string, unknown> | undefined;

			clock.set((this.loopFns?.["performance"] as Record<string, unknown> | undefined)?.["now"], { "name": "performance.now" });
			clock.set(loopCrypto?.["randomUUID"], { "name": "crypto.randomUUID" });
			clock.set(loopCrypto?.["getRandomValues"], { "name": "crypto.getRandomValues" });
			clock.set(host["performance"]?.["now"], { "name": "performance.now" });
			clock.set(host["crypto"]?.["randomUUID"], { "name": "crypto.randomUUID" });
			clock.set(host["crypto"]?.["getRandomValues"], { "name": "crypto.getRandomValues" });
			clock.delete(undefined);

			for (const name of ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask"]) {
				for (const fn of [this.loopFns?.[name], (globalThis as Record<string, unknown>)[name]]) {
					if (typeof fn === "function") {
						effects.set(fn, name);
					}
				}
			}

			if (typeof globalThis.fetch === "function") {
				effects.set(globalThis.fetch, "fetch");
			}

			this.hostKinds = { "clock": clock, "effects": effects, "watched": watched };
		}

		return this.hostKinds;
	}

	/** A write to the binding `name` as `scope` sees it (the scope holding it; none — a global): told when escaping. */
	public wroteName(scope: Scope, name: string): void {
		if (this.escapes === undefined) {
			return;
		}

		let holder: Scope | undefined = scope;

		while (holder !== undefined && !holder.bindings.has(name)) {
			holder = holder.parent;
		}

		this.wrote(holder, name);
	}

	/** The host's writers and fresh-value makers, from this machine's realm (built the first time they're asked for). */
	private hostWriters(): { "writers": Map<unknown, { "name": string; "first"?: true }>; "fresh": Set<unknown> } {
		if (this.writers === undefined || this.freshMakers === undefined) {
			const array = this.realm.Array.prototype as unknown as Record<string, unknown>;
			const object = this.realm.Object as unknown as Record<string, unknown>;
			const writers = new Map<unknown, { "name": string; "first"?: true }>();

			for (const name of ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]) {
				writers.set(array[name], { "name": name });
			}

			for (const [kind, names] of [[Map, ["set", "delete", "clear"]], [Set, ["add", "delete", "clear"]], [WeakMap, ["set", "delete"]], [WeakSet, ["add", "delete"]]] as const) {
				for (const name of names) {
					writers.set((kind.prototype as unknown as Record<string, unknown>)[name], { "name": name });
				}
			}

			for (const name of ["assign", "defineProperty", "defineProperties", "setPrototypeOf", "freeze", "seal", "preventExtensions"]) {
				writers.set(object[name], { "name": name, "first": true });
			}

			for (const name of ["set", "defineProperty", "deleteProperty", "setPrototypeOf", "preventExtensions"]) {
				writers.set((Reflect as unknown as Record<string, unknown>)[name], { "name": "Reflect." + name, "first": true });
			}

			// (a typed array's, and a Date's setters)
			const typed = (Object.getPrototypeOf(Int8Array) as { "prototype": Record<string, unknown> }).prototype;

			for (const name of ["set", "fill", "sort", "reverse", "copyWithin"]) {
				writers.set(typed[name], { "name": name });
			}

			for (const name of Object.getOwnPropertyNames(Date.prototype).filter((each) => each.startsWith("set"))) {
				writers.set((Date.prototype as unknown as Record<string, unknown>)[name], { "name": name });
			}

			this.writers = writers;
			this.freshMakers = new Set([...["map", "filter", "slice", "concat", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with"].map((name) => array[name]), (this.realm.Array as unknown as Record<string, unknown>)["from"], (this.realm.Array as unknown as Record<string, unknown>)["of"], ...["keys", "values", "entries", "fromEntries", "groupBy"].map((name) => object[name]), JSON.parse, String.prototype.split, String.prototype.match]);
		}

		return { "writers": this.writers, "fresh": this.freshMakers };
	}

	/** Tell the tracer (VMOptions.trace), if any, a value `node` bound, returned or chose: with the call it's in and the
	 *  turn of each loop around it there, from the innermost loop in a turn (or call) on the frame stack. */
	public traced(kind: TraceEvent["kind"], node: ts.Node, name: string, value: unknown): void {
		if (this.trace === undefined) {
			return;
		}

		const { frames } = this;
		let call = 0;
		let callee: ts.Node | undefined;
		let loops = NO_LOOPS;

		for (let index = frames.length - 1; index >= 0; index -= 1) {
			const frame = frames[index]!;

			if (frame.kind === "call" || frame.kind === "construct") {
				call = frame.call ?? 0;
				callee = frame.node ?? undefined;
				break;
			}

			if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
				({ call, callee, loops } = this.traceContext(frame, index));
				break;
			}
		}

		// (two literals rather than a spread for the optional `callee`: an event is made for nearly every binding)
		this.trace(callee === undefined
			? { "kind": kind, "node": node, "name": name, "value": value, "step": this.statements, "call": call, "loops": loops }
			: { "kind": kind, "node": node, "name": name, "value": value, "step": this.statements, "call": call, "callee": callee, "loops": loops });
	}

	/** `loop`'s trace context (at `index` on the stack) in its current turn: made once a turn, from the next loop in a
	 *  turn (or call) below it, and kept on the frame — the frames below a loop's don't change while it's on the stack
	 *  (a fiber's or generator's move with their call frame, a fork's frames find their own afresh). */
	private traceContext(loop: NodeFrame, index: number): TraceContext {
		const kept = loop.traceContext;

		if (kept !== undefined && kept.turn === loop.turn) {
			return kept;
		}

		let call = 0;
		let callee: ts.Node | undefined;
		let outer = NO_LOOPS;

		for (let below = index - 1; below >= 0; below -= 1) {
			const frame = this.frames[below]!;

			if (frame.kind === "call" || frame.kind === "construct") {
				call = frame.call ?? 0;
				callee = frame.node ?? undefined;
				break;
			}

			if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
				({ call, callee, "loops": outer } = this.traceContext(frame, below));
				break;
			}
		}

		const context: TraceContext = { "turn": loop.turn!, "call": call, "callee": callee, "loops": [...outer, { "node": loop.node, "turn": loop.turn! }] };

		loop.traceContext = context;

		return context;
	}

	public get top(): Frame | undefined {
		const { frames } = this;

		// (never `frames[-1]`: see advance)
		return frames.length > 0 ? frames[frames.length - 1] : undefined;
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
		// A module's require, called where its file can't be pushed on the stack (calls.ts pushes it where it can).
		const requiring = requireOf(callee);

		if (requiring !== undefined && !isConstruct) {
			return this.fromHost(this.requireFrom(requiring, String(args[0])));
		}

		if (this.escapes !== undefined) {
			this.watchHost(callee, args);
		}

		// The event loop's intrinsics act on this machine (event-loop.ts) — trusted, so ahead of the guard.
		const intrinsic = INTRINSICS.get(callee);

		if (intrinsic !== undefined) {
			return this.fromHost(intrinsic(this, thisArg, args, isConstruct));
		}

		// Stepped async: a promise the program makes, and what reacts to it, are this machine's (promises.ts) — at any
		// depth, its jobs the main loop's; not once it's finished, with no loop to run them.
		if (this.steppedAsync && !this.finished) {
			const own = this.ownPromiseCall(callee, thisArg, args, isConstruct);

			if (own !== NOT_OWN) {
				if (this.escapes !== undefined) {
					this.made(own);
				}

				return this.fromHost(own);
			}
		}

		const previousSite = this.callSite;
		const { prototype } = this.realm.Promise;

		const promisingFn = (fn: unknown): boolean => fn === prototype.then || fn === prototype.catch || fn === prototype.finally;
		const { "call": call, "apply": apply } = this.realm.Function.prototype;
		// (a promise's then, catch or finally — called, or forwarded by call, apply or Reflect.apply: a guest callback that
		// slipped past a forwarder ran ahead of the jobs queued before it, 2026-11-23)
		const forwarded = isConstruct ? undefined
			: (callee === call && promisingFn(thisArg)) ? "call"
				: (callee === apply && promisingFn(thisArg) && Array.isArray(args[1])) ? "apply"
					: (callee === Reflect.apply && promisingFn(args[0]) && Array.isArray(args[2])) ? "reflect"
						: undefined;
		const promising = promisingFn(callee) || forwarded !== undefined;
		// Stepped async: guest handlers a host promise (one this machine doesn't know) will call are one job, run on the
		// main stack — through the host's `then`, whose one call of the two wrappers says how it settled.
		if (this.steppedHere && !isConstruct && promising) {
			const [method, receiver, handlers] = forwarded === "call" ? [thisArg, args[0], args.slice(1)]
				: forwarded === "apply" ? [thisArg, args[0], args[1] as unknown[]]
					: forwarded === "reflect" ? [args[0], args[1], args[2] as unknown[]]
						: [callee, thisArg, args];

			if (handlers.some((handler) => ownedBy(handler, this))) {
				return this.fromHost(this.hostReaction(method, receiver, handlers));
			}
		}

		this.callSite = site; // (set BEFORE the guard runs: a guard may read it, or the `site` argument)

		// A built-in writing into what it's given (VMOptions.escapes): its receiver, or its first argument.
		const writer = this.escapes === undefined || isConstruct ? undefined : this.hostWriters().writers.get(callee);
		const into = writer === undefined ? undefined : writer.first === true ? args[0] : thisArg;

		if (writer !== undefined && ((typeof into === "object" && into !== null) || typeof into === "function")) {
			this.wrote(into as object, writer.name);
		}

		// (this machine noted as the one calling: a timer native code sets is this machine's — event-loop.ts hostCalling)
		const callingBefore = hostCalling(this);

		try {
			const target = this.hostGuard?.beforeCall === undefined ? callee : this.hostGuard.beforeCall(callee, thisArg, isConstruct, { "node": site, "args": args, "isConstruct": isConstruct });
			const result = isConstruct ? Reflect.construct(target as unknown as new (...ctorArgs: unknown[]) => unknown, args) : target.apply(thisArg, args);

			// An error the program makes has its stack, not the interpreter's (stacks.ts); as does what it captures one on.
			if (this.makesError(callee, isConstruct, result)) {
				this.giveProgramStack(result, undefined, false, site);
			} else if (this.capturesStack(callee)) {
				this.giveProgramStack(args[0], args[1], true, site);
			}

			// (what a host constructor or a fresh-value maker hands back is made now)
			if (this.escapes !== undefined && (isConstruct || this.hostWriters().fresh.has(callee))) {
				this.made(result);
			}

			const value = this.fromHost(result);

			// Event loop: a promise a host call returns is external — when it settles isn't the program's to say. The
			// program gets one of its own instead, settled when the result's arrival is delivered as an event (event-loop.ts),
			// so nothing — not even Promise.race — sees it before. (Not a promise the program makes itself — `new Promise`,
			// a promise's methods and statics: that's the program chaining what it has.)
			// (and not one this machine made: an async generator's request, say — promises.ts)
			if (this.loop !== undefined && this.steppedHere && !promising && (callee as unknown) !== this.realm.Promise && !isPromiseStatic(this.realm.Promise, callee) && isThenable(value) && !this.scheduler.promises.knows(value)) {
				return this.awaitResult(value, this.callLabel(site, callee, args));
			}

			return value;
		} catch (error) {
			// (a built-in's error the program may catch: its stack the program's, from the call)
			if (!isUncatchable(error)) {
				this.giveProgramStack(error, undefined, false, site);
			}

			throw error;
		} finally {
			hostCalling(callingBefore);
			this.callSite = previousSite;
		}
	}

	/** Resolve a module namespace, or throw a guest-catchable error if unresolved — from `from`'s code, through the
	 *  program's module loader when there is one (VMOptions.modules). */
	public importModule(specifier: string, from?: string): unknown {
		if (this.modules !== undefined && from !== undefined) {
			return this.requireFrom(from, specifier);
		}

		const ns = this.resolveModule?.(specifier);

		if (ns === undefined) {
			throw new Error(`Cannot find module '${specifier}'`);
		}

		return ns;
	}

	/** Seat a parsed SourceFile as the initial frame. */
	public load(sourceFile: ts.SourceFile): void {
		const broken = syntaxErrorIn(sourceFile);

		if (broken !== undefined) {
			throw broken;
		}

		this.sourceFile = sourceFile;

		// With the program's modules (VMOptions.modules), the entry is one of them: a module of its own, as Node runs it.
		if (this.modules !== undefined) {
			this.parsed.set(sourceFile.fileName, sourceFile);
			this.pushModule(sourceFile.fileName);

			return;
		}

		this.pushNode(sourceFile, this.rootScope);
	}

	// --- frame / value helpers ------------------------------------------------

	public pushNode(node: ts.Node, scope: Scope): NodeFrame {
		// (`kind` is set, if undefined, so every frame has it first: `step` reads it of each)
		const frame: NodeFrame = { "kind": undefined, "node": node, "phase": 0, "scope": scope, "valuesBase": this.values.length };

		this.frames.push(frame);

		return frame;
	}

	/**
	 * `nodes`, to evaluate in order, for a handler that goes on with their values: each leading simple one (a leaf — an
	 * identifier, a literal — or leaves under plain operators: operators.ts isSimpleTree) is evaluated here, its value
	 * pushed, and the rest pushed as frames, reversed so the first evaluates first. The values land as they would have, in
	 * the same order — and a simple operand costs no step: a step is most of the work of reading a leaf. True when they
	 * were all simple, their values on the stack already: the handler can go on in this step.
	 */
	public pushOperands(nodes: readonly ts.Node[], scope: Scope): boolean {
		let leading = 0;

		while (leading < nodes.length && isSimpleTree(nodes[leading])) {
			this.values.push(simpleValue(this, nodes[leading], scope));
			leading += 1;
		}

		for (let index = nodes.length - 1; index >= leading; index--) {
			this.pushNode(nodes[index], scope);
		}

		return leading === nodes.length;
	}

	/** One operand (pushOperands): true when it was simple, its value pushed already. */
	public pushOperand(node: ts.Node, scope: Scope): boolean {
		if (isSimpleTree(node)) {
			this.values.push(simpleValue(this, node, scope));

			return true;
		}

		this.pushNode(node, scope);

		return false;
	}

	/** A leaf's value (operators.ts LEAVES), read in `scope`: where an identifier, a literal, `true`/`false`/`null` is
	 *  evaluated — its own frame's step (literals.ts) or its parent's (pushOperands). */
	public leafValue(node: ts.Node, scope: Scope): unknown {
		switch (node.kind) {
			case IDENTIFIER:
				// Globals are host values; guest bindings pass through the guard unchanged (identity by default).
				return this.fromHost(scope.get((node as ts.Identifier).text));
			case NUMERIC_LITERAL: {
				const { text } = node as ts.NumericLiteral;

				return Number(text.includes("_") ? text.replace(/_/gu, "") : text); // (separators are rare: skip the regex without)
			}
			case TRUE_KEYWORD:
				return true;
			case FALSE_KEYWORD:
				return false;
			case NULL_KEYWORD:
				return null;
			default:
				return (node as ts.LiteralLikeNode).text; // a string, a template without substitutions
		}
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
		this.advance(false);
	}

	/**
	 * One step — or, with `stopAtBreakpoint`, none when the top frame is a fresh statement on a breakpoint (true then):
	 * `atBreakpoint()` and `step()` in one, as a run to a breakpoint asks them at every step, so the frame's fields are read
	 * once. (Reading a field of a frame here is slow: frames come in many shapes.)
	 */
	private advance(stopAtBreakpoint: boolean): boolean {
		if (this.finished) {
			return false;
		}

		// Stepped async, between tasks (the stack empty): the next settled job, or idle while work is pending.
		if (this.frames.length === 0 && this.steppedAsync && this.depth === 0 && this.signal === null) {
			if (this.resumeSettled() || this.fireEvent()) {
				return false;
			}

			if (this.pending.size > 0 || (this.loop !== undefined && (hasRefTimers(this.loop) || this.loop.results.size > 0 || this.loop.keepAlive?.() === true))) {
				this.idle = true;

				return false;
			}
		}

		const { frames } = this;
		const at = frames.length - 1;
		// (never `frames[-1]`: a read out of bounds turns the load megamorphic, for every later step)
		const frame = at >= 0 ? frames[at] : undefined;

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

			return false;
		}

		const { kind, node } = frame;
		// (a synthetic frame has no node kind: 0, SyntaxKind.Unknown, is in none of the tables by kind)
		const nodeKind = kind === undefined ? node.kind : 0;
		// A fresh statement: where a breakpoint stops, and what coverage counts.
		const statementStart = nodeKind >= FIRST_STATEMENT && nodeKind <= LAST_STATEMENT && frame.phase === 0;

		// (atBreakpoint's test, on what's read already)
		if (stopAtBreakpoint && statementStart && this.breakpoints.size > 0 && this.breakpoints.has(breakpointKey(node!))) {
			return true;
		}

		this.steps += 1;

		// Fuel limit: bail uncatchably so untrusted code can't hang a host (e.g. a language-server-resident driver).
		if (this.maxSteps !== undefined && this.steps > this.maxSteps) {
			throw new TsvalInternalError(`step budget exceeded (${this.maxSteps})`);
		}

		if (this.signal !== null) {
			this.unwind(frame, this.signal);

			// (a `for await` left, awaiting its iterator's `return()`: cut off as an `await` is)
			if (this.paused && this.pauseKind === "await" && this.steppedAsync && this.depth === 0) {
				this.cut();
			}

			return false;
		}

		// A statement's first step (phase 0) is the statement starting — the same test a breakpoint uses. It moves the
		// statement clock; coverage counts it, and the profile gives it to the top-level statement whose code it's in
		// (with any time waited before it) — as it does a declaration's step (a function's or class's: not a statement
		// kind, but the step that puts its card in order) and a concise arrow body's entry, for the statement it stands
		// for (`() => f(x)`'s `return f(x)`: otherwise its work and its waits would be no one's).
		if (statementStart) {
			this.statements += 1;

			if (this.profile !== undefined) {
				this.tally(node!);
			}

			if (this.coverage !== undefined) {
				this.cover(node!);
			}
		} else if (this.profile !== undefined && frame.phase === 0 && (kind === "call" ? node!.body!.kind !== BLOCK : DECLARATIONS[nodeKind] === 1)) {
			this.tally(node!);
		}

		// (each synthetic handler is typed for its own frame; the union is dispatched on `kind` here)
		const handler = (kind !== undefined ? syntheticHandlers[kind] : nodeHandlers[nodeKind]) as ((vm: Machine, frame: Frame) => void) | undefined;

		if (handler === undefined) {
			if (kind !== undefined) {
				throw new TsvalInternalError(`unimplemented: ${kind}`);
			}

			throw new TsvalInternalError(`unimplemented: ${syntaxKindName(nodeKind)} (SyntaxKind ${nodeKind})`);
		}

		// Only a compound statement's frame has a completion mark (it's set here, nowhere else): the table by kind says so
		// before the frame is asked.
		const compound = COMPLETION_STATEMENTS[nodeKind] === 1 ? frame as NodeFrame : undefined;

		try {
			// A compound statement takes its completion mark when it STARTS (a block pushes all its
			// statements up front; earlier siblings run in between).
			if (compound !== undefined && compound.phase === 0 && compound.completionMark === undefined) {
				compound.completionMark = this.completionSerial;
			}

			handler(this, frame);
			// Still on the stack where it was (it ran a child, say) is the common case, and the cheap one to tell.
			if (compound?.completionMark !== undefined && this.frames[at] !== compound && !this.frames.includes(compound)) {
				this.finishStatement(compound);
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
				// (an interpreter gap — something not run yet — noted where it was met, as a throw is: a host says where)
				if (error instanceof TsvalInternalError) {
					this.noteThrow(error, frame.node);
				}

				throw error;
			}

			this.signal = { "type": "throw", "value": this.toGuestError(error) };
			// (a host built-in's error, or tsval's own for the program, caught here: the program's stack, from here)
			this.giveProgramStack(this.signal.value);
			this.noteThrow(this.signal.value, frame.node);
		}

		return false;
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
	public location(node: ts.Node | null = this.currentNode): { "file": string; "line": number; "character": number; "pos": number } | null {
		if (node === null || node === undefined) {
			return null;
		}

		// The node's own file: the program's modules are several (VMOptions.modules).
		const file = node.getSourceFile();
		const pos = node.getStart(file);
		const { line, character } = file.getLineAndCharacterOfPosition(pos);

		return { "file": file.fileName, "line": line, "character": character, "pos": pos };
	}

	/** Add a breakpoint at a node's start position in `file` (the program's entry, by default). */
	public addBreakpoint(pos: number, file: string | undefined = this.sourceFile?.fileName): void {
		this.breakpoints.add(`${file}:${pos}`);
	}

	/** Add breakpoints by 1-based source line in the entry: breaks at the first statement starting on each line. */
	public addBreakpointsByLine(...lines: number[]): void {
		if (this.sourceFile !== null && this.sourceFile !== undefined) {
			this.breakpointsAt(this.sourceFile, lines);
		}
	}

	/** Add breakpoints by 1-based line in a program file (VMOptions.modules), whether it's loaded yet or not. */
	public addBreakpointsInFile(file: string, ...lines: number[]): void {
		if (file === this.sourceFile?.fileName) {
			this.addBreakpointsByLine(...lines);
		} else if (this.modules !== undefined) {
			this.breakpointsAt(this.sourceOf(file), lines);
		}
	}

	private breakpointsAt(source: ts.SourceFile, lines: number[]): void {
		const wanted = new Set(lines);
		// Only a line's first statement, as V8 places a line's breakpoint: `try { call(); }` or `if (a) b();` stops once on
		// a continue, not again at the statement inside — and a loop's next pass stops there again. (Visited in order,
		// outer before inner, so the first seen on a line is its first.)
		const visit = (node: ts.Node): void => {
			if (isStatement(node)) {
				const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

				if (wanted.delete(line)) {
					this.breakpoints.add(`${source.fileName}:${node.getStart(source)}`);
				}
			}

			node.forEachChild(visit);
		};

		source.forEachChild(visit);
	}

	/** True when the top frame is a fresh statement sitting on a breakpoint. */
	public atBreakpoint(): boolean {
		// (none set is the common case of a run to its end: asked at every step, so asked first)
		if (this.breakpoints.size === 0) {
			return false;
		}

		const frame = this.top;

		if (frame === undefined || frame.kind !== undefined || frame.phase !== 0 || frame.node === null) {
			return false;
		}

		// Statement-level only: a statement and a child expression can share a start position.
		if (!isStatement(frame.node)) {
			return false;
		}

		return this.breakpoints.has(breakpointKey(frame.node));
	}

	// --- the program's modules (VMOptions.modules, modules.ts) ------------------

	/** A program file, parsed once — JSX by its extension. */
	public sourceOf(filename: string): ts.SourceFile {
		let source = this.parsed.get(filename);

		if (source === undefined) {
			source = createSourceFile(filename, this.modules!.source(filename), ts.ScriptTarget.Latest, true, /\.[jt]sx$/u.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
			this.parsed.set(filename, source);
		}

		return source;
	}

	/** Push `filename`'s module frame on this stack: its module registered first (a cycle sees its partial exports), its
	 *  scope its own — `module`, `exports`, `require`, `__filename`, `__dirname`, `this` its exports. */
	public pushModule(filename: string, record?: ModuleRecord): ModuleFrame {
		const source = this.sourceOf(filename);
		const broken = syntaxErrorIn(source);

		// (before it's registered: it never loaded, so required again it's tried again)
		if (broken !== undefined) {
			throw broken;
		}

		const loader = this.modules!;
		const module: ModuleRecord = record ?? { "id": filename, "filename": filename, "exports": {}, "loaded": false, "children": [], "paths": [] };
		const scope = new Scope(this.rootScope, true);
		const bindings: [string, unknown][] = [["module", module], ["exports", module.exports], ["require", makeRequire(loader, filename)], ["__filename", filename], ["__dirname", directoryOf(filename)]];

		for (const [name, value] of bindings) {
			scope.bindings.set(name, { "value": value, "kind": "var", "initialized": true });
		}

		scope.hasThis = true;
		scope.thisVal = module.exports;
		setModuleOf(scope, module);

		if (record === undefined) {
			loader.register(filename, module);
		}

		const frame: ModuleFrame = { "kind": "module", "node": null, "phase": 0, "scope": scope, "valuesBase": this.values.length, "source": source, "module": module };

		this.frames.push(frame);

		return frame;
	}

	/** A `require(specifier)` from `from`'s code, on this stack: a program file not loaded yet is its module frame pushed
	 *  (true) — its exports the call's value when it completes; anything else is false (the host's, through invokeHost). */
	public enterModule(from: string, specifier: unknown): boolean {
		if (this.modules === undefined || typeof specifier !== "string") {
			return false;
		}

		let resolved;

		try {
			resolved = this.modules.resolve(specifier, directoryOf(from));
		} catch {
			return false; // the host's require says so, as Node does
		}

		if (resolved.kind !== "program" || this.modules.cached(resolved.filename) !== undefined) {
			return false;
		}

		this.pushModule(resolved.filename);

		return true;
	}

	/** Evaluate a module its loader made and cached already (`record`): a program file a package required — the host's
	 *  module system calls back for it (almostnode's evaluateProgram). In a nested run: not on the main stack, so stepped
	 *  only through a breakpoint in it. */
	public evaluateModule(record: ModuleRecord): unknown {
		return this.runSub(() => { this.pushModule(record.filename, record); });
	}

	/** A module's value for `from`'s code, not on a stack it can wait on: a program file's exports (evaluated now, in a
	 *  nested run, if it isn't loaded yet) or what the host loads. */
	public requireFrom(from: string, specifier: string): unknown {
		const loader = this.modules!;
		const resolved = loader.resolve(specifier, directoryOf(from));

		if (resolved.kind !== "program") {
			return loader.require(specifier, directoryOf(from));
		}

		const cached = loader.cached(resolved.filename);

		return cached !== undefined ? cached.exports : this.runSub(() => { this.pushModule(resolved.filename); });
	}

	/** A file about to run (its program node's first step): the first program file it imports from that isn't loaded
	 *  yet, pushed first — true if there was one (it runs again once that has, for the next). One at a time, because a
	 *  module is loaded once it's pushed: pushing them all, a later one an earlier one imports (npm.test's
	 *  `./command.ts`, which pnpm.ts reads at its top level) looked loaded to it before it had run. So each import's
	 *  own imports run first, depth-first, each once — ESM's evaluation order. */
	public linkImports(source: ts.SourceFile, frame: NodeFrame): boolean {
		const loader = this.modules;

		if (loader === undefined) {
			return false;
		}

		this.values.length = frame.valuesBase; // (what the modules it waited on left)

		for (const specifier of linkedSpecifiers(source)) {
			let resolved: ReturnType<typeof loader.resolve>;

			try {
				resolved = loader.resolve(specifier, directoryOf(source.fileName));
			} catch {
				continue; // not found: its import binding says so
			}

			if (resolved.kind === "program" && loader.cached(resolved.filename) === undefined) {
				this.pushModule(resolved.filename);

				return true;
			}
		}

		return false;
	}

	/** A file about to run, once the program files it imports have: what of the packages it imports is still evaluating
	 *  (a module with top-level await), for it to wait on before its body runs, as an ES module waits on its imports. */
	public importsPending(source: ts.SourceFile): Promise<unknown> | undefined {
		const loader = this.modules;

		if (loader?.imported === undefined) {
			return undefined;
		}

		const waits: Promise<void>[] = [];

		for (const specifier of linkedSpecifiers(source)) {
			let resolved: ReturnType<typeof loader.resolve>;

			try {
				resolved = loader.resolve(specifier, directoryOf(source.fileName));
			} catch {
				continue; // not found: its import binding says so
			}

			if (resolved.kind === "package") {
				const pending = loader.imported(specifier, directoryOf(source.fileName));

				if (pending !== undefined) {
					waits.push(pending);
				}
			}
		}

		return waits.length === 0 ? undefined : Promise.all(waits);
	}

	/** A file's exports, once its bindings are declared: an ES module's, on its module's `exports` (modules.ts). */
	public linkExports(source: ts.SourceFile, scope: Scope): void {
		const module = this.modules === undefined ? undefined : moduleOf(scope);

		if (module !== undefined) {
			defineExports(source, module, (name) => {
				try {
					return scope.get(name);
				} catch {
					return undefined; // not initialized yet (a cycle reading it early)
				}
			}, (specifier) => this.requireFrom(source.fileName, specifier));
		}
	}

	/** Run until the next breakpoint (or completion). Advances at least one step. */
	public runToBreakpoint(): void {
		this.step();
		this.idle = false;

		// (runUntil with atBreakpoint, written out — this loop is the whole of a run to its end — and the test made by
		// `advance` on the frame it reads anyway)
		while (!this.finished && !this.paused && !this.idle && !this.advance(true)) {
			// (advance stepped)
		}
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
			ns.sharedGlobals = scope.sharedGlobals; // (what isn't interpreted isn't forked: shared)
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
				// (an import's namespace is the exporting module's, shared: it's that module's state, not this scope's)
				ns.bindings.set(name, { "value": clone(binding.value), "kind": binding.kind, "initialized": binding.initialized, ...binding.from === undefined ? {} : { "from": binding.from } });
			}

			return ns;
		};

		// (this machine's functions are rebound to the fork; another's stay its own)
		const owns = (value: unknown): value is GuestFunction => ownedBy(value, this);

		function clone(value: unknown): unknown {
			if (value === null || (typeof value !== "object" && typeof value !== "function")) {
				return value;
			}

			if (seen.has(value)) {
				return seen.get(value);
			}

			if (typeof value === "function") {
				if (owns(value)) {
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
				// (a loop's trace context is a cache of what's below it: the fork's frames find their own)
				if (key !== "node" && key !== "phase" && key !== "scope" && key !== "valuesBase" && key !== "traceContext") {
					nf[key] = clone((frame as unknown as Record<string, unknown>)[key]);
				}
			}

			return nf as unknown as Frame;
		};

		(forked as { "rootScope": Scope }).rootScope = clone(this.rootScope) as Scope;
		(forked as { "breakpoints": Set<string> }).breakpoints = new Set(this.breakpoints);
		forked.modules = this.modules;
		(forked as unknown as { "parsed": Map<string, ts.SourceFile> }).parsed = this.parsed; // the files as parsed: shared
		// Its own: the fork's guest values are clones, so the source's throw sites (keyed by its values) aren't its.
		(forked as unknown as { "throwSites": WeakMap<object, ts.Node> }).throwSites = new WeakMap();
		forked.sourceFile = this.sourceFile;
		forked.resolveModule = this.resolveModule;
		forked.hostGuard = this.hostGuard;
		forked.onAsyncFiber = this.onAsyncFiber;
		forked.onBreakpoint = this.onBreakpoint;
		forked.statements = this.statements;
		forked.coverage = this.coverage === undefined ? undefined : new Map([...this.coverage].map(([file, entry]) => [file, { "statements": entry.statements, "counts": [...entry.counts] }]));
		forked.covering = undefined; // (its counts are copies: found afresh)
		forked.profile = this.profile === undefined ? undefined : new Map([...this.profile].map(([statement, entry]) => [statement, { ...entry }]));
		forked.tallies = undefined; // (its entries are copies: found afresh)
		forked.waitedPending = this.waitedPending;
		(forked as unknown as { "topOf": WeakMap<ts.Node, ts.Statement | null> }).topOf = this.topOf; // a pure cache: shared
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
		forked.asyncContext = this.asyncContext;
		forked.family = this.family;
		forked.idle = this.idle;
		forked.depth = 0;
		forked.contexts = [];
		forked.awaitedBy = this.awaitedBy;
		// Its own pending fibers (their frames and closures, cloned), and the shared record of what settled.
		forked.pending = new Map([...this.pending].map(([id, each]): [number, Pending] => [id, each.kind === "fiber" ? { "kind": "fiber", "frames": each.frames.map(cloneFrame), "values": each.values.map(clone), "base": each.base, "context": each.context }
			: each.kind === "callback" ? { "kind": "callback", "fn": clone(each.fn) as GuestFunction, "context": each.context }
				: each.kind === "reaction" ? { "kind": "reaction", "onFulfilled": clone(each.onFulfilled), "onRejected": clone(each.onRejected), "onFinally": clone(each.onFinally), "species": each.species, "context": each.context }
					: { "kind": "host", "context": each.context }]));
		forked.scheduler = this.scheduler;
		forked.settledFrom = this.settledFrom;
		forked.loop = this.loop === undefined ? undefined : forkLoop(this.loop, clone);

		return forked;
	}

	// --- stepped async (VMOptions.steppedAsync) --------------------------------

	/**
	 * An async function's promise resolved with what it returned. A thenable is adopted as the spec has it, its `then`
	 * called a job later — but, with VMOptions.asyncContext, in the async context of the `return`, as Node's is: the
	 * host's own job runs in whichever context its turn finds, which may be a package's left behind (just-bash's
	 * sandbox, whose `Promise.prototype.then` drops a callback its finished command registered — an interrupted
	 * command's promise, returned rather than awaited, then never reached its caller).
	 */
	public resolveAsync(resolve: (value: unknown) => void, reject: (reason: unknown) => void, value: unknown): void {
		const hooks = this.asyncContext;
		const then = hooks === undefined || !isThenable(value) ? undefined : (value as { "then": unknown }).then;

		// (a promise this machine made: its resolve adopts a thenable in a job of its own, in the context of now)
		if (hooks === undefined || typeof then !== "function" || isOwnResolve(resolve)) {
			resolve(value);

			return;
		}

		const context = hooks.capture();

		void Promise.resolve().then(() => {
			hooks.enter(context);

			try {
				Reflect.apply(then, value, [resolve, reject]);
			} catch (error) {
				reject(error);
			}
		});
	}

	/** Stepped async: an async function call on the main stack — its async frame (which settles its promise), then its
	 *  call. Returns nothing: the promise reaches the caller when the body first suspends, or completes. */
	public enterAsync(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): void {
		const { promise, resolve, reject } = this.scheduler.promises.capability(this);
		const frame: AsyncFrame = { "kind": "async", "node": null, "phase": 0, "scope": this.rootScope, "valuesBase": this.values.length, "promise": promise, "resolve": resolve, "reject": reject };

		this.frames.push(frame);
		this.pushCall(meta, args, thisArg);
		this.onAsyncFiber?.(promise);
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
		const written = isTaggedTemplateExpression(site) ? undefined : site.expression.getText();
		const name = written ?? (typeof callee === "function" && callee.name !== "" ? callee.name : "a host call");
		const [first] = args;

		return typeof first === "string" ? `${name}(${JSON.stringify(first.length > 60 ? first.slice(0, 57) + "…" : first)})` : `${name}(…)`;
	}

	/** Event loop: a host call's promised `value` as the program gets it — a promise of the machine's realm, settled when
	 *  the result, once it's in, is delivered as an event (fireEvent). */
	private awaitResult(value: object, label: string): Promise<unknown> {
		const loop = this.loop!;
		const { scheduler } = this;
		const { promise, resolve, reject } = scheduler.promises.capability(this);

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

		const before = loop.clock;
		const fired = takeTimer(loop)!;

		this.waitedPending += loop.clock - before; // the wait: the profile's, for whichever statement's code runs next

		this.idle = false;
		this.values.length = 0; // between tasks: nothing on it is anyone's
		this.asyncContext?.enter(fired.context);

		if (ownedBy(fired.fn, this)) {
			this.pushCall(fired.fn.__tsval, fired.args, undefined);
		} else {
			// (a native callback: what it sets is this machine's too)
			const callingBefore = hostCalling(this);

			try {
				(fired.fn as (...args: unknown[]) => unknown)(...fired.args);
			} finally {
				hostCalling(callingBefore);
			}
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

		const frames = this.frames.slice(bottom);

		this.pending.set(id, { "kind": "fiber", "frames": frames, "values": this.values.slice(base), "base": base, "context": this.asyncContext?.capture() });

		// (what waits on what it awaited: a stack made there goes on here, `at async …`)
		if ((typeof awaited === "object" && awaited !== null) || typeof awaited === "function") {
			this.awaitedBy.set(awaited, frames);
		}
		this.frames.length = bottom;
		this.values.length = base;
		this.paused = false;
		this.pauseKind = undefined;
		this.pauseValue = undefined;

		if (boundary !== undefined && boundary.delivered !== true) {
			boundary.delivered = true;
			this.values.push(boundary.promise);
		}

		// (what it awaits reacts with the fiber, a job of this machine's — a host's promise it doesn't know through the host)
		if (!scheduler.promises.await(this, awaited, id)) {
			Promise.resolve(awaited).then(
				(value) => { settle(scheduler, id, { "kind": "next", "value": value }); },
				(error: unknown) => { settle(scheduler, id, { "kind": "throw", "value": error }); }
			);
		}
	}

	/** Stepped async: put the first settled pending job back on the (empty) stack, to step on — true if there was one. */
	private resumeSettled(): boolean {
		const { settled } = this.scheduler;

		while (this.settledFrom < settled.length && !this.pending.has(settled[this.settledFrom]!.id)) {
			this.settledFrom += 1;
		}

		const entry = settled[this.settledFrom];

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
		this.asyncContext?.enter(job.context);

		if (job.kind === "host") {
			if (input.kind === "run") {
				this.runHostJob(input.run);
			}

			return;
		}

		if (job.kind === "reaction") {
			if (input.kind === "fulfilled" || input.kind === "rejected") {
				this.react(job, input.kind, input.value, input.derived);
			}

			return;
		}

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

		// (a splice-combine handler's depth, `base`, moves with it — else a `return await x` resumed under a caller's
		// pending operands, `f(await g())`, splices from past its own value and returns undefined)
		for (const frame of job.frames) {
			frame.valuesBase += delta;

			if (frame.kind === undefined && frame.base !== undefined) {
				frame.base += delta;
			}
		}

		this.frames.push(...job.frames);
		this.values.push(...job.values);

		if (input.kind === "next") {
			this.sentValue = input.value;
		} else if (input.kind === "throw") {
			this.signal = { "type": "throw", "value": input.value };
		}
	}

	/** A promise reaction's job: its handler for how the promise settled — a guest function's call on the main stack
	 *  (its return settling the promise `then` made), a host function's call, or the outcome passed on; a `finally`'s
	 *  callback called with nothing, the promise then settling as this one did. */
	private react(job: Extract<Pending, { "kind": "reaction" }>, kind: "fulfilled" | "rejected", value: unknown, derived: Settlers | undefined): void {
		const promises = this.scheduler.promises;
		const handler = job.onFinally ?? (kind === "fulfilled" ? job.onFulfilled : job.onRejected);
		const args = job.onFinally === undefined ? [value] : [];
		const settleWith = job.onFinally === undefined || derived === undefined ? derived?.resolve : (result: unknown): void => { derived.resolve(promises.afterFinally(this, result, { "kind": kind, "value": value }, job.species)); };

		if (typeof handler === "function" && ownedBy(handler, this)) {
			const frame: AsyncFrame = { "kind": "async", "node": null, "phase": 0, "scope": this.rootScope, "valuesBase": this.values.length, "promise": Promise.resolve(), "resolve": settleWith ?? (() => undefined), "reject": derived?.reject ?? (() => undefined), "delivered": true };

			this.frames.push(frame);
			this.pushCall(handler.__tsval, args, undefined);

			return;
		}

		this.runHostJob(() => {
			if (typeof handler !== "function") {
				if (kind === "fulfilled") {
					derived?.resolve(value);
				} else {
					derived?.reject(value);
				}

				return;
			}

			let result: unknown;

			try {
				result = Reflect.apply(handler, undefined, args);
			} catch (error) {
				if (isUncatchable(error)) {
					throw error;
				}

				derived?.reject(error);

				return;
			}

			settleWith?.(result);
		});
	}

	/** Host work as a job of this machine's: what native code it calls sets this machine's timers. */
	private runHostJob(run: () => void): void {
		const callingBefore = hostCalling(this);

		try {
			run();
		} finally {
			hostCalling(callingBefore);
		}
	}

	/** Stepped async: `then`, `catch` or `finally` (`method`) on a host's promise, its handlers one pending job — the host
	 *  `then`'s wrappers settle it, and what they return the handler's outcome (a promise the host's derived adopts). */
	private hostReaction(method: unknown, receiver: unknown, handlers: unknown[]): unknown {
		const { prototype } = this.realm.Promise;
		const [first, second] = handlers;
		const id = method === prototype.then ? this.reactionJob(first, second)
			: method === prototype.catch ? this.reactionJob(undefined, first)
				: this.reactionJob(undefined, undefined, typeof first === "function" ? first : undefined, this.realm.Promise);
		const { scheduler } = this;
		const wrap = (kind: "fulfilled" | "rejected") => (value: unknown): Promise<unknown> => new this.realm.Promise<unknown>((resolve, reject) => {
			settle(scheduler, id, { "kind": kind, "value": value, "derived": { "resolve": resolve, "reject": reject } });
		});

		return Reflect.apply(prototype.then, receiver, [wrap("fulfilled"), wrap("rejected")]);
	}

	/** Promise jobs (promises.ts): a pending job for `then`'s handlers, made now — in the async context of now. */
	public reactionJob(onFulfilled: unknown, onRejected: unknown, onFinally?: unknown, species?: unknown): number {
		this.scheduler.ids += 1;
		this.pending.set(this.scheduler.ids, { "kind": "reaction", "onFulfilled": onFulfilled, "onRejected": onRejected, ...onFinally === undefined ? {} : { "onFinally": onFinally, "species": species }, "context": this.asyncContext?.capture() });

		return this.scheduler.ids;
	}

	/** Promise jobs: a pending job of host work, made now. */
	public hostJob(): number {
		this.scheduler.ids += 1;
		this.pending.set(this.scheduler.ids, { "kind": "host", "context": this.asyncContext?.capture() });

		return this.scheduler.ids;
	}

	/** Promise jobs: job `id`'s turn, after the jobs before it. */
	public settleJob(id: number, input: JobInput): void {
		settle(this.scheduler, id, input);
	}

	/** `for await` over a sync iterable, a step (%AsyncFromSyncIteratorPrototype%.next): a promise of `{ value, done }`,
	 *  once `value` has settled — the jobs the spec takes, in this machine's queue. */
	public asyncFromSync(value: unknown, done: boolean): unknown {
		const promises = this.scheduler.promises;

		return promises.invokeThen(this, promises.resolved(this, value), (settled: unknown) => ({ "value": settled, "done": done }), undefined);
	}

	/** `super(executor)` of a class extending Promise (handlers/classes.ts): its promise this machine's, the subclass
	 *  its `new.target` — or undefined (the host's), without stepped async or an executor. */
	public promiseSuper(args: unknown[], newTarget: unknown): object | undefined {
		return this.steppedAsync && typeof args[0] === "function" ? this.scheduler.promises.construct(this, args[0] as (resolve: unknown, reject: unknown) => unknown, isUncatchable, newTarget) : undefined;
	}

	/** `queueMicrotask(fn)`: a job of this machine's queue (a throw from it rejects nothing anyone holds, as before). */
	public queueJob(fn: unknown): void {
		if (typeof fn === "function" && ownedBy(fn, this)) {
			this.scheduler.ids += 1;
			this.pending.set(this.scheduler.ids, { "kind": "callback", "fn": fn, "context": this.asyncContext?.capture() });
			settle(this.scheduler, this.scheduler.ids, { "kind": "call", "args": [], "resolve": () => undefined, "reject": (reason) => { void this.realm.Promise.reject(reason); } });

			return;
		}

		settle(this.scheduler, this.hostJob(), { "kind": "run", "run": () => { (fn as () => unknown)(); } });
	}

	/** A promise method or static the program calls on a promise this machine made (promises.ts), as the spec's — else
	 *  NOT_OWN (the host's, as before). */
	private ownPromiseCall(callee: unknown, thisArg: unknown, args: unknown[], isConstruct: boolean): unknown {
		const promises = this.scheduler.promises;
		const { Promise: PromiseOf } = this.realm;

		if (isConstruct) {
			return callee === PromiseOf && typeof args[0] === "function" ? promises.construct(this, args[0] as (resolve: unknown, reject: unknown) => unknown, isUncatchable) : NOT_OWN;
		}

		const { prototype } = PromiseOf;
		const { "call": call, "apply": apply } = this.realm.Function.prototype;
		const [method, receiver, handlers] = callee === call ? [thisArg, args[0], args.slice(1)]
			: callee === apply ? [thisArg, args[0], Array.isArray(args[1]) ? args[1] as unknown[] : undefined]
				: callee === Reflect.apply ? [args[0], args[1], Array.isArray(args[2]) ? args[2] as unknown[] : undefined]
					: [callee, thisArg, args];

		if (handlers !== undefined && promises.knows(receiver)) {
			return method === prototype.then ? promises.then(this, receiver, handlers[0], handlers[1])
				: method === prototype.catch ? promises.invokeThen(this, receiver, undefined, handlers[0])
					: method === prototype.finally ? promises.finally(this, receiver, handlers[0])
						: NOT_OWN;
		}

		// (a static of %Promise%'s, or a subclass's: C, its promises made by constructing it)
		if (thisArg !== PromiseOf && !(typeof thisArg === "function" && Object.prototype.isPrototypeOf.call(PromiseOf, thisArg))) {
			return NOT_OWN;
		}

		switch (callee) {
			case PromiseOf.resolve: return promises.resolved(this, args[0], thisArg);
			case PromiseOf.reject: return promises.rejected(this, args[0], thisArg);
			case PromiseOf.all: return promises.combine(this, "all", args[0], thisArg);
			case PromiseOf.allSettled: return promises.combine(this, "allSettled", args[0], thisArg);
			case PromiseOf.race: return promises.combine(this, "race", args[0], thisArg);
			case PromiseOf.any: return promises.combine(this, "any", args[0], thisArg);
			case (PromiseOf as unknown as { "withResolvers"?: unknown }).withResolvers: {
				const { promise, resolve, reject } = promises.capabilityOf(this, thisArg);

				return { "promise": promise, "resolve": resolve, "reject": reject };
			}
			default: return NOT_OWN;
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

		// (runSub without its seed closure: this is the crossing a host built-in makes once per element)
		const ctx = this.enterSub();

		pushHostCall(this, meta, args, thisArg, newTarget);

		return this.drainSub(ctx);
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

	/** Stepped async: an async function called off the main stack — its body run to its first `await` now, then resumed
	 *  by this machine's jobs as what it awaits settles; its promise settled by how the body ends. */
	private ownAsyncCall(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Promise<unknown> {
		const promises = this.scheduler.promises;
		const { promise, resolve, reject } = promises.capability(this);
		let fiber: Fiber;

		try {
			fiber = this.seedFiber(meta, thisArg, args);
		} catch (error) {
			if (isUncatchable(error)) {
				throw error;
			}

			reject(error);

			return promise;
		}

		const run = (input: FiberInput): void => {
			let result: ReturnType<Machine["stepFiber"]>;

			try {
				result = this.stepFiber(fiber, input);
			} catch (error) {
				fiber.done = true;

				if (isUncatchable(error)) {
					throw error;
				}

				reject(error);

				return;
			}

			if (!result.paused) {
				fiber.done = true;
				resolve(result.value);
			} else if (result.kind !== "await") {
				fiber.done = true;
				reject(new TsvalInternalError("yield inside an async (non-generator) function"));
			} else {
				promises.awaitWith(this, result.value, (value) => { run({ "kind": "next", "value": value }); }, (reason) => { run({ "kind": "throw", "value": reason }); });
			}
		};

		run({ "kind": "next", "value": undefined });

		return promise;
	}

	/**
	 * Stepped async: an async generator's methods, as the spec's AsyncGenerator (AsyncGeneratorEnqueue, …Resume,
	 * …Yield, …AwaitReturn, …DrainQueue): each request a promise of this machine's, queued; the body stepped to its next
	 * suspension when it's suspended; an `await` and a plain `yield`'s operand awaited through this machine's jobs.
	 */
	private ownAsyncGenerator(fiber: Fiber): { "next": (value?: unknown) => Promise<unknown>; "return": (value?: unknown) => Promise<unknown>; "throw": (error?: unknown) => Promise<unknown> } {
		const promises = this.scheduler.promises;
		const queue: { "input": FiberInput; "capability": Capability }[] = [];
		let state: "start" | "yield" | "executing" | "returning" | "done" = "start";
		const awaiting = (value: unknown, onFulfilled: (settledValue: unknown) => void, onRejected: (reason: unknown) => void): void => {
			promises.awaitWith(this, value, onFulfilled, onRejected);
		};
		const completeStep = (kind: "normal" | "throw", value: unknown, done: boolean): void => {
			const request = queue.shift()!;

			if (kind === "throw") {
				request.capability.reject(value);
			} else {
				request.capability.resolve({ "value": value, "done": done });
			}
		};
		const finish = (kind: "normal" | "throw", value: unknown): void => {
			fiber.done = true;
			state = "done";
			completeStep(kind, value, true);
			drain();
		};
		const awaitReturn = (value: unknown): void => {
			state = "returning";

			try {
				awaiting(value, (returned) => { finish("normal", returned); }, (reason) => { finish("throw", reason); });
			} catch (error) {
				finish("throw", error);
			}
		};
		const drain = (): void => {
			while (queue.length > 0) {
				const { input } = queue[0]!;

				if (input.kind === "return") {
					awaitReturn(input.value);

					return;
				}

				completeStep(input.kind === "throw" ? "throw" : "normal", input.kind === "throw" ? input.value : undefined, true);
			}
		};
		const run = (input: FiberInput): void => {
			state = "executing";

			let step: ReturnType<Machine["stepFiber"]>;

			try {
				step = this.stepFiber(fiber, input);
			} catch (error) {
				if (isUncatchable(error)) {
					throw error;
				}

				finish("throw", error);

				return;
			}

			if (!step.paused) {
				finish("normal", step.value);
			} else if (step.kind === "await") {
				awaiting(step.value, (value) => { run({ "kind": "next", "value": value }); }, (reason) => { run({ "kind": "throw", "value": reason }); });
			} else if (step.raw === true) {
				yielded(step.value);
			} else {
				// (`yield v` awaits v; a rejection is a throw at the yield, which the body may catch)
				awaiting(step.value, yielded, (reason) => { run({ "kind": "throw", "value": reason }); });
			}
		};
		// AsyncGeneratorYield: the request answered; the next one, if any, goes on at once (its `return` awaited first)
		const yielded = (value: unknown): void => {
			completeStep("normal", value, false);

			const next = queue[0];

			if (next === undefined) {
				state = "yield";
			} else {
				resumeWith(next.input);
			}
		};
		const resumeWith = (input: FiberInput): void => {
			if (input.kind !== "return") {
				run(input);

				return;
			}

			state = "executing";
			awaiting(input.value, (value) => { run({ "kind": "return", "value": value }); }, (reason) => { run({ "kind": "throw", "value": reason }); });
		};
		const enqueue = (input: FiberInput): Promise<unknown> => {
			const capability = promises.capability(this);

			this.onAsyncFiber?.(capability.promise as Promise<IteratorResult<unknown>>);

			if (state === "start" && input.kind === "throw") {
				fiber.done = true;
				state = "done";
			}

			if (state === "done" && input.kind !== "return") {
				if (input.kind === "throw") {
					capability.reject(input.value);
				} else {
					capability.resolve({ "value": undefined, "done": true });
				}

				return capability.promise;
			}

			queue.push({ "input": input, "capability": capability });

			if (state === "start" && input.kind === "return") {
				fiber.done = true;
				awaitReturn(input.value);
			} else if (state === "done") {
				awaitReturn(input.value);
			} else if (state === "start") {
				run(input);
			} else if (state === "yield") {
				resumeWith(input);
			}

			return capability.promise;
		};

		return {
			"next": (value?: unknown) => enqueue({ "kind": "next", "value": value }),
			"return": (value?: unknown) => enqueue({ "kind": "return", "value": value }),
			"throw": (error?: unknown) => enqueue({ "kind": "throw", "value": error })
		};
	}

	/** Invoke a guest async function: returns a real Promise, driven by `await` suspensions. */
	public callAsync(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): Promise<unknown> {
		// Stepped async: called where a host frame is between it and the main loop — its body a fiber stepped to each
		// `await`, resumed by this machine's jobs (promises.ts), its promise this machine's.
		if (this.steppedAsync) {
			return this.ownAsyncCall(meta, thisArg, args);
		}

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
					this.resolveAsync(resolve, reject, result.value);

					return;
				}

				if (result.kind !== "await") {
					activeFiber.done = true;
					reject(new TsvalInternalError("yield inside an async (non-generator) function"));

					return;
				}

				// Suspended on `await result.value`; resume when it settles (in the async context it suspended in).
				const context = this.asyncContext?.capture();

				Promise.resolve(result.value).then(
					(value) => { this.asyncContext?.enter(context); drive({ "kind": "next", "value": value }); },
					(error: unknown) => {
						// An uncatchable error (interpreter bug, a host's abort) that rejected an awaited promise
						// must not be injected as a guest `throw` — guest try/catch could swallow it.
						if (isUncatchable(error)) {
							activeFiber.done = true;
							reject(error);
						} else {
							this.asyncContext?.enter(context);
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

		// Stepped async: its requests, awaits and yields are this machine's promise jobs (promises.ts).
		if (this.steppedAsync) {
			const gen = generatorObject(this.generatorPrototype(meta, true), this.ownAsyncGenerator(fiber)) as AsyncIterator<unknown> & AsyncIterable<unknown>;

			Object.defineProperty(gen, FIBER_BRAND, { "value": true });

			return gen;
		}

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
				const context = this.asyncContext?.capture();

				return Promise.resolve(result.value).then(
					(value) => { this.asyncContext?.enter(context); return drive({ "kind": "next", "value": value }); },
					(error: unknown) => {
						if (isUncatchable(error)) {
							fiber.done = true;

							return Promise.reject(error);
						}

						this.asyncContext?.enter(context);

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

		this.called?.(meta.node);
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

	/** The program's `Error` (its realm's): whose `prepareStackTrace` and `stackTraceLimit` it sets. */
	private get programError(): ErrorConstructor {
		return (this.guestErrors["Error"] ?? Error) as ErrorConstructor;
	}

	/** Whether a host call made an error: a construction that did, or an error constructor called (`Error("…")`). (No
	 *  trap of a Proxy it's given or makes is asked: test262 counts them.) */
	private makesError(callee: unknown, isConstruct: boolean, result: unknown): boolean {
		return isError(result) && (isConstruct || NATIVE_ERRORS.has(callee) || Object.values(this.guestErrors).includes(callee as never));
	}

	/** Whether `callee` is `Error.captureStackTrace`, the program's or the host's. */
	private capturesStack(callee: unknown): boolean {
		return callee === this.programError.captureStackTrace || callee === Error.captureStackTrace;
	}

	/**
	 * Give `error` the program's stack from here (stacks.ts): the frames above and including `below`'s, when it's given
	 * (`Error.captureStackTrace`'s second argument), left out. Once, unless `again` (a capture replaces it). `at`: the
	 * node it's made at, when it's known closer than the top frame's (a host call's own).
	 */
	public giveProgramStack(error: unknown, below?: unknown, again = false, at?: ts.Node): void {
		if ((typeof error !== "object" || error === null) && typeof error !== "function") {
			return;
		}

		if (!again && (hasProgramStack(error) || !isError(error))) {
			return;
		}

		const { programError } = this;
		const limit = programError.stackTraceLimit;

		giveStack(error, this.sitesHere(typeof limit === "number" ? Math.max(0, limit) : 0, below, at), programError);
	}

	/**
	 * The program's stack from here, innermost first, as V8 keeps one: each function's call at where it is in it (a
	 * module's top level, a constructor's `new`), through the calls a host made into the program (their stacks saved as
	 * they began), and then — stepped async — each async function waiting on the one before, at its `await`, as V8
	 * follows them (`at async …`). At most `limit`; with `below`, the frames down to and including its call left out;
	 * `here`, where the innermost is, when it's known closer than its frame (a host call's site).
	 */
	public sitesHere(limit: number, below?: unknown, here?: ts.Node): Site[] {
		const sites: Site[] = [];
		let skipping = below !== undefined;
		const add = (site: Site): void => {
			if (skipping) {
				skipping = site.fn !== below;

				return;
			}

			if (sites.length < limit) {
				sites.push(site);
			}
		};
		const receiverless = (thisArg: unknown): boolean => thisArg === undefined || thisArg === null || thisArg === globalThis;
		// One stack's sites, its top first; `isAsync`: an async function's, waiting.
		const walk = (stack: readonly Frame[], isAsync: boolean, from?: ts.Node): void => {
			let at = from;

			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const frame = stack[index]!;

				if (frame.kind === undefined) {
					at ??= frame.node;
				} else if (frame.kind === "call") {
					add({ "node": at, "fn": frame.meta.self, "name": frame.meta.name, "thisArg": frame.thisArg, "isToplevel": receiverless(frame.thisArg), "isConstructor": frame.newTarget !== undefined, "isAsync": isAsync });
					at = undefined;
				} else if (frame.kind === "construct") {
					add({ "node": at, "fn": frame.ctor, "name": (frame.ctor as { "name"?: string }).name, "thisArg": frame.instance, "isToplevel": false, "isConstructor": true, "isAsync": isAsync });
					at = undefined;
				} else if (frame.kind === "module") {
					add({ "node": at, "name": undefined, "isToplevel": true, "isAsync": isAsync });
					at = undefined;
				}
			}

			// (the entry's own top level, its frames the program's file's)
			if (at !== undefined) {
				add({ "node": at, "name": undefined, "isToplevel": true, "isAsync": isAsync });
			}
		};
		// (a nested run — a callback a host calls — has a stack of its own; the ones around it were saved as it began,
		// innermost last)
		let outermost: readonly Frame[] = this.frames;

		walk(this.frames, false, here);

		for (let depth = this.depth - 1; depth >= 0; depth -= 1) {
			const saved = this.contexts[depth];

			if (saved !== undefined) {
				walk(saved.frames, false);
				outermost = saved.frames;
			}
		}

		// What waits on the async function at the bottom, and on that one, and so on.
		const followed = new Set<readonly Frame[]>();

		for (let bottom = outermost[0]; bottom?.kind === "async";) {
			const waiting = this.awaitedBy.get(bottom.promise);

			if (waiting === undefined || followed.has(waiting)) {
				break;
			}

			followed.add(waiting);
			walk(waiting, true);
			bottom = waiting[0];
		}

		return sites;
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

		if (frame.kind === "pattern" && frame.iters !== undefined) {
			this.closeIterations(frame.iters.splice(0).reverse(), signal); // innermost first
		}

		// A module whose evaluation threw leaves the cache (as Node's does): a later require tries it again.
		if (frame.kind === "module" && signal.type === "throw") {
			this.modules?.forget?.(frame.module.filename);
		}

		if (frame.kind === undefined) {
			// (a `for await` whose iterator's `return()` was awaited: a rejection doesn't replace a throw that left it)
			if (frame.closing !== undefined) {
				const leaving = frame.closing;

				frame.closing = undefined;

				if (leaving.type === "throw") {
					signal = leaving;
					this.signal = leaving;
				}
			}

			// Stepped async: a `for await` left — not continued — awaits its iterator's `return()` first.
			if (frame.isLoop === true && !(signal.type === "continue" && (signal.label === null || signal.label === undefined || signal.label === frame.label)) && this.closeForAwait(frame, signal)) {
				return;
			}

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

			if (frame.node.kind === TRY_STATEMENT) {
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
	 * Stepped async: AsyncIteratorClose for a `for await` a signal leaves — its iterator's `return()` called (a sync
	 * iterable's through the spec's async-from-sync step) and its result awaited: the loop frame waits on it, and what
	 * left raises again when it settles (handlers/statements.ts, FOR_AWAIT_CLOSED). False where there's nothing to wait
	 * on, or `return()` threw (a throw that left wins; else its error does).
	 */
	private closeForAwait(frame: NodeFrame, signal: Signal): boolean {
		const it = frame.iteration;

		if (!this.steppedAsync || it === undefined || it.done || (frame.node as ts.ForOfStatement).awaitModifier === undefined) {
			return false;
		}

		it.done = true;

		const { iterator } = it.record;
		let result: unknown;

		try {
			const method = (iterator as { "return"?: unknown }).return;

			if (method === undefined || method === null) {
				if (frame.syncIterator !== true) {
					return false;
				}

				result = this.scheduler.promises.resolved(this, { "value": undefined, "done": true });
			} else {
				if (typeof method !== "function") {
					throw new TypeError("iterator.return is not a function");
				}

				result = Reflect.apply(method, iterator, []);

				if (frame.syncIterator === true) {
					if ((typeof result !== "object" || result === null) && typeof result !== "function") {
						throw new TypeError("Iterator result is not an object");
					}

					const { value, done } = result as { "value": unknown; "done": unknown };

					result = this.asyncFromSync(value, Boolean(done));
				}
			}
		} catch (error) {
			if (isUncatchable(error)) {
				throw error;
			}

			if (signal.type !== "throw") {
				this.signal = { "type": "throw", "value": this.toGuestError(error) };
				this.noteThrow(this.signal.value, this.currentNode);
			}

			return false;
		}

		frame.closing = signal;
		frame.phase = FOR_AWAIT_CLOSED;
		this.signal = null;
		this.values.length = frame.valuesBase;
		this.pauseValue = result;
		this.pauseKind = "await";
		this.pauseRaw = false;
		this.paused = true;

		return true;
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
					if (isIdentifier(varDecl.name)) {
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
		const { depth } = this;
		let ctx = this.contexts[depth];

		// (contexts nest, so the one saved at a depth is restored before that depth saves again: reuse it)
		if (ctx === undefined) {
			ctx = { "frames": this.frames, "values": this.values, "signal": this.signal, "finished": this.finished, "paused": this.paused, "pauseKind": this.pauseKind, "pauseValue": this.pauseValue, "pauseRaw": this.pauseRaw, "sentValue": this.sentValue, "subFrames": [], "subValues": [] };
			this.contexts[depth] = ctx;
		} else {
			ctx.frames = this.frames;
			ctx.values = this.values;
			ctx.signal = this.signal;
			ctx.finished = this.finished;
			ctx.paused = this.paused;
			ctx.pauseKind = this.pauseKind;
			ctx.pauseValue = this.pauseValue;
			ctx.pauseRaw = this.pauseRaw;
			ctx.sentValue = this.sentValue;
		}

		this.depth = depth + 1;

		return ctx;
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
		// (kept for reuse: let go of the values it held)
		ctx.signal = null;
		ctx.pauseValue = undefined;
		ctx.sentValue = undefined;
	}

	/** Run a fresh private context seeded by `seed`, to completion, and return the top value. */
	private runSub(seed: () => void): unknown {
		const ctx = this.enterSub();

		seed();

		return this.drainSub(ctx);
	}

	/** Enter a fresh private context, on its depth's stacks (empty: drainSub leaves them so). */
	private enterSub(): ExecContext {
		const ctx = this.saveContext();

		this.frames = ctx.subFrames;
		this.values = ctx.subValues;
		this.signal = null;
		this.finished = false;
		this.paused = false;

		return ctx;
	}

	/** Run the context enterSub entered to completion, return the top value, and leave it. */
	private drainSub(ctx: ExecContext): unknown {
		const { subFrames, subValues } = ctx;

		try {
			while (!this.finished) {
				// Regain debugger control inside a host-invoked guest call: a fresh statement on a breakpoint
				// fires the hook (which may block and inspect state) before it executes. Only meaningful for
				// statement-bearing sub-runs (a function body); expression sub-runs never hit atBreakpoint.
				// (`advance` makes atBreakpoint's test, and steps when it doesn't hold)
				if (this.onBreakpoint === undefined) {
					this.step();
				} else if (this.advance(true)) {
					this.onBreakpoint(this);
					this.step();
				}

				// A synchronous sub-run has no driver to resume it: a `yield`/`await` here (a computed key,
				// default value, or destructuring default containing one) cannot be honored. Fail loud
				// rather than silently resuming with `undefined`.
				if (this.paused) {
					throw new TsvalInternalError("yield/await inside a synchronously evaluated sub-expression (default value / computed key) is not supported");
				}

				// Done: no frame left, nothing propagating (what a step on the empty stack would only say)
				if (subFrames.length === 0 && this.signal === null) {
					break;
				}
			}

			return subValues.pop();
		} finally {
			// (left mid-run by a throw: empty them for the next sub-run here)
			if (subFrames.length !== 0) {
				subFrames.length = 0;
			}

			if (subValues.length !== 0) {
				subValues.length = 0;
			}

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
	return node.kind >= FIRST_STATEMENT && node.kind <= LAST_STATEMENT;
}

/** Each statement's breakpoint key (`file:pos`), as found: finding its file walks up the tree and its start scans past
 *  trivia, which a run that checks at every statement shouldn't redo. */
const breakpointKeys = new WeakMap<ts.Node, string>();

function breakpointKey(node: ts.Node): string {
	let key = breakpointKeys.get(node);

	if (key === undefined) {
		const file = node.getSourceFile();

		key = `${file.fileName}:${node.getStart(file)}`;
		breakpointKeys.set(node, key);
	}

	return key;
}

/** True for the `prototype` object of a guest class (its own `constructor` is a branded guest class). */
function isGuestClassPrototype(value: object): boolean {
	const ctor = Object.getOwnPropertyDescriptor(value, "constructor")?.value as { "prototype"?: unknown } | undefined;

	return isGuestClass(ctor) && ctor.prototype === value;
}

/** A full snapshot of the machine's mutable execution state, for nested sub-runs and fibers — and the stacks a sub-run
 *  entered from it runs on. */
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
	"subFrames": Frame[];
	"subValues": unknown[];
}

/** The host's error constructors, each called as a function (`Error("…")`) makes one. */
const NATIVE_ERRORS = new Set<unknown>(["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "SuppressedError"].map((name) => (globalThis as Record<string, unknown>)[name]).filter((each) => typeof each === "function"));

/** Whether `value` is an error (its [[ErrorData]]), asking no Proxy trap: `Error.isError`, where there is one. */
function isError(value: unknown): value is Error {
	const { isError: has } = Error as { "isError"?: (value: unknown) => boolean };

	if (has !== undefined) {
		return has(value);
	}

	return typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Error]";
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
/** (`context`: VMOptions.asyncContext's, as it was when the job was made) */
type Pending = { "kind": "fiber"; "frames": Frame[]; "values": unknown[]; "base": number; "context"?: unknown } | { "kind": "callback"; "fn": GuestFunction; "context"?: unknown }
	| { "kind": "reaction"; "onFulfilled": unknown; "onRejected": unknown; "onFinally"?: unknown; "species"?: unknown; "context"?: unknown } | { "kind": "host"; "context"?: unknown };

/** How a pending job is resumed: a fiber with what it awaited (or the rejection, thrown at the `await`), a callback with
 *  the host's call. */
type Settlement = JobInput | { "kind": "call"; "args": unknown[]; "resolve": (value: unknown) => void; "reject": (reason: unknown) => void };

/** Stepped async: what settled, in order, for which pending job; and who waits for the next. Shared by forks. */
interface AsyncScheduler { "settled": { "id": number; "input": Settlement }[]; "ids": number; "wakers": (() => void)[]; "promises": OwnPromises }

/** What a promise's own statics make (`Promise.resolve`, `Promise.all`, …) is the program's, not external. */
const PROMISE_STATICS = ["resolve", "reject", "all", "allSettled", "race", "any", "withResolvers"];

/** One of `Promise`'s statics, as they are now (a loop, not a closure: it's asked of every host call). */
function isPromiseStatic(promise: PromiseConstructor, callee: unknown): boolean {
	for (const name of PROMISE_STATICS) {
		if ((promise as unknown as Record<string, unknown>)[name] === callee) {
			return true;
		}
	}

	return false;
}

/** ownPromiseCall: not a promise call this machine makes its own. */
const NOT_OWN = Symbol("not own");

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

/** Where a top-level statement's share of the run went (VMOptions.profile): the statements run in its code (a
 *  declaration's step and a concise arrow body's entry one each), the virtual time waited before its code ran again,
 *  and the statement clock's reading when it first ran. */
export interface StatementProfile { "statements": number; "waited": number; "first": number }

/** A program file's coverage (VM.coverage): its statements in source order — every node of a statement kind, blocks and
 *  declarations among them — and how often each has run, by index. */
export interface FileCoverage { readonly "statements": readonly ts.Statement[]; readonly "counts": number[] }

/** A file's statements in source order, as coverage indexes them (statementPoint). */
interface StatementTable { "file": ts.SourceFile; "statements": ts.Statement[] }

/** Each statement's place in its file's table, found when the file is first indexed: the AST doesn't change, and a
 *  compiled unit would know it statically (README.md, *A compiled tier*). */
const statementPoints = new WeakMap<ts.Node, { "table": StatementTable; "index": number }>();

function statementPoint(node: ts.Node): { "table": StatementTable; "index": number } {
	let point = statementPoints.get(node);

	if (point === undefined) {
		const file = node.getSourceFile();
		const table: StatementTable = { "file": file, "statements": [] };
		const visit = (child: ts.Node): void => {
			if (isStatement(child)) {
				statementPoints.set(child, { "table": table, "index": table.statements.length });
				table.statements.push(child as ts.Statement);
			}

			child.forEachChild(visit);
		};

		file.forEachChild(visit);
		point = statementPoints.get(node)!;
	}

	return point;
}

/** How a fiber is resumed: with a value, or by injecting a return/throw at the suspension point. */
type FiberInput = { "kind": "next"; "value": unknown } | { "kind": "return"; "value": unknown } | { "kind": "throw"; "value": unknown };

/** The constructor hosts use; its instances are typed as the host-facing `VM`. */
const VMConstructor: new (options?: VMOptions) => VM = Machine;

export { VMConstructor as VM };
