import ts from "typescript";
import { Scope } from "./scope.ts";
import { syntaxKindName } from "./frontend.ts";
import type { GuestFunctionMeta } from "./values.ts";
import { nodeHandlers, syntheticHandlers } from "./handlers.ts";
import { TsvalInternalError } from "./errors.ts";

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
			throw new TsvalInternalError(`unimplemented: ${frame.kind ?? syntaxKindName(node.kind)}` + (frame.kind ? "" : ` (SyntaxKind ${node.kind})`));
		}
		try {
			handler(this, frame);
		} catch (error) {
			// A guest-observable runtime error (host built-in threw, bad member access, `instanceof` on a
			// non-object, …) becomes a catchable `throw` signal. Interpreter bugs (unimplemented node,
			// invariant violation) stay loud and propagate to the host (ASSIGNMENT working style).
			if (error instanceof TsvalInternalError) throw error;
			this.signal = { type: "throw", value: error };
		}
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

		const node = frame.node;
		const kind = frame.kind === undefined && node !== null ? node.kind : -1;

		// Loop frames catch break/continue targeting them (unlabeled, or matching label).
		if (frame.isLoop === true && (signal.type === "break" || signal.type === "continue")) {
			if (signal.label == null || signal.label === frame.label) {
				this.values.length = frame.valuesBase;
				this.signal = null;
				if (signal.type === "break") this.frames.pop();
				else frame.phase = frame.continuePhase as number;
				return;
			}
		}

		// switch / labeled-block frames catch break targeting them.
		if ((frame.isSwitch === true || frame.isLabel === true) && signal.type === "break") {
			if (signal.label == null ? frame.isSwitch === true : signal.label === frame.label) {
				this.values.length = frame.valuesBase;
				this.signal = null;
				this.frames.pop();
				return;
			}
		}

		if (kind === ts.SyntaxKind.TryStatement) {
			this.unwindTry(frame, signal);
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

	/**
	 * Try/catch/finally unwinding. `frame.state` records where we were: in the `try` block, the
	 * `catch` block, or a `finally`. A `throw` in `try` with a catch clause routes to `catch`; any
	 * other escaping signal (or a throw with no catch) runs `finally` then re-raises. The phases here
	 * pair with `handleTry` in handlers.ts.
	 */
	private unwindTry(frame: Frame, signal: Signal): void {
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
				if (varDecl != null && varDecl.name.kind === ts.SyntaxKind.Identifier) {
					const name = (varDecl.name as ts.Identifier).text;
					catchScope.declareLexical(name, "let");
					catchScope.initialize(name, signal.value);
				}
				frame.state = "catch";
				frame.phase = 3;
				this.pushNode(clause.block, catchScope);
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

	/**
	 * Evaluate a single expression node to a value on a private stack, synchronously. Used for the
	 * "leaf" sub-expressions of binding forms — default parameter/element values and computed
	 * destructuring keys — where a full stepped integration would be disproportionate. Nested guest
	 * calls it makes still run on the explicit (sub-)stack; only the entry uses the host stack.
	 */
	evalNodeSync(node: ts.Node, scope: Scope): unknown {
		const saved = { frames: this.frames, values: this.values, signal: this.signal, finished: this.finished };
		this.frames = [];
		this.values = [];
		this.signal = null;
		this.finished = false;
		this.pushNode(node, scope);
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
