import type { PlaceSet } from "@brianjenkins94/editor-api";
import type { ModuleLoader } from "@brianjenkins94/tsval";
import type { Span } from "@brianjenkins94/util/logger";
import type { CapabilityAsk, Control, Crash, Snapshot, Variable, WorkerEvent } from "../debug-protocol";
import type { SiteSums } from "../site-sums";
import type { Runtime } from "./runtime";
import type { Action, ForwardAction, Place, TraceContext, Vm } from "./state";
import { asyncContext } from "@brianjenkins94/almostnode/async-context";
import { revive } from "@brianjenkins94/editor-api/recorded";
import { layered } from "@brianjenkins94/editor-api/runtime";
import { createVM, ProgramSyntaxError, TsvalInternalError } from "@brianjenkins94/tsval";
import ts from "typescript";
import { replayGuard, replayProgram } from "../replay-run";
import { copySums } from "../site-sums";
import { calledSeen, observeSite } from "./busy";
import { armCapabilities, capabilityAt, capabilitySurface, functionsIn, tellEffects, watchedOf } from "./gate";
import { dropUnpinned, readPins } from "./install";
import { packagesRan, readBaseline } from "./package-calls";
import { EXITED, held, listening, readsStdin } from "./process";
import { editorPlaywright, programModules, runtimeReady, whereOf } from "./runtime";
import { linkCallsSince, post, state, workerLog } from "./state";
import { askAt } from "./stops";
import { startTests, tellCoverage, tellTests, testsOver, testTold } from "./tests";
import { endValues, flushValues, keepTold, resumeTold, startValues, tellSet, traceValue } from "./values";

function record(vm: Vm, sums: SiteSums): void {
	state.sumsOf.set(vm, sums);
	state.recording = sums;
}

function nextAction(): Promise<Action> {
	return new Promise((resolve) => {
		state.awaitAction = resolve;
	});
}

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

export function setValue(vm: Vm, name: string, text: string): Extract<WorkerEvent, { "type": "valueSet" }> {
	const literal = literalOf(text);

	if ("error" in literal) {
		return { "type": "valueSet", "ok": false, "error": literal.error };
	}

	for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
		const binding = scope.bindings.get(name);

		if (binding !== undefined) {
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

const setsAt = (place: Place): PlaceSet[] | undefined => state.placeSets.get(place.file)?.get(place.line);

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

function userStopAt(place: Place): boolean {
	return (place.file === state.sourceFile?.fileName
		? state.userLines
		: state.fileLines.get(place.file) ?? []).includes(place.line);
}

function linesIn(file: string): number[] {
	return [
		...file === state.sourceFile?.fileName
			? state.userLines
			: state.fileLines.get(file) ?? [],
		...state.capabilityLines.get(file) ?? [],
		...state.placeSets.get(file)?.keys() ?? []
	];
}

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
		}
	}
}

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

function stopsAt(vm: Vm, place: Place): boolean {
	return userStopAt(place) || (capabilityAt(place) && askAt(vm, place) !== undefined);
}

function runOn(base: Vm, arrived = false): void {
	let there = arrived;

	for (;;) {
		if (!there) {
			base.runToBreakpoint();
		}

		there = false;

		const place = placeOf(base);

		if (base.finished || place === undefined || stopsAt(base, place)) {
			return;
		}

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

export function fileAt(vm: Vm, place: Place): ts.SourceFile | undefined {
	const here = vm.currentNode?.getSourceFile();

	if (here?.fileName === place.file) {
		return here;
	}

	return place.file === state.sourceFile?.fileName
		? state.sourceFile
		: state.programFiles.get(place.file);
}

export function formatLogArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "function") {
		return "[Function: " + ((value as { "name"?: string }).name || "(anonymous)") + "]";
	}

	try {
		return JSON.stringify(value) ?? asString(value);
	} catch {
		return asString(value);
	}
}

function asString(value: unknown): string {
	// eslint-disable-next-line ts/no-base-to-string -- any value at all reaches here: String's own rendering ("[object Object]" for a cycle) is the one node's console prints
	return String(value);
}

export function guestConsole(): Record<string, (...args: unknown[]) => void> {
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

export function guestStream(stream: "stdout" | "stderr"): { "isTTY": boolean; "write": (chunk: unknown, ...rest: unknown[]) => boolean } {
	return {
		"isTTY": false,
		"write": (chunk, ...rest) => {
			const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk);

			if (state.probing === undefined && text !== "") {
				state.evaluating?.impure("effect", `process.${stream}.write`);
				post({ "type": "output", "text": text.replace(/\n$/u, ""), "stream": stream });
			}

			const done = rest.at(-1);

			if (typeof done === "function") {
				queueMicrotask(() => done());
			}

			return true;
		}
	};
}

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

function snapshot(vm: Vm): Snapshot {
	const loc = vm.location();
	const scope = vm.top?.scope ?? vm.rootScope;

	const rows: Variable[] = [];
	const seen = new Set<string>();

	for (let level: typeof scope | undefined = scope; level !== undefined; level = level.parent) {
		for (const [name, binding] of level.bindings) {
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

function timerKind(timer: { "interval": boolean; "delay": number }): string {
	if (timer.interval) {
		return "setInterval";
	}

	return timer.delay === 0
		? "setImmediate"
		: "setTimeout";
}

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

export function rangeOf(node: ts.Node): [number, number] {
	const head = headOf(node);

	return [
		head.getStart(head.getSourceFile()),
		head.getEnd()
	];
}

function declaredName(node: ts.Node): ts.Node | undefined {
	return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node)
		? node.name
		: undefined;
}

function headOf(node: ts.Node): ts.Node {
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

function onBreakpointHook(vm: Vm): void {
	if (state.control === undefined) {
		return;
	}

	const place = placeOf(vm);

	if (place === undefined || !userStopAt(place)) {
		return;
	}

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

function finish(exitCode = 0, crash?: Crash): void {
	endValues();
	state.stepSpan?.end();

	tellEffects();
	tellCoverage();

	const told = tellTests(exitCode);

	endRun({ "exitCode": told, ...crash === undefined ? {} : { "crashed": true } });
	post({
		"type": "terminated",
		"exitCode": told,
		...crash === undefined
			? {}
			: { "crash": crash }
	});
}

function openRun(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Span {
	const attrs = { "path": message.fileName, "args": message.args?.length ?? 0, "live": message.live === true, "replay": message.replay !== undefined };

	linkCallsSince();
	state.runSpan = trace === undefined
		? workerLog().span("editor.extensions.tsval.worker.session.run", attrs)
		: workerLog().continueSpan(trace, "editor.extensions.tsval.worker.session.run", attrs);

	return state.runSpan;
}

function endRun(attrs: Record<string, unknown>): void {
	state.runSpan?.end({ ...attrs, "programFiles": state.programFiles.size, ...linkCallsSince() });
	state.runSpan = undefined;
}

export function placeOf(vm: Vm): Place | undefined {
	const location = vm.location();

	return location === null
		? undefined
		: { "file": location.file, "line": location.line + 1 };
}

function crashOf(vm: Vm, error: unknown, message?: string): Crash | undefined {
	if (error instanceof ProgramSyntaxError) {
		return syntaxCrash(error);
	}

	try {
		const site = vm.throwSite(error);
		const at = vm.location(site);
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

const LIVE_STEPS = 5_000_000;

const LIVE_WAIT_MS = 3000;

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

function unrunnable(error: unknown): string | undefined {
	if (!(error instanceof TsvalInternalError)) {
		return undefined;
	}

	const unimplemented = /^unimplemented: (?<what>[\s\S]*)$/u.exec(error.message)?.groups?.what;

	return unimplemented === undefined
		? `The debugger failed here: ${error.message}`
		: `Can't run this yet — the debugger doesn't support ${unimplemented}`;
}

function callDepth(vm: Vm): number {
	let depth = 0;

	for (const frame of vm.frames) {
		if (frame.kind === "call" || frame.kind === "construct") {
			depth += 1;
		}
	}

	return depth;
}

function stepOut(vm: Vm): void {
	const depth = callDepth(vm);

	vm.step();
	vm.runUntil((running) => running.atBreakpoint() || (running.atStatementBoundary() && callDepth(running) < depth));
}

function act(base: Vm, action: ForwardAction): void {
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

function stopReason(base: Vm, action: ForwardAction, stop: Place | undefined): "capability" | "breakpoint" | "step" {
	if (action === "continue" || (action === "stepOut" && base.atBreakpoint())) {
		return stop !== undefined && capabilityAt(stop)
			? "capability"
			: "breakpoint";
	}

	return "step";
}

async function advanceFrom(base: Vm, action: ForwardAction, trace?: TraceContext, parent: ReturnType<typeof workerLog> = workerLog()): Promise<void> {
	state.current = base;
	state.evaluating = base;
	const span = trace !== undefined
		? workerLog().continueSpan(trace, "editor.extensions.tsval.worker.session.step", { "action": action })
		: parent.span("editor.extensions.tsval.worker.session.step", { "action": action });

	state.stepSpan = span;

	try {
		try {
			act(base, action);

			while (!base.finished && base.idle) {
				if (testsOver(base)) {
					finish(0);
					state.done = true;

					return;
				}

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
			if (typeof error === "object" && error !== null && EXITED in error) {
				finish(Number((error as { [EXITED]: unknown })[EXITED]) || 0);
				state.done = true;

				return;
			}

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
				post({ "type": "output", "text": "→ " + format(base.completion), "stream": "console" });
			}

			finish(Number(state.guestProcess?.exitCode ?? 0) || 0);
			state.done = true;

			return;
		}

		state.history = state.history.slice(0, state.index + 1);
		state.history.push(base);
		keepTold(base);
		state.index = state.history.length - 1;
		const stop = placeOf(base);
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

async function session(initial: Vm, run: Span): Promise<void> {
	await advanceFrom(initial, "continue", undefined, run);

	while (!state.done) {
		const action = await nextAction();

		await handle(action);
	}
}

async function launchProgram(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Promise<void> {
	const run = openRun(message, trace);

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
		loadedRuntime = await run.span("editor.extensions.tsval.worker.session.load", { "first": state.runtime === undefined }, async () => runtimeReady(message.workspace));
		modules = programModules(loadedRuntime);
	} catch (error) {
		post({ "type": "output", "text": `The program's modules can't be loaded: ${error instanceof Error && error.stack !== undefined
			? error.stack
			: String(error)}`, "stream": "stderr" });
		finish(1);

		return;
	}

	const where = whereOf(message);
	const packageProcess = loadedRuntime.getProcess();

	packageProcess.argv = ["node", message.fileName, ...message.args ?? []];

	if (where.env !== undefined) {
		packageProcess.env = { ...where.env };
	}

	if (where.cwd !== undefined && packageProcess.cwd() !== where.cwd) {
		packageProcess.chdir(where.cwd);
	}

	const realmProcess = (globalThis as { "process"?: { "cwd"?: () => string } }).process;

	if (realmProcess !== undefined && realmProcess !== packageProcess) {
		realmProcess.cwd = () => packageProcess.cwd();
	}

	const surface = capabilitySurface(message.fileName, message.args ?? [], message.eventLoop?.schedule === undefined
		? loadedRuntime
		: undefined, where);
	const runProcess = surface.globals["process"] as { "stdout": { "write": unknown }; "stderr": { "write": unknown }; "exit": (code?: number) => never; "exitCode": number | undefined };

	Object.assign(packageProcess.stdout, { "write": runProcess.stdout.write });
	Object.assign(packageProcess.stderr, { "write": runProcess.stderr.write });
	packageProcess.exit = runProcess.exit;
	Object.defineProperty(packageProcess, "exitCode", { "configurable": true, "get": () => runProcess.exitCode, "set": (code: number | undefined) => {
		runProcess.exitCode = code;
	} });

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
		loaded = run.span("editor.extensions.tsval.worker.session.parse", { "path": message.fileName, "bytes": message.source.length }, () => createVM(message.source, {
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
		}));
	} catch (error) {
		if (!(error instanceof ProgramSyntaxError)) {
			throw error;
		}

		if (state.live) {
			endRun({ "exitCode": 0, "unparsed": true });
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
	await session(loaded.vm, run);
}

async function launchReplay(message: Extract<Control, { "type": "launch" }>, replay: NonNullable<Extract<Control, { "type": "launch" }>["replay"]>, trace: TraceContext | undefined): Promise<void> {
	const { standIn, hostGuard } = replayGuard(replay);
	const self = revive(replay.self, standIn);
	const eventLoop = { "now": Date.now(), "seed": 1, "pace": "fast" as const };
	const run = openRun(message, trace);

	state.live = false;
	state.recordedResults = {};
	state.runLayer = undefined;
	startValues();

	let loaded: ReturnType<typeof createVM>;

	try {
		loaded = createVM(replayProgram(message.source, replay.fn), {
			"fileName": message.fileName,
			"onBreakpoint": onBreakpointHook,
			"coverage": true,
			"observe": observeSite,
			"trace": traceValue,
			"eventLoop": eventLoop,
			"asyncContext": asyncContext,
			"sharedGlobals": state.runGlobal?.own,
			"hostGuard": hostGuard,
			"globals": {
				...state.nodeGlobals,
				"__self": typeof self === "object" && self !== null ? self : {},
				"__args": replay.args.map((arg) => revive(arg, standIn)),
				"console": guestConsole()
			}
		});
	} catch (error) {
		post({ "type": "output", "text": `The recorded call can't be replayed: ${error instanceof Error && error.stack !== undefined ? error.stack : String(error)}`, "stream": "stderr" });
		finish(1);

		return;
	}

	for (const [name, value] of Object.entries(replay.free)) {
		loaded.vm.rootScope.bindings.set(name, { "value": revive(value, standIn), "kind": "let", "initialized": true });
	}

	state.evaluating = loaded.vm;
	record(loaded.vm, new Map());
	state.loopStart = eventLoop.now;
	state.pace = "fast";
	({ "sourceFile": state.sourceFile } = loaded);
	state.policy = undefined;
	state.userLines = message.lines;
	state.fileLines = new Map();
	state.programFiles = new Map([[loaded.sourceFile.fileName, loaded.sourceFile]]);
	state.capabilityLines = new Map();
	state.placeSets = new Map();
	arm(loaded.vm);
	state.history = [];
	state.index = -1;
	state.done = false;
	await session(loaded.vm, run);
}

export function launch(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): void {
	state.control = message.control === undefined
		? undefined
		: new Int32Array(message.control);
	workerLog().info("launch", { "file": message.fileName, "breakpoints": message.lines.length, "replay": message.replay !== undefined });
	void (message.replay === undefined ? launchProgram(message, trace) : launchReplay(message, message.replay, trace));
}

export function setBreakpoints(message: Extract<Control, { "type": "setBreakpoints" }>): void {
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
	({ "pace": state.pace } = message);

	for (const vm of [...state.history, state.current]) {
		if (vm?.loop !== undefined) {
			vm.loop.pace = state.pace;
		}
	}
}
