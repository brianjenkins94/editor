/**
 * Frames — the VM's explicit continuation stack, as PLAIN DATA.
 *
 * Every frame is a plain object (no methods, no class instances) so that `VM.fork()` can clone the
 * whole stack field by field. The union below is the complete inventory of what a frame may hold:
 * a `NodeFrame` evaluates one AST node and keeps the scratch registers its handler needs between
 * phases; the synthetic frames (`call`, `construct`, `initfields`, `pattern`) carry their own
 * typed state. Adding a field means adding it here — a typo or a wrong type is a compile error, not
 * a silent `undefined` at runtime.
 */
import type ts from "typescript";
import type { Scope, BindingKind } from "./scope.ts";
import type { GuestFunctionMeta, GuestFunctionNode } from "./values.ts";
import type { ClassMeta, GuestClass, IterRecord, PatternProgram, Ref } from "./handlers.ts";
import type { Signal } from "./vm.ts";

interface FrameBase {
	/** where the handler is in its evaluation; meaning is per handler. */
	phase: number;
	scope: Scope;
	/** value-stack depth when this frame was pushed; operands above it are truncated on unwind. */
	valuesBase: number;
}

/** What a `yield*` frame received from the outer generator's caller (`next(v)` / `throw(e)` / `return(v)`). */
export interface Received {
	kind: "next" | "throw" | "return";
	value: unknown;
}

/** One open iterator of a stepped destructuring frame, with the record's [[Done]]. */
export interface PatternIterator {
	record: IterRecord;
	done: boolean;
}
/** One open source object of a stepped destructuring frame (the keys read so far feed object rest). */
export interface PatternSource {
	value: unknown;
	used: PropertyKey[];
}

/** A frame evaluating one AST node. Optional fields are the handler families' scratch registers. */
export interface NodeFrame extends FrameBase {
	kind?: undefined;
	node: ts.Node;
	/** a block whose scope was prepared by its pusher (function bodies): don't create another. */
	reuseScope?: boolean;
	/** value-stack depth captured at phase 0 by splice-combine handlers (literals, calls, classes). */
	base?: number;

	// --- loops / labels / switch (consulted by VM.unwind) ---
	isLoop?: boolean;
	/** the phase `continue` resumes at. */
	continuePhase?: number;
	isLabel?: boolean;
	label?: string;
	isSwitch?: boolean;
	/** `for`: the per-iteration scope, its `let`/`const` names and their kind; whether the head is an expression. */
	iterScope?: Scope;
	lexicalNames?: string[] | null;
	lexicalKind?: BindingKind;
	initIsExpr?: boolean;
	/** `for…of` / `for await` / `yield*`: the iterator record; the iterator itself for IteratorClose; [[Done]]. */
	iterRecord?: IterRecord;
	iterator?: object;
	iteratorDone?: boolean;
	syncIterator?: boolean;
	/** `for…in`: the enumerated keys and the cursor. */
	keys?: PropertyKey[];
	index?: number;
	/** `switch`: discriminant, cursors, the matched clause, the block scope. */
	disc?: unknown;
	caseIndex?: number;
	defaultIndex?: number;
	execIndex?: number;
	pendingCase?: number;
	switchScope?: Scope;

	// --- try/catch/finally (paired with VM.unwindTry) ---
	state?: "try" | "catch" | "finally";
	pendingSignal?: Signal | null;

	// --- references: member access, calls, assignment, `super` ---
	/** the resolved Reference Record (evaluateReference caches it here). */
	ref?: Ref;
	/** the receiver for a call through a member reference. */
	thisArg?: unknown;
	/** the current value of a read-modify-write (GetValue before the RHS). */
	current?: unknown;
	/** call arguments: how many operands and which were spreads. */
	argCount?: number;
	spreadMask?: boolean[];

	// --- yield* delegation ---
	received?: Received;
	delegating?: boolean;
	returning?: boolean;
	result?: unknown;

	// --- class definition (heritage + computed keys evaluated on the stack) ---
	classScope?: Scope;

	/** a sub-expression frame is on the stack and its value is expected on resume. */
	awaiting?: boolean;
}

/** A guest function invocation (guest→guest calls never use the host stack). */
export interface CallFrame extends FrameBase {
	kind: "call";
	node: GuestFunctionNode;
	meta: GuestFunctionMeta;
	args: unknown[];
	thisArg: unknown;
	newTarget?: unknown;
}

/** `new C(...)` / `super(...)` on a guest class: constructs `instance` (a parent may replace it). */
export interface ConstructFrame extends FrameBase {
	kind: "construct";
	node: null;
	ctor: GuestClass;
	args: unknown[];
	/** the object under construction (created at phase 0 when absent). */
	instance?: object;
	/** `new`: push the instance as the expression's value; `forSuper`: leave it for the initfields frame. */
	isNew: boolean;
	forSuper?: boolean;
	newTarget?: unknown;
	/** the explicit constructor's scope (its `this` may still be in the TDZ at completion). */
	ctorScope?: Scope;
	derived?: boolean;
	/** an explicit `return <object>` replaced the instance. */
	overridden?: boolean;
}

/** After `super()` returns: adopt the parent's instance, bind `this`, run this class's field initializers. */
export interface InitFieldsFrame extends FrameBase {
	kind: "initfields";
	node: null;
	meta: ClassMeta;
	instance: object;
	/** the constructor scope whose `this` leaves its TDZ. */
	thisScope?: Scope;
	/** the parent's construct frame left its final instance on the value stack. */
	fromStack?: boolean;
}

/** Stepped destructuring (see handlers.ts "Stepped destructuring"). */
export interface PatternFrame extends FrameBase {
	kind: "pattern";
	node: null;
	program: PatternProgram;
	pc: number;
	temps: unknown[];
	iters: PatternIterator[];
	objs: PatternSource[];
	keys: PropertyKey[];
	awaiting?: boolean;
}

export type SyntheticFrame = CallFrame | ConstructFrame | InitFieldsFrame | PatternFrame;
export type Frame = NodeFrame | SyntheticFrame;
export type SyntheticKind = SyntheticFrame["kind"];
