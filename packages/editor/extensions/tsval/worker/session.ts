/**
 * The stepping debugger's session: arming breakpoints, running to a stop, stepping forward and back (tsval's forks, one
 * per stop), the stop's snapshot and its variables, setting a value at a stop, and launching a run.
 */
import type { PlaceSet } from "@brianjenkins94/editor-api";
import type { ModuleLoader } from "@brianjenkins94/tsval";
import type { CapabilityAsk, Control, Crash, Snapshot, Variable, WorkerEvent } from "../debug-protocol";
import type { SiteSums } from "../site-sums";
import type { Runtime } from "./runtime";
import type { Action, ForwardAction, Place, TraceContext, Vm } from "./state";
import { asyncContext } from "@brianjenkins94/almostnode/async-context";
import { layered } from "@brianjenkins94/editor-api/runtime";
import { createVM, ProgramSyntaxError, TsvalInternalError } from "@brianjenkins94/tsval";
import ts from "typescript";
import { copySums } from "../site-sums";
import { calledSeen, observeSite } from "./busy";
import { armCapabilities, capabilityAt, capabilitySurface, functionsIn, tellEffects, watchedOf } from "./gate";
import { dropUnpinned, readPins } from "./install";
import { packagesRan, readBaseline } from "./package-calls";
import { EXITED, held, listening, readsStdin } from "./process";
import { editorPlaywright, programModules, runtimeReady, whereOf } from "./runtime";
import { post, state, workerLog } from "./state";
import { askAt } from "./stops";
import { startTests, tellCoverage, tellTests, testsOver, testTold } from "./tests";
import { endValues, flushValues, keepTold, resumeTold, startValues, tellSet, traceValue } from "./values";

/** Start recording `vm`'s observations into `sums`: the timeline running now. */
function record(vm: Vm, sums: SiteSums): void {
	state.sumsOf.set(vm, sums);
	state.recording = sums;
}

function nextAction(): Promise<Action> {
	return new Promise((resolve) => {
		state.awaitAction = resolve;
	});
}

/** `text` as the value it writes, when it's a literal — a string, a number, a boolean, null or undefined, or an array or
 *  object of those — so setting a value can't run code. */
function literalOf(text: string): { "value": unknown } | { "error": string } {
	const file = ts.createSourceFile("value.ts", `(${text})`, ts.ScriptTarget.Latest, true);
	const [statement] = file.statements;
	const read = (node: ts.Node): unknown => {
		if (ts.isParenthesizedExpression(node)) {
			return read(node.expression);
		}

		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return node.text;
		}

		if (ts.isNumericLiteral(node)) {
			return Number(node.text);
		}

		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
			return -Number(node.operand.text);
		}

		if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
			return node.kind === ts.SyntaxKind.TrueKeyword;
		}

		if (node.kind === ts.SyntaxKind.NullKeyword) {
			return null;
		}

		if (ts.isIdentifier(node) && ["undefined", "NaN", "Infinity"].includes(node.text)) {
			return { "undefined": undefined, "NaN": Number.NaN, "Infinity": Number.POSITIVE_INFINITY }[node.text];
		}

		if (ts.isArrayLiteralExpression(node)) {
			return node.elements.map(read);
		}

		if (ts.isObjectLiteralExpression(node)) {
			return Object.fromEntries(node.properties.map((property) => {
				if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) {
					throw new Error("only plain properties");
				}

				return [
					property.name.text,
					read(property.initializer)
				];
			}));
		}

		throw new Error(`not a literal: ${node.getText(file)}`);
	};

	try {
		if (file.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement) || file.parseDiagnostics.length > 0) {
			throw new Error("not a value");
		}

		return {
			"value": read(statement.expression)
		};
	} catch (error) {
		return { "error": `${text} — ${error instanceof Error
			? error.message
			: String(error)} (a literal: 'text', 4, true, null, [1, 2], { a: 1 })` };
	}
}

/** At the stop `vm` is at: `name`, a variable in scope there, set to `text`'s literal — and recorded with the run's values,
 *  on the stop's line, as set by hand. */
export function setValue(vm: Vm, name: string, text: string): Extract<WorkerEvent, { "type": "valueSet" }> {
	const literal = literalOf(text);

	if ("error" in literal) {
		return { "type": "valueSet", "ok": false, "error": literal.error };
	}

	for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
		const binding = scope.bindings.get(name);

		if (binding !== undefined) {
			// A rule mocks it, const or not; Set Value at a stop does as code can.
			if (binding.kind === "const") {
				return { "type": "valueSet", "ok": false, "error": `${name} is a const` };
			}

			if (!binding.initialized) {
				return { "type": "valueSet", "ok": false, "error": `${name} isn't declared yet here` };
			}

			binding.value = vm.fromHost(literal.value);
			tellSet(vm, name, binding.value);

			return {
				"type": "valueSet",
				"ok": true,
				"value": format(binding.value),
				"snapshot": snapshot(vm)
			};
		}
	}

	return { "type": "valueSet", "ok": false, "error": `no ${name} in scope here` };
}

/** What rules set once the statement at `place` has run. */
const setsAt = (place: Place): PlaceSet[] | undefined => state.placeSets.get(place.file)?.get(place.line);

/** A rule's sets, made: a rule mocks a variable, const or not, once it's declared. Shown on the line it's placed on. */
function makeSets(vm: Vm, sets: PlaceSet[], line: number): void {
	for (const { name, value } of sets) {
		for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
			const binding = scope.bindings.get(name);

			if (binding !== undefined) {
				if (binding.initialized) {
					binding.value = vm.fromHost(value);
					tellSet(vm, name, binding.value, line - 1);
				}

				break;
			}
		}
	}
}

/** Whether the user has a breakpoint at `place`. */
function userStopAt(place: Place): boolean {
	return (place.file === state.sourceFile?.fileName
		? state.userLines
		: state.fileLines.get(place.file) ?? []).includes(place.line);
}

/** Every line to arm in `file`: the user's breakpoints, the capability calls the policy gates, and where a rule sets a value
 *  (a breakpoint that isn't a stop: runOn). */
function linesIn(file: string): number[] {
	return [
		...file === state.sourceFile?.fileName
			? state.userLines
			: state.fileLines.get(file) ?? [],
		...state.capabilityLines.get(file) ?? [],
		...state.placeSets.get(file)?.keys() ?? []
	];
}

/** Arm `vm`'s breakpoints: in each of the program's files, the user's and the capability calls the policy gates. */
export function arm(vm: Vm): void {
	vm.breakpoints.clear();

	for (const file of new Set([
		state.sourceFile?.fileName ?? "",
		...state.fileLines.keys(),
		...state.capabilityLines.keys(),
		...state.placeSets.keys()
	])) {
		try {
			vm.addBreakpointsInFile(file, ...linesIn(file));
		} catch {
			// (a file that isn't there, or doesn't parse: nothing of it runs)
		}
	}
}

/** Another of the program's files is loading (the loader's register, or a package requiring it): its capability calls
 *  the policy gates are armed, on the machine running and each stop's, before any of it runs. */
export function noteProgramFile(filename: string, source: () => string): void {
	if (state.programFiles.has(filename)) {
		return;
	}

	let file: ts.SourceFile;

	try {
		file = ts.createSourceFile(filename, source(), ts.ScriptTarget.Latest, true, /\.[jt]sx$/u.test(filename)
			? ts.ScriptKind.TSX
			: ts.ScriptKind.TS);
	} catch {
		return;
	}

	state.programFiles.set(filename, file);
	armCapabilities(file);

	for (const vm of new Set([state.current, ...state.history])) {
		vm?.addBreakpointsInFile(filename, ...linesIn(filename));
	}
}

/** Whether a run reaching `place` stops there: a breakpoint of the user's, or a capability call the policy gates. */
function stopsAt(vm: Vm, place: Place): boolean {
	return userStopAt(place) || (capabilityAt(place) && askAt(vm, place) !== undefined);
}

/** Continue: run to the next stop — past the capability lines the policy now lets pass. */
function runOn(base: Vm, arrived = false): void {
	let there = arrived;

	for (;;) {
		if (!there) {
			base.runToBreakpoint();
		}

		there = false;

		const place = placeOf(base);

		// (A capability line whose calls the policy now lets pass — allowed always since it was armed, or its resource
		// allowed once known — isn't a stop: go on, unless the user has a breakpoint there too. Nor is a line armed for a
		// policy since changed.)
		if (base.finished || place === undefined || stopsAt(base, place)) {
			return;
		}

		// A rule's place: its statement runs, then what it sets is set. (Past that, it may be somewhere else armed.)
		const sets = setsAt(place);

		if (sets !== undefined) {
			base.stepStatement();
			makeSets(base, sets, place.line);

			if (base.finished || base.idle) {
				return;
			}

			there = base.atBreakpoint();
		}
	}
}

/** The file `place` is in: as the run has it (the stop's own node's), else as it was read to arm it. */
export function fileAt(vm: Vm, place: Place): ts.SourceFile | undefined {
	const here = vm.currentNode?.getSourceFile();

	if (here?.fileName === place.file) {
		return here;
	}

	return place.file === state.sourceFile?.fileName
		? state.sourceFile
		: state.programFiles.get(place.file);
}

/** A console argument the way node's console prints it: strings bare, everything else JSON-ish. */
function formatLogArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "function") {
		return "[Function: " + ((value as { "name"?: string }).name || "(anonymous)") + "]";
	}

	try {
		return JSON.stringify(value) ?? asString(value);
	} catch {
		return asString(value); // circular, or a BigInt
	}
}

/** `value` as String renders it: what's left to say of a value JSON can't take (undefined, a symbol, a cycle, a BigInt). */
function asString(value: unknown): string {
	// eslint-disable-next-line ts/no-base-to-string -- any value at all reaches here: String's own rendering ("[object Object]" for a cycle) is the one node's console prints
	return String(value);
}

/** The program's console: what it logs goes to the Debug Console (warn/error as stderr), and nothing else happens. */

export function guestConsole(): Record<string, (...args: unknown[]) => void> {
	// (Not a probe's: it didn't run.)
	const write = (stream: "stdout" | "stderr", method: string) => (...args: unknown[]): void => {
		if (state.probing === undefined) {
			state.evaluating?.impure("effect", "console." + method);
			post({
				"type": "output",
				"text": args.map(formatLogArg).join(" "),
				"stream": stream
			});
		}
	};

	return Object.fromEntries(([
		"log",
		"info",
		"debug",
		"dir",
		"warn",
		"error",
		"trace"
	] as const).map((method) => [
		method,
		write(["warn", "error", "trace"].includes(method)
			? "stderr"
			: "stdout", method)
	]));
}

/** A readable one-line rendering of a runtime value for the Variables pane. */
function format(value: unknown): string {
	switch (typeof value) {
		case "string": return JSON.stringify(value);
		case "function": return "ƒ " + ((value as { "name"?: string }).name ?? "");
		case "object":
			if (value === null) {
				return "null";
			}

			try {
				return Array.isArray(value)
					? `Array(${value.length})`
					: "{…}";
			} catch {
				return "{…}";
			}

		case "bigint":
		case "boolean":
		case "number":
		case "symbol":
		case "undefined": return String(value);
		// no default
	}
}

function typeName(value: unknown): string {
	if (value === null) {
		return "null";
	}

	if (Array.isArray(value)) {
		return "array";
	}

	return typeof value;
}

/**
 * Build a DAP-ready snapshot of `vm`'s current stop. M2 is a SINGLE frame at the current node with one
 * "Locals" scope: the in-scope program bindings, walked from the current (top) scope up through its parents
 * (inner shadows outer). Standard globals live on the global object, not as scope bindings, so including the
 * root scope surfaces the program's top-level vars without dumping the whole global namespace.
 */
function snapshot(vm: Vm): Snapshot {
	const loc = vm.location();
	const scope = vm.top?.scope ?? vm.rootScope;

	const rows: Variable[] = [];
	const seen = new Set<string>();

	for (let level: typeof scope | undefined = scope; level !== undefined; level = level.parent) {
		for (const [name, binding] of level.bindings) {
			// (an inner binding shadows an outer one of the same name)
			if (!seen.has(name)) {
				seen.add(name);
				rows.push({
					"name": name,
					"value": binding.initialized
						? format(binding.value)
						: "<uninitialized>",
					"type": typeName(binding.value),
					"variablesReference": 0
				});
			}
		}
	}

	return {
		"frames": [
			{
				"id": 1,
				"name": functionName(vm.currentNode),
				"line": (loc?.line ?? 0) + 1,
				"column": (loc?.character ?? 0) + 1,
				...vm.currentNode === null
					? {}
					: {
							"at": rangeOf(vm.currentNode)
						},
				...loc === null || loc.file === state.sourceFile?.fileName
					? {}
					: {
							"file": loc.file,
							"code": vm.currentNode?.getSourceFile().text.split("\n")[loc.line]?.trim()
						}
			}
		],
		"scopes": {
			"1": [
				{ "name": "Locals", "variablesReference": 1000, "expensive": false },
				...vm.loop === undefined
					? []
					: [
							{ "name": "Event loop", "variablesReference": 2000, "expensive": false }
						]
			]
		},
		"variables": {
			"1000": rows,
			...vm.loop === undefined
				? {}
				: {
						"2000": loopRows(vm.loop)
					}
		}
	};
}

/** What set a timer: setInterval, setImmediate (no delay) or setTimeout. */
function timerKind(timer: { "interval": boolean; "delay": number }): string {
	if (timer.interval) {
		return "setInterval";
	}

	return timer.delay === 0
		? "setImmediate"
		: "setTimeout";
}

/** The event loop at a stop, as the Variables view shows it: the virtual clock (since the run started, and its date),
 *  the pace, each timer pending and when it's due, each host call's result the program is owed — in, or not yet — and
 *  how many choices were made. */
function loopRows(loop: NonNullable<Vm["loop"]>): Variable[] {
	const since = (ms: number): string => `+${ms - state.loopStart}ms`;
	const row = (name: string, value: string, type: string): Variable => ({
		"name": name,
		"value": value,
		"type": type,
		"variablesReference": 0
	});
	const timers = [
		...loop.timers.values()
	].sort((left, right) => left.due - right.due || left.seq - right.seq);

	return [
		row("time", `${since(loop.clock)} · ${new Date(loop.clock).toISOString()}`, "virtual clock"),
		row("pace", loop.pace === "fast"
			? "skipping waits"
			: "real time", ""),
		...timers.slice(0, 20).map((timer) => row(`${timerKind(timer)} ${timer.delay}ms`, `due ${since(timer.due)}${timer.ref ? "" : " · unref'd"}`, "timer")),
		...timers.length > 20
			? [
					row("…", `${timers.length - 20} more timers`, "")
				]
			: [],
		...[
			...loop.results.values()
		].map((result) => row(result.label, result.deliver === undefined
			? "not in yet"
			: "in — waiting its turn", "result")),
		row("choices made", String(loop.choices.length), "")
	];
}

/**
 * Label for the stack frame: the INNERMOST function containing the current node, in its own file. The continuation
 * frames aren't 1:1 with function calls, so we resolve this off the AST instead.
 */
function functionName(node: ts.Node | null): string {
	for (let at = node ?? undefined; at !== undefined; at = at.parent) {
		if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || ts.isArrowFunction(at) || ts.isMethodDeclaration(at)) {
			return at.name !== undefined && ts.isIdentifier(at.name)
				? at.name.text
				: "<anonymous>";
		}
	}

	return "<module>";
}

/** A node's range in the text that ran (offsets, from its first token): what the margin anchors a line's data by — for
 *  a node with a body, its head (`headOf`). */
export function rangeOf(node: ts.Node): [number, number] {
	const head = headOf(node);

	return [
		head.getStart(head.getSourceFile()),
		head.getEnd()
	];
}

/** A function's, a class's or a method's own name, if it's one of those and has one. */
function declaredName(node: ts.Node): ts.Node | undefined {
	return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node)
		? node.name
		: undefined;
}

/** What stands for `node` on the code through a reformat: a statement with a body by its head — an `if`'s or a loop's
 *  condition, a `for`'s header, a function's or a class's name — since its whole span changes with any token in its
 *  body (BABLR's identity for a node includes its children's tokens: a semicolon dropped inside orphans it); anything
 *  else itself. The head starts the line the statement does, where its marks go. */
function headOf(node: ts.Node): ts.Node {
	// (Not a `do … while`: its condition ends it, on another line than its marks.)
	if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isSwitchStatement(node) || ts.isWithStatement(node)) {
		return node.expression;
	}

	if (ts.isForStatement(node)) {
		return node.initializer ?? node.condition ?? node.incrementor ?? node;
	}

	if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
		return node.initializer;
	}

	if (ts.isLabeledStatement(node)) {
		return node.label;
	}

	const name = declaredName(node);

	if (name !== undefined) {
		return name;
	}

	// An unnamed function: its first parameter, or the variable it's assigned to.
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		return node.parameters[0] ?? (ts.isVariableDeclaration(node.parent)
			? node.parent.name
			: node);
	}

	return node;
}

function emitStopped(vm: Vm, reason: string, traveled = false, ask?: CapabilityAsk): void {
	state.denyNext = false;
	state.allowNext = false;
	state.skipNext = false;
	flushValues();
	post({
		"type": "stopped",
		"reason": reason,
		"snapshot": {
			...snapshot(vm),
			"traveled": traveled
		},
		...ask === undefined
			? {}
			: { "ask": ask }
	});
}

/**
 * Pause hook for a breakpoint reached inside a synchronous host-invoked guest call (a server handler, an array
 * callback). We can't await here — the call is running on a synchronous stack driven by tsval's runSub, not
 * by our loop — so we send the stop (tagged `atomic` so the adapter resumes via the control word, not a
 * message the blocked worker can't receive) and then BLOCK the worker on Atomics.wait until the adapter
 * stores 1 + notifies. The main thread stays responsive throughout.
 */
function onBreakpointHook(vm: Vm): void {
	if (state.control === undefined) {
		return; // no shared control word (shouldn't happen post-launch) — resume rather than hang
	}

	const place = placeOf(vm);

	// Only the user's breakpoints pause here. A capability line is armed to ask before its call, which a stop here can't
	// (nor fork to see what the line reaches): the call itself still meets the gate. And a rule's sets wait for the
	// statement's end, which is past this stack.
	if (place === undefined || !userStopAt(place)) {
		return;
	}

	// Set WAITING before posting, so an adapter that stores 1 + notifies before we reach `wait` isn't lost:
	// Atomics.wait returns immediately when the value is no longer 0.
	Atomics.store(state.control, 0, 0);
	flushValues();
	post({
		"type": "stopped",
		"reason": "breakpoint",
		"snapshot": {
			...snapshot(vm),
			"traveled": false
		},
		"atomic": true
	});
	Atomics.wait(state.control, 0, 0);
}

/** The program is over: end the session — with 1 for a program that threw, as node would, and
 *  where it threw. */
function finish(exitCode = 0, crash?: Crash): void {
	endValues();
	// (the step's span closed first: once it's told the run ended the adapter ends this worker, and anything it sent
	// after that is lost — the span's close was, every run)
	state.stepSpan?.end();

	tellEffects();
	tellCoverage();

	post({
		"type": "terminated",
		"exitCode": tellTests(exitCode),
		...crash === undefined
			? {}
			: { "crash": crash }
	});
}

/** Where `vm` is stopped: its file, and the 1-based line in it. */
export function placeOf(vm: Vm): Place | undefined {
	const location = vm.location();

	return location === null
		? undefined
		: { "file": location.file, "line": location.line + 1 };
}

/** Where `error` was thrown, for the margin's mark: by now the frames have unwound, so tsval's note of it, not the
 *  current node. Best-effort — the run ends whatever this finds. */
function crashOf(vm: Vm, error: unknown, message?: string): Crash | undefined {
	if (error instanceof ProgramSyntaxError) {
		return syntaxCrash(error);
	}

	try {
		const site = vm.throwSite(error);
		const at = vm.location(site);
		// (an Error, else whatever was thrown — a primitive)
		const thrown = error as Error | string | number | boolean | null | undefined;

		return at === null || site === null
			? undefined
			: {
					"line": at.line,
					"at": rangeOf(site),
					"message": message ?? String(thrown),
					...at.file === state.sourceFile?.fileName
						? {}
						: { "file": at.file }
				};
	} catch {
		return undefined;
	}
}

/** A live run's step budget: past it, the run stops there rather than running on. */
const LIVE_STEPS = 5_000_000;

/** How long a live run waits on what's pending (an allowed read, say) before ending there: a promise nothing will settle would
 *  otherwise hold it, and what it showed, for good. */
const LIVE_WAIT_MS = 3000;

/** Whether what `vm` is waiting on settled in the time a live run has. */
async function settledInTime(vm: Vm): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		vm.whenSettled().then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => {
				resolve(false);
			}, LIVE_WAIT_MS);
		})
	]);

	clearTimeout(timer);

	return settled;
}

/** Where `vm` stopped short, saying why. */
function stoppedAt(vm: Vm, message: string): Crash | undefined {
	const node = vm.currentNode;
	const at = vm.location(node);

	return at === null || node === null
		? undefined
		: {
				"line": at.line,
				"at": rangeOf(node),
				"message": message,
				"stopped": true,
				...at.file === state.sourceFile?.fileName
					? {}
					: { "file": at.file }
			};
}

/** A file that doesn't parse: marked where the parser stopped, not at the import that loaded it. */
function syntaxCrash(error: ProgramSyntaxError, entry = state.sourceFile?.fileName): Crash {
	return {
		"line": error.line,
		"at": error.at,
		"message": String(error),
		...error.file === entry
			? {}
			: { "file": error.file }
	};
}

/** What a run that stopped on something the debugger can't run says, loudly and as itself — not as the program's own
 *  error, and without naming the interpreter: what it met (marked on its line, as a crash is). Undefined for any other
 *  error. (RUNNING.md: no fallback — a gap is a bug to fix, shown where it was met.) */
function unrunnable(error: unknown): string | undefined {
	if (!(error instanceof TsvalInternalError)) {
		return undefined;
	}

	const unimplemented = /^unimplemented: (?<what>[\s\S]*)$/u.exec(error.message)?.groups?.what;

	return unimplemented === undefined
		? `The debugger failed here: ${error.message}`
		: `Can't run this yet — the debugger doesn't support ${unimplemented}`;
}

/** Guest call depth: the `call`/`construct` frames on the control stack (the rest are expression/statement frames). */
function callDepth(vm: Vm): number {
	let depth = 0;

	for (const frame of vm.frames) {
		if (frame.kind === "call" || frame.kind === "construct") {
			depth += 1;
		}
	}

	return depth;
}

/** Run until the current guest function has returned and the caller reaches its next statement, stopping early at a
 *  breakpoint. At top level (depth 0) nothing can return, so this runs to the next breakpoint or the end, as in VS Code. */
function stepOut(vm: Vm): void {
	const depth = callDepth(vm);

	vm.step();
	vm.runUntil((running) => running.atBreakpoint() || (running.atStatementBoundary() && callDepth(running) < depth));
}

/** Advance `base` (a VM we own) by a forward action, then record the new stop or terminate. When the action
 *  carried a `trace` (the adapter's action span), the step span CONTINUES that trace, so a debug step is one
 *  cross-context trace (adapter action → worker step) rather than an unrelated root. */
/** Do `action` on `base`, as far as it goes without waiting. */
function act(base: Vm, action: ForwardAction): void {
	// Going on from a stop on a rule's place: its statement runs first, then what it sets is set, whichever way it was left.
	const place = state.history.length === 0
		? undefined
		: placeOf(base);
	const sets = place === undefined
		? undefined
		: setsAt(place);

	if (place !== undefined && sets !== undefined) {
		base.stepStatement();
		makeSets(base, sets, place.line);

		if (action === "next" || action === "stepIn" || base.finished || base.idle) {
			return;
		}

		if (action === "continue") {
			runOn(base, base.atBreakpoint());

			return;
		}
	}

	switch (action) {
		case "continue":
			runOn(base);
			break;
		case "next":
			base.stepStatement();
			break;

		case "stepIn":
			base.step();
			break;
		case "stepOut":
			stepOut(base);
			break;
		default: break;
	}
}

/** Why a forward action stopped where it did: a continue (or a step-out a breakpoint cut short) at a breakpoint — a
 *  capability line's, a capability stop — else a step. */
function stopReason(base: Vm, action: ForwardAction, stop: Place | undefined): "capability" | "breakpoint" | "step" {
	if (action === "continue" || (action === "stepOut" && base.atBreakpoint())) {
		return stop !== undefined && capabilityAt(stop)
			? "capability"
			: "breakpoint";
	}

	return "step";
}

async function advanceFrom(base: Vm, action: ForwardAction, trace?: TraceContext): Promise<void> {
	state.current = base;
	state.evaluating = base; // (a program file a package requires is evaluated on the machine running)
	const span = trace !== undefined
		? workerLog().continueSpan(trace, "editor.extensions.tsval.worker.session.step", { "action": action })
		: workerLog().span("editor.extensions.tsval.worker.session.step", { "action": action });

	state.stepSpan = span;

	try {
		try {
			act(base, action);

			// Async work pending and none ready (tsval's steppedAsync): let it settle, then go on — a continue to its next
			// stop, a step to the next statement that runs (in whichever job runs next).
			while (!base.finished && base.idle) {
				if (testsOver(base)) {
					finish(0);
					state.done = true;

					return;
				}

				// Out of work but serving: the session is idle — a request (or a timer it sets) goes on from here.
				if (held.size > 0 || readsStdin()) {
					post({
						"type": "serving",
						"ports": [...listening]
					});
				}

				if (state.live) {
					if (!await settledInTime(base)) {
						finish(0, stoppedAt(base, "still waiting, so it stopped here: Run to finish"));
						state.done = true;

						return;
					}
				} else {
					await base.whenSettled();
				}

				if (state.done) {
					return;
				}

				if (action === "continue") {
					runOn(base);
				} else {
					base.runUntil((vm) => vm.atStatementBoundary() || vm.atBreakpoint());
				}
			}
		} catch (error) {
			// The program called process.exit: it ends there, with its code.
			if (typeof error === "object" && error !== null && EXITED in error) {
				finish(Number((error as { [EXITED]: unknown })[EXITED]) || 0);
				state.done = true;

				return;
			}

			// A live run past its budget stops where it got to, saying so: not a crash.
			if (state.live && error instanceof TsvalInternalError && error.message.startsWith("step budget exceeded")) {
				finish(0, stoppedAt(base, "too long to run live: Run to finish"));
				state.done = true;

				return;
			}

			const unsupported = unrunnable(error);

			post({ "type": "output", "text": unsupported ?? "Uncaught " + String(error), "stream": "stderr" });
			finish(1, crashOf(base, error, unsupported));
			state.done = true;

			return;
		}

		if (base.finished) {
			if (base.completion !== undefined) {
				// (the Debug Console shows it, as a REPL would; node doesn't print it, so a terminal doesn't either)
				post({ "type": "output", "text": "→ " + format(base.completion), "stream": "console" });
			}

			finish(Number(state.guestProcess?.exitCode ?? 0) || 0);
			state.done = true;

			return;
		}

		// Branch: drop any redo tail, then record this stop. The stored fork is only ever forked from, never
		// stepped, so it stays a pristine snapshot we can return to.
		state.history = state.history.slice(0, state.index + 1);
		state.history.push(base);
		keepTold(base);
		state.index = state.history.length - 1;
		// A "continue" that landed on a capability line is a capability stop (the policy gated it); steps stay "step".
		const stop = placeOf(base);
		// A step-out cut short by a breakpoint reports it as one, like a continue would.
		const reason = stopReason(base, action, stop);

		emitStopped(base, reason, false, reason === "capability" && stop !== undefined
			? askAt(base, stop)
			: undefined);
	} finally {
		span.end();
	}
}

async function handle(action: Action): Promise<void> {
	switch (action) {
		case "stepBack":
			if (state.index > 0) {
				state.index -= 1;
			}

			state.current = state.history[state.index];
			emitStopped(state.history[state.index], "step", true);
			break;

		case "reverseContinue":
			// M2: nearest earlier stop. (A true reverse-to-breakpoint scan is a later refinement.)
			if (state.index > 0) {
				state.index -= 1;
			}

			state.current = state.history[state.index];

			emitStopped(state.history[state.index], "breakpoint", true);
			break;

		case "disconnect":
			finish();
			state.done = true;
			break;

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut": {
			// Forward: fork the current stop and advance a copy (honors the action even after a step-back), its
			// observations going on from a copy of that stop's.
			const next = state.history[state.index].fork();

			record(next, copySums(state.sumsOf.get(state.history[state.index])));

			if (next.loop !== undefined) {
				next.loop.pace = state.pace;
			}

			resumeTold(state.history[state.index]);

			await advanceFrom(next, action, state.actionTrace);
			break;
		}

		// no default
	}
}

async function session(initial: Vm, launchTrace?: TraceContext): Promise<void> {
	await advanceFrom(initial, "continue", launchTrace); // run to the first breakpoint (or completion)

	while (!state.done) {
		const action = await nextAction();

		await handle(action);
	}
}

/** A program launched for debugging: its module system ready first (almostnode: packages/tsval/README.md, *Modules*), then its machine — the entry
 *  a module of the program's, its files tsval's — armed and run to its first stop. */
async function launchProgram(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Promise<void> {
	// tsval's event loop (steppedAsync with timers, a virtual clock and a seeded random): async code and timers run
	// on the stack the debugger steps — its breakpoints, capability stops, rules — and the same way every time, so a
	// step forward from any stop it travelled back to goes the way it went. Its start is logged, to run it again; a
	// launch can give one (its clock, seed and schedule).
	// A server it starts keeps it alive: out of work, it idles, serving. A live run's timers go at once, its waits skipped, and
	// nothing keeps it alive past its first idle. It starts with a fresh layer: what the last one wrote is gone.
	state.live = message.live === true;
	state.recordedResults = state.live
		? message.recorded ?? {}
		: {};
	state.runLayer = state.live && state.editorLink !== undefined
		? layered(state.editorLink.fs)
		: undefined;

	const eventLoop = {
		"now": Date.now(),
		"seed": Math.floor(Math.random() * 2 ** 32),
		...message.eventLoop,
		"pace": state.live ? "fast" as const : "real" as const,
		"keepAlive": () => !state.live && (held.size > 0 || readsStdin())
	};
	let modules: ModuleLoader;
	let loadedRuntime: Runtime;

	try {
		loadedRuntime = await runtimeReady(message.workspace);
		modules = programModules(loadedRuntime);
	} catch (error) {
		// (with where: a load failing inside the runtime names no file of the program's)
		post({ "type": "output", "text": `The program's modules can't be loaded: ${error instanceof Error && error.stack !== undefined
			? error.stack
			: String(error)}`, "stream": "stderr" });
		finish(1);

		return;
	}

	// Its capabilities real (RUNNING.md, *Effects are real, decided per call*): each gated call decided as it's made — but
	// for a run of an ordering exploring found (its schedule given), which replays that run: its calls' results the
	// stand-ins' it had.
	const surface = capabilitySurface(message.fileName, message.args ?? [], message.eventLoop?.schedule === undefined
		? loadedRuntime
		: undefined, whereOf(message));

	state.programBuiltins = surface.modules;
	state.programFunctions = functionsIn([surface.modules, surface.globals]);
	state.runtime?.clearCache();
	packagesRan.clear();
	state.baseline = readBaseline();
	state.pins = readPins();
	dropUnpinned();

	startTests();
	startValues();

	let loaded: ReturnType<typeof createVM>;

	try {
		loaded = createVM(message.source, {
			"fileName": message.fileName,
			...state.live
				? { "maxSteps": LIVE_STEPS }
				: {},
			"onBreakpoint": onBreakpointHook,
			"coverage": true,
			"observe": observeSite,
			"trace": traceValue,
			"called": calledSeen,
			"watches": watchedOf(surface.globals, surface.modules, { "__editorTest": testTold, "__editorPlaywright": editorPlaywright }),
			"eventLoop": eventLoop,
			"asyncContext": asyncContext,
			"sharedGlobals": state.runGlobal?.own,
			"globals": {
				...state.nodeGlobals,
				...surface.globals,
				"__editorTest": testTold,
				"__editorPlaywright": editorPlaywright
			},
			"modules": modules
		});
	} catch (error) {
		// The program's own file doesn't parse: nothing of it has run, and the run ends there, as `node`'s does.
		if (!(error instanceof ProgramSyntaxError)) {
			throw error;
		}

		// Saved mid-statement, a live run runs nothing and tells nothing: the margin keeps what the last run that parsed did.
		if (state.live) {
			post({ "type": "terminated", "exitCode": 0, "quiet": true });

			return;
		}

		post({ "type": "output", "text": "Uncaught " + String(error), "stream": "stderr" });
		finish(1, syntaxCrash(error, message.fileName));

		return;
	}

	state.evaluating = loaded.vm;
	record(loaded.vm, new Map());

	state.loopStart = eventLoop.now;
	state.pace = state.live ? "fast" : "real";
	workerLog().info("event loop", {
		"now": eventLoop.now,
		"seed": eventLoop.seed,
		...eventLoop.schedule === undefined
			? {}
			: { "schedule": eventLoop.schedule }
	});

	({ "sourceFile": state.sourceFile } = loaded);
	// Capability breakpoints: pre-arm a breakpoint at every capability call the policy won't let pass, so a
	// gated call hard-stops at its line with the debugger's normal step / step-back, and asks there (RUNTIME-EVIDENCE.md,
	// *Capability decisions, on the line*). No policy → every undecided dangerous call breaks (firewall default).
	({ "policy": state.policy } = message);
	state.userLines = state.live
		? []
		: message.lines;
	state.fileLines = state.live
		? new Map()
		: new Map(Object.entries(message.files ?? {}));

	state.programFiles = new Map([
		[loaded.sourceFile.fileName, loaded.sourceFile]
	]);
	state.capabilityLines = new Map();
	state.placeSets = new Map(Object.entries(message.places ?? {}).map(([file, places]) => [
		file,
		new Map(places.map(({ line, sets }) => [line, sets]))
	]));
	armCapabilities(loaded.sourceFile);
	arm(loaded.vm);

	state.history = [];
	state.index = -1;
	state.done = false;
	await session(loaded.vm, trace);
}

/** Launch a run. */
export function launch(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): void {
	// Absent without cross-origin isolation: then a breakpoint inside a host-invoked handler can't pause (onBreakpointHook).
	state.control = message.control === undefined
		? undefined
		: new Int32Array(message.control);
	workerLog().info("launch", { "file": message.fileName, "breakpoints": message.lines.length });
	void launchProgram(message, trace);
}

export function setBreakpoints(message: Extract<Control, { "type": "setBreakpoints" }>): void {
	// Re-point breakpoints on every stored fork so time-traveled forward runs honor the new set — the capability
	// lines with them (replacing the user's alone would disarm those).
	if (message.file === undefined || message.file === state.sourceFile?.fileName) {
		state.userLines = message.lines;
	} else {
		state.fileLines.set(message.file, message.lines);
	}

	for (const vm of state.history) {
		arm(vm);
	}
}

export function setPace(message: Extract<Control, { "type": "pace" }>): void {
	// From the next wait on — the machine running now, and every stop it may go on from.
	({ "pace": state.pace } = message);

	for (const vm of [...state.history, state.current]) {
		if (vm?.loop !== undefined) {
			vm.loop.pace = state.pace;
		}
	}
}
