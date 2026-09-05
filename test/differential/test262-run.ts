/**
 * Run one test262 test under the supported-surface policy, with Node as the control.
 *
 * Outcomes:
 * - skipped: excluded by policy (out of scope) or host-dependent — with the reason;
 * - control-failed: Node itself fails it (a feature Node lacks, or a harness limitation) → inconclusive;
 * - pass: Node passes and tsval passes (same criteria);
 * - fail: Node passes and tsval doesn't — a real finding, with the reason.
 */
import nodeVm from "node:vm";
import { parse } from "../../src/frontend.ts";
import { VM } from "../../src/vm.ts";
import { assembleProgram, type Test262Test } from "./test262-corpus.ts";

export type Test262Outcome = { kind: "skipped"; reason: string } | { kind: "control-failed"; reason: string } | { kind: "pass" } | { kind: "fail"; reason: string };

// --- the policy, as a filter ---------------------------------------------------------------------

const SKIP_FLAGS: Record<string, string> = {
	module: "module code (exports/linking are not modeled — tsval runs a program)",
	noStrict: "sloppy-mode-only behavior (out of scope: strict-mode surface)",
	raw: "raw tests run without the harness/strict prefix (parser- and sloppy-mode-oriented)",
	CanBlockIsFalse: "Atomics.wait agent semantics (host)",
	CanBlockIsTrue: "Atomics.wait agent semantics (host)",
};
const SKIP_DIRS: Record<string, string> = {
	"module-code/": "module code (out of scope)",
	"import/": "import declarations against a module graph (out of scope)",
	"eval-code/": "direct/indirect eval semantics (eval is a capability shim, not modeled)",
	"global-code/": "script-global var/function semantics on globalThis (module semantics differ; out of scope)",
};
const SKIP_FEATURES: Record<string, string> = {
	Temporal: "host proposal library",
	decorators: "decorators are out of scope by policy",
	"import-attributes": "module code",
	"import-assertions": "module code",
	"dynamic-import": "needs a module graph",
	"top-level-await": "module code (tsval's own runAsync is unit-tested)",
	"tail-call-optimization": "not implemented by Node either",
	Atomics: "host",
	SharedArrayBuffer: "host",
	IsHTMLDDA: "host exotic",
	hashbang: "parser",
	"explicit-resource-management": "using declarations: not modeled",
	"source-phase-imports": "module code",
	"import-defer": "module code",
};

export function policySkip(test: Test262Test): string | undefined {
	for (const [prefix, reason] of Object.entries(SKIP_DIRS)) if (test.id.startsWith(prefix)) return reason;
	for (const flag of test.meta.flags) if (flag in SKIP_FLAGS) return SKIP_FLAGS[flag];
	for (const feature of test.meta.features) if (feature in SKIP_FEATURES) return `feature ${feature}: ${SKIP_FEATURES[feature]}`;
	if (test.meta.negative !== undefined && test.meta.negative.phase !== "runtime") return `negative ${test.meta.negative.phase}-phase test (tests the parser, not the interpreter)`;
	if (/^identifiers\/.*unicode-1[6-9]\.\d/.test(test.id)) return "identifier characters newer than the TypeScript scanner's Unicode tables (parser)";
	if (/\$262\b/.test(test.source)) return "uses the $262 host object";
	if (/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/.test(test.source)) return "uses eval/Function (direct-eval and code-from-string semantics are a capability shim, not modeled)";
	return undefined;
}

// --- execution --------------------------------------------------------------------------------------

const STEP_BUDGET = 3_000_000;
const ASYNC_TIMEOUT_MS = 5000;
const ASYNC_OK = "Test262:AsyncTestComplete";

interface Verdict {
	ok: boolean;
	reason: string;
}

// Thrown values can be anything — a null-prototype object, a cross-realm error, a symbol — so never
// let describing one throw. (Cross-realm: `instanceof Error` is false; use constructor names.)
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
		if ("name" in e) return safeString((e as { name: unknown }).name);
	}
	return safeString(e);
};
const describe = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? `${errorName(e)}: ${safeString((e as { message: unknown }).message)}` : safeString(e));

/** Judge a run against the test's expectations (positive/negative, sync/async). */
function judge(test: Test262Test, threw: boolean, error: unknown, asyncResult: unknown): Verdict {
	const negative = test.meta.negative;
	if (negative !== undefined) {
		if (!threw) return { ok: false, reason: `expected ${negative.type} but completed` };
		const name = errorName(error);
		return name === negative.type ? { ok: true, reason: "" } : { ok: false, reason: `expected ${negative.type}, got ${describe(error)}` };
	}
	if (threw) return { ok: false, reason: describe(error) };
	if (test.meta.flags.includes("async")) {
		return asyncResult === ASYNC_OK ? { ok: true, reason: "" } : { ok: false, reason: `async: ${String(asyncResult).slice(0, 200)}` };
	}
	return { ok: true, reason: "" };
}

async function settle(value: unknown): Promise<{ threw: boolean; error?: unknown; value: unknown }> {
	if (typeof (value as { then?: unknown })?.then !== "function") return { threw: false, value };
	// The timeout keeps the event loop alive: a test whose promise never settles must fail by timeout,
	// not silently end the process ("unsettled top-level await").
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`async test did not settle within ${ASYNC_TIMEOUT_MS}ms`)), ASYNC_TIMEOUT_MS);
		});
		return { threw: false, value: await Promise.race([value, timeout]) };
	} catch (error) {
		return { threw: true, error, value: undefined };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// test262 tests mutate builtins on purpose (poisoning `Array.prototype[Symbol.iterator]`, …), so each
// side of each test runs in a FRESH realm (`node:vm` context). Neither the process realm nor the next
// test can be contaminated, on either side.
const freshRealm = (): Record<string, unknown> => nodeVm.runInContext("globalThis", nodeVm.createContext({})) as Record<string, unknown>;

/** Node control: the raw JS (no transpile — it *is* JS) as a strict script in a fresh realm. */
async function runControl(test: Test262Test, program: string): Promise<Verdict> {
	let value: unknown;
	try {
		value = nodeVm.runInNewContext(`"use strict";\n${program}`, {}, { timeout: ASYNC_TIMEOUT_MS });
	} catch (error) {
		return judge(test, true, error, undefined);
	}
	const settled = await settle(value);
	return judge(test, settled.threw, settled.error, settled.value);
}

/** tsval: the same program, with a fresh realm's intrinsics as its global object. */
async function runSubject(test: Test262Test, program: string): Promise<Verdict> {
	let value: unknown;
	try {
		// test262 language tests are *scripts*: their top-level `this` is the global object.
		const realm = freshRealm();
		const vm = new VM({ globalObject: realm, realGlobals: false, thisValue: realm });
		vm.load(parse(program));
		vm.runUntil((m) => m.steps > STEP_BUDGET);
		if (!vm.finished && !vm.paused) return { ok: false, reason: `step budget (${STEP_BUDGET}) exhausted` };
		if (vm.paused) value = await vm.runAsync();
		else value = vm.completion;
	} catch (error) {
		return judge(test, true, error, undefined);
	}
	const settled = await settle(value);
	return judge(test, settled.threw, settled.error, settled.value);
}

export async function runTest262(root: string, test: Test262Test): Promise<Test262Outcome> {
	const skip = policySkip(test);
	if (skip !== undefined) return { kind: "skipped", reason: skip };
	const program = assembleProgram(root, test);
	const control = await runControl(test, program);
	if (!control.ok) return { kind: "control-failed", reason: control.reason };
	const subject = await runSubject(test, program);
	return subject.ok ? { kind: "pass" } : { kind: "fail", reason: subject.reason };
}
