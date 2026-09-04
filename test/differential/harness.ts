import ts from "typescript";
import assert from "node:assert";
import { interpret } from "../../src/interpret.ts";

/**
 * Differential oracle (ASSIGNMENT S0): compare tsval's observable effects against Node's, running the
 * same program both ways. Node runs the tsc-type-stripped JS; tsval walks the SyntaxKind AST. Any
 * program is then an oracle — no hand-written expected values.
 *
 * Observable effects compared: the completion value (last ExpressionStatement, `eval` semantics),
 * `console.*` output, and whether execution threw.
 */

export interface RunResult {
	value: unknown;
	logs: unknown[][];
	threw: boolean;
	error?: unknown;
}

function makeConsole(logs: unknown[][]): Console {
	const record = (...args: unknown[]) => {
		logs.push(args);
	};
	return { log: record, error: record, warn: record, info: record, debug: record } as unknown as Console;
}

/** The oracle: type-strip with tsc, then evaluate in Node, capturing completion value + console. */
export function runNode(code: string): RunResult {
	const js = ts.transpileModule(code, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
	}).outputText;
	const logs: unknown[][] = [];
	const console = makeConsole(logs);
	// Direct eval inside this function sees the local `console` (shadows global) and returns the
	// completion value of the last statement. Strict mode + an undefined receiver so `this` semantics
	// match a TypeScript module (tsval's deliberate choice): top-level and plain-call `this` are undefined.
	const runner = new Function("console", "code", '"use strict"; return eval(code);');
	try {
		const value = runner.call(undefined, console, js);
		return { value, logs, threw: false };
	} catch (error) {
		return { value: undefined, logs, threw: true, error };
	}
}

/** Run the same source through tsval, capturing the same observable effects. */
export function runTsval(code: string): RunResult {
	const logs: unknown[][] = [];
	const console = makeConsole(logs);
	try {
		const value = interpret(code, { globals: { console }, realGlobals: true });
		return { value, logs, threw: false };
	} catch (error) {
		return { value: undefined, logs, threw: true, error };
	}
}

/** Await a (possibly-thenable) run result, folding a rejection into `threw`. */
async function settle(run: RunResult): Promise<RunResult> {
	if (run.threw) return run;
	try {
		return { ...run, value: await run.value };
	} catch (error) {
		return { value: undefined, logs: run.logs, threw: true, error };
	}
}

/**
 * Async variant: for programs whose completion value is a Promise (async IIFEs). Awaits both sides —
 * their `console` output accumulates during the awaited microtasks — then compares.
 */
export async function assertDifferentialAsync(code: string): Promise<void> {
	const oracle = await settle(runNode(code));
	const actual = await settle(runTsval(code));

	assert.strictEqual(actual.threw, oracle.threw, `throw mismatch for:\n${code}` + (oracle.threw ? `\n  node error: ${(oracle.error as Error)?.message}` : "") + (actual.threw ? `\n  tsval error: ${(actual.error as Error)?.message}` : ""));
	if (oracle.threw) return;
	assert.deepStrictEqual(actual.value, oracle.value, `resolved value mismatch for:\n${code}`);
	assert.deepStrictEqual(actual.logs, oracle.logs, `console output mismatch for:\n${code}`);
}

export type DifferentialOutcome =
	| { kind: "match" }
	| { kind: "both-threw"; node: string; tsval: string } // vacuous agreement: both sides failed
	| { kind: "mismatch"; detail: string };

/**
 * Classify rather than assert (for corpus runs). Awaits thenable completion values on both sides so
 * async programs compare their settled value. "both-threw" is reported separately from "match": two
 * failures agreeing is weaker evidence than two values agreeing.
 */
export async function classifyDifferential(code: string): Promise<DifferentialOutcome> {
	const oracle = await settle(runNode(code));
	const actual = await settle(runTsval(code));
	const msg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
	if (oracle.threw !== actual.threw) {
		return { kind: "mismatch", detail: oracle.threw ? `node threw (${msg(oracle.error)}) but tsval returned ${JSON.stringify(actual.value)}` : `tsval threw (${msg(actual.error)}) but node returned ${JSON.stringify(oracle.value)}` };
	}
	if (oracle.threw) return { kind: "both-threw", node: msg(oracle.error), tsval: msg(actual.error) };
	try {
		assert.deepStrictEqual(actual.value, oracle.value);
		assert.deepStrictEqual(actual.logs, oracle.logs);
		return { kind: "match" };
	} catch (error) {
		return { kind: "mismatch", detail: (error as Error).message.split("\n").slice(0, 6).join("\n") };
	}
}

/** Assert that tsval and Node agree on all observable effects for `code`. */
export function assertDifferential(code: string): void {
	const oracle = runNode(code);
	const actual = runTsval(code);

	assert.strictEqual(
		actual.threw,
		oracle.threw,
		`throw mismatch for:\n${code}\n  node ${oracle.threw ? "threw" : "returned"}${oracle.threw ? ` (${(oracle.error as Error)?.message})` : ""}` +
			`\n  tsval ${actual.threw ? "threw" : "returned"}${actual.threw ? ` (${(actual.error as Error)?.message})` : ""}`,
	);

	if (oracle.threw) return; // both threw — good enough for the oracle (message text is engine-specific)

	assert.deepStrictEqual(actual.value, oracle.value, `completion value mismatch for:\n${code}`);
	assert.deepStrictEqual(actual.logs, oracle.logs, `console output mismatch for:\n${code}`);
}
