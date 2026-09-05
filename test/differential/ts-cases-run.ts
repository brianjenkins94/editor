/**
 * Run one TypeScript compiler test case differentially: tsc emit in Node (the oracle) vs tsval on
 * the TypeScript source, each in a fresh realm, comparing whether it threw (and what), the completion
 * value and console output. Unlike test262 these programs assert nothing themselves, so the
 * agreement of two engines IS the verdict.
 *
 * Outcomes: skipped (policy) · inconclusive (a side timed out / ran out of steps) · match ·
 * both-threw (agreement on a failure — weaker evidence, reported separately) · mismatch (a finding).
 */
import nodeVm from "node:vm";
import ts from "typescript";
import assert from "node:assert";
import { parse } from "../../src/frontend.ts";
import { VM } from "../../src/vm.ts";
import { TsvalInternalError } from "../../src/errors.ts";
import { structural } from "./harness.ts";
import { caseSource, policySkip, type TsCase } from "./ts-cases-corpus.ts";

export type TsCaseOutcome = { kind: "skipped"; reason: string } | { kind: "inconclusive"; reason: string } | { kind: "match" } | { kind: "both-threw"; node: string; tsval: string } | { kind: "mismatch"; reason: string };

const STEP_BUDGET = 2_000_000;
const TIMEOUT_MS = 2000;

interface SideResult {
	threw: boolean;
	error?: unknown;
	value: unknown;
	logs: unknown[][];
}

const safeString = (v: unknown): string => {
	try {
		return String(v);
	} catch {
		return Object.prototype.toString.call(v);
	}
};
const errorName = (e: unknown): string => {
	if (typeof e === "object" && e !== null) {
		const ctor = (e as { constructor?: { name?: string } }).constructor;
		if (typeof ctor?.name === "string" && ctor.name !== "") return ctor.name;
	}
	return safeString(e);
};
const describe = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? `${errorName(e)}: ${safeString((e as { message: unknown }).message)}` : safeString(e));

// Inert stand-ins for what a real-code oracle must not have (both sides get the same ones).
const blockedProcess = new Proxy({}, { get: (_t, key) => (key === "exit" ? () => { throw new Error("oracle: process.exit is blocked"); } : key === "env" ? {} : undefined) });
const blockedRequire = (spec: string): never => { throw new Error(`oracle: require('${spec}') is blocked`); };
const makeConsole = (logs: unknown[][]): Console => {
	const record = (...args: unknown[]) => void logs.push(args);
	return { log: record, error: record, warn: record, info: record, debug: record } as unknown as Console;
};

async function settle(value: unknown): Promise<{ threw: boolean; error?: unknown; value: unknown }> {
	if (typeof (value as { then?: unknown })?.then !== "function") return { threw: false, value };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`did not settle within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		});
		return { threw: false, value: await Promise.race([value, timeout]) };
	} catch (error) {
		return { threw: true, error, value: undefined };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** tsc's ES2022 emit as a strict SCRIPT (the cases are scripts: top-level `this` is the global
 *  object, which tsval is given too). Returns undefined when Node rejects the emit at compile time —
 *  a strict-mode early error TypeScript's parser does not flag (`arguments = 1`, a top-level
 *  `return`), which is outside the supported surface rather than a disagreement. */
function compileControl(code: string): nodeVm.Script | undefined {
	const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
	try {
		// (`void 0` after the directive: the directive is itself an expression statement and would
		// otherwise be the script's completion value when nothing later produces one)
		return new nodeVm.Script(`"use strict";\nvoid 0;\n${js}`);
	} catch {
		return undefined;
	}
}

/** Node: the compiled script in a fresh realm, with a timeout. */
async function runControl(script: nodeVm.Script): Promise<SideResult> {
	const logs: unknown[][] = [];
	const context = nodeVm.createContext({ console: makeConsole(logs), process: blockedProcess, require: blockedRequire });
	let value: unknown;
	try {
		value = script.runInContext(context, { timeout: TIMEOUT_MS });
	} catch (error) {
		return { threw: true, error, value: undefined, logs };
	}
	const settled = await settle(value);
	return { ...settled, logs };
}

/** tsval on the TypeScript source, in a fresh realm (its global object as top-level `this`, like a script), with a step budget. */
async function runSubject(code: string): Promise<SideResult> {
	const logs: unknown[][] = [];
	const realm = nodeVm.runInContext("globalThis", nodeVm.createContext({})) as Record<string, unknown>;
	let value: unknown;
	try {
		const vm = new VM({ globalObject: realm, realGlobals: false, thisValue: realm, globals: { console: makeConsole(logs), process: blockedProcess, require: blockedRequire } });
		vm.load(parse(code));
		vm.runUntil((m) => m.steps > STEP_BUDGET);
		if (!vm.finished && !vm.paused) return { threw: true, error: new Error(`step budget (${STEP_BUDGET}) exhausted`), value: undefined, logs };
		value = vm.paused ? await vm.runAsync() : vm.completion;
	} catch (error) {
		return { threw: true, error, value: undefined, logs };
	}
	const settled = await settle(value);
	return { ...settled, logs };
}

const isTimeout = (e: unknown): boolean => /timed out|did not settle|step budget/.test(safeString((e as { message?: unknown })?.message ?? e)) || (e as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";

export async function runTsCase(test: TsCase): Promise<TsCaseOutcome> {
	const skip = policySkip(test);
	if (skip !== undefined) return { kind: "skipped", reason: skip };
	const code = caseSource(test);
	const script = compileControl(code);
	if (script === undefined) return { kind: "skipped", reason: "not valid strict-mode code (a Node early error TypeScript's parser does not flag)" };
	const control = await runControl(script);
	if (control.threw && isTimeout(control.error)) return { kind: "inconclusive", reason: "node timed out" };
	const subject = await runSubject(code);
	if (subject.threw && subject.error instanceof TsvalInternalError) return { kind: "mismatch", reason: `tsval internal: ${subject.error.message.slice(0, 120)}` };
	if (subject.threw && isTimeout(subject.error)) return { kind: "inconclusive", reason: "tsval ran out of steps" };
	if (control.threw !== subject.threw) {
		return { kind: "mismatch", reason: control.threw ? `node threw ${describe(control.error).slice(0, 100)}, tsval completed` : `tsval threw ${describe(subject.error).slice(0, 100)}, node completed` };
	}
	if (control.threw) {
		const a = errorName(control.error);
		const b = errorName(subject.error);
		if (a !== b) return { kind: "mismatch", reason: `different errors: node ${a}, tsval ${b}` };
		return { kind: "both-threw", node: describe(control.error), tsval: describe(subject.error) };
	}
	try {
		assert.deepStrictEqual(structural(subject.value), structural(control.value));
	} catch (error) {
		return { kind: "mismatch", reason: `completion differs: ${(error as Error).message.split("\n").slice(0, 4).join(" ").slice(0, 160)}` };
	}
	try {
		assert.deepStrictEqual(structural(subject.logs), structural(control.logs));
	} catch (error) {
		return { kind: "mismatch", reason: `console output differs: ${(error as Error).message.split("\n").slice(0, 4).join(" ").slice(0, 160)}` };
	}
	return { kind: "match" };
}
