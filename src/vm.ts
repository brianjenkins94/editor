import ts from "typescript";
import { Scope } from "./scope.ts";
import { syntaxKindName } from "./frontend.ts";
import type { GuestFunctionMeta } from "./values.ts";
import { nodeHandlers, syntheticHandlers } from "./handlers.ts";

/**
 * A control-stack frame — the reified recursion (ASSIGNMENT §3).
 *
 * `node` + `phase` say *what to evaluate next / what to do once children resolve*; `scope` is the
 * lexical environment the frame runs in. Synthetic frames (no direct 1:1 node, e.g. a function call)
 * carry a `kind` tag and dispatch through `syntheticHandlers`; all others dispatch by `node.kind`.
 *
 * Frames are plain data (no closures) so the whole machine state is cloneable for snapshot/fork (S4).
 */
export interface Frame {
	node: ts.Node | null;
	phase: number;
	scope: Scope;
	/** value-stack depth when this frame was pushed; used to unwind operands cleanly on throw. */
	valuesBase: number;
	/** synthetic-frame discriminator (e.g. "call"); absent for plain node frames. */
	kind?: string;
	// frame-local scratch (args, this-binding, captured metadata, ...). Kept plain for cloneability.
	[extra: string]: unknown;
}

export type Signal =
	| { type: "return"; value: unknown }
	| { type: "throw"; value: unknown }
	| { type: "break"; label?: string }
	| { type: "continue"; label?: string };

export type Handler = (vm: VM, frame: Frame) => void;

export interface VMOptions {
	/** Injected globals / capability shims (checked before real globals). */
	globals?: Record<string, unknown>;
	/** Fall back to the host's real `globalThis` for unresolved names. Default true (max differential
	 *  parity). The canary stage (S5) sets this false for a controlled environment. */
	realGlobals?: boolean;
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
	/** completion value: the value of the last evaluated ExpressionStatement (REPL/`eval` semantics). */
	completion: unknown = undefined;
	finished = false;
	/** monotonic count of `step()` calls — a free step budget (ASSIGNMENT §3). */
	steps = 0;

	constructor(options: VMOptions = {}) {
		this.rootScope = new Scope(undefined, true);
		this.rootScope.globalObject = { undefined, NaN, Infinity, ...(options.globals ?? {}) };
		this.rootScope.hasThis = true;
		this.rootScope.thisVal = undefined;
		this.rootScope.realGlobals = options.realGlobals ?? true;
	}

	/** Seat a parsed SourceFile as the initial frame. */
	load(sourceFile: ts.SourceFile): void {
		this.pushNode(sourceFile, this.rootScope);
	}

	// --- frame / value helpers ------------------------------------------------

	pushNode(node: ts.Node, scope: Scope): Frame {
		const frame: Frame = { node, phase: 0, scope, valuesBase: this.values.length };
		this.frames.push(frame);
		return frame;
	}

	pushFrame(frame: Frame): void {
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
			this.finished = true;
			return;
		}
		this.steps++;

		if (this.signal !== null) {
			this.unwind(frame, this.signal);
			return;
		}

		const handler = frame.kind !== undefined ? syntheticHandlers[frame.kind] : nodeHandlers[(frame.node as ts.Node).kind];
		if (handler === undefined) {
			const node = frame.node as ts.Node;
			throw new Error(`unimplemented: ${frame.kind ?? syntaxKindName(node.kind)}` + (frame.kind ? "" : ` (SyntaxKind ${node.kind})`));
		}
		handler(this, frame);
	}

	/**
	 * Unwind one frame for a propagating signal. `call` frames catch `return`; `try` frames (S2) catch
	 * `throw` and run finalizers. Everything else is discarded, its operands truncated away. If the
	 * signal escapes the program, a `throw` is rethrown to the host and a top-level `return` becomes
	 * the completion value.
	 */
	private unwind(frame: Frame, signal: Signal): void {
		// Let a synthetic/loop/try frame catch it first.
		if (frame.kind === "call" && signal.type === "return") {
			this.frames.pop();
			this.values.length = frame.valuesBase;
			this.values.push(signal.value);
			this.signal = null;
			return;
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

	/** Run to completion. */
	run(): unknown {
		while (!this.finished) this.step();
		return this.completion;
	}

	/** Step until the given predicate holds (or the machine finishes). */
	runUntil(predicate: (vm: VM) => boolean): void {
		while (!this.finished && !predicate(this)) this.step();
	}

	/** Step until control reaches the next statement boundary (or the machine finishes). */
	stepStatement(): void {
		const isStmtBoundary = (vm: VM): boolean => {
			const f = vm.top;
			return f !== undefined && f.kind === undefined && f.phase === 0 && f.node !== null && isStatement(f.node);
		};
		// Advance at least one step, then run until the *next* fresh statement frame.
		this.step();
		this.runUntil(isStmtBoundary);
	}

	/**
	 * Invoke a guest function from host code (array callbacks, shims). Runs a nested loop to
	 * completion on a private stack; host↔guest crossings use the host stack (documented tradeoff),
	 * while guest→guest calls stay on the explicit stack. (ASSIGNMENT §3, "Calls".)
	 */
	callGuestFromHost(meta: GuestFunctionMeta, thisArg: unknown, args: unknown[]): unknown {
		const saved = { frames: this.frames, values: this.values, signal: this.signal, finished: this.finished };
		this.frames = [];
		this.values = [];
		this.signal = null;
		this.finished = false;
		this.pushCall(meta, args, thisArg);
		try {
			while (!this.finished) this.step();
			return this.values.pop();
		} finally {
			this.frames = saved.frames;
			this.values = saved.values;
			this.signal = saved.signal;
			this.finished = saved.finished;
		}
	}

	/** Push a synthetic call frame for a guest function. */
	pushCall(meta: GuestFunctionMeta, args: unknown[], thisArg: unknown): Frame {
		const frame: Frame = {
			kind: "call",
			node: meta.node,
			phase: 0,
			scope: meta.closure, // real scope built in phase 0
			valuesBase: this.values.length,
			meta,
			args,
			thisArg,
		};
		this.frames.push(frame);
		return frame;
	}
}

function isStatement(node: ts.Node): boolean {
	return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement;
}
