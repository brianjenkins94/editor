/**
 * Instrumenting a workspace module for runtime evidence (frameworks/instrument.ts): the instrumented module does what
 * it did before, and tells the page runtime each statement as it starts and what went through each site — in the
 * original source's lines and characters.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { InstrumentLevel } from "../frameworks/instrument.ts";
import { instrument } from "../frameworks/instrument.ts";

/** Compile `source` instrumented, and run it with a recording runtime: what it printed (through `out`), and each event
 *  as `kind text → value` (a value's typeof, null as null; a branch's arm), in the order they happened. */
function run(source: string, level: InstrumentLevel = "full"): { "printed": unknown[]; "events": string[]; "plain": unknown[] } {
	const instrumented = instrument("/workspace/app.ts", "oid", level);
	const compiled = ts.transpileModule(source, { "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ES2020 }, "transformers": { "before": [instrumented.before] } }).outputText;
	const sites = instrumented.sites();
	const lines = source.split("\n");
	const text = (index: number): string => {
		const { start, end } = sites[index];

		return start[0] === end[0] ? lines[start[0]].slice(start[1], end[1]) : lines[start[0]].slice(start[1]) + "…";
	};
	const events: string[] = [];
	const kind = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
	const runtime = {
		"module": (file: string, version: string, table: unknown[][]) => {
			assert.deepEqual([file, version, table.length], ["/workspace/app.ts", "oid", sites.length]);

			// Whether each optional link stopped its chain (a later link is told only when the one before it didn't).
			const stopped = new Map<number, boolean>();

			return {
				"s": (index: number) => { events.push(`statement ${text(index)}`); },
				"v": (index: number, value: unknown) => { stopped.set(index, value === null || value === undefined); events.push(`${sites[index].kind} ${text(index)} → ${kind(value)}`); return value; },
				"c": (index: number, before: number, value: unknown) => {
					if (stopped.get(before) === true) {
						stopped.set(index, true);
					} else {
						stopped.set(index, value === null || value === undefined);
						events.push(`${sites[index].kind} ${text(index)} → ${kind(value)}`);
					}

					return value;
				},
				"b": (index: number, value: unknown) => { events.push(`branch ${text(index)} → ${value ? 0 : 1}`); return value; },
				"a": (index: number, value: unknown) => { events.push(`branch ${text(index)} → ${value ? 0 : 1}`); return value; },
				"o": (index: number, value: unknown) => { events.push(`branch ${text(index)} → ${value ? 1 : 0}`); return value; }
			};
		}
	};
	const execute = (code: string, evidence: unknown): unknown[] => {
		const printed: unknown[] = [];

		// The context is the module's globalThis: the runtime is found there, as in a preview page.
		runInNewContext(code, { "__evidence": evidence, "out": (value: unknown) => { printed.push(value); } });

		return printed;
	};
	const plain = execute(ts.transpileModule(source, { "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ES2020 } }).outputText, undefined);

	return { "printed": execute(instrumented.prelude() + "\n" + compiled, runtime), "events": events, "plain": plain };
}

test("an instrumented module does what it did, without a runtime too", () => {
	const source = "const world = { onWin: () => 1, n: 0 };\nout(world.onWin?.());\nout(world.missing?.x ?? 'none');\n";
	const { printed, plain } = run(source);

	assert.deepEqual(printed, plain);
	assert.deepEqual(printed, [1, "none"]);

	const instrumented = instrument("/workspace/app.ts", "oid");
	const compiled = ts.transpileModule(source, { "compilerOptions": { "module": ts.ModuleKind.ESNext }, "transformers": { "before": [instrumented.before] } }).outputText;
	const printedBare: unknown[] = [];

	// No runtime: the prelude's stand-in.
	runInNewContext(instrumented.prelude() + "\n" + compiled, { "out": (value: unknown) => { printedBare.push(value); } });
	assert.deepEqual(printedBare, [1, "none"]);
});

test("statements as they start; ?. and ?? the value they test; branches the arm that ran", () => {
	assert.deepEqual(run([
		"const world = { onWin: () => 1, map: undefined as { size?: number } | undefined };",
		"if (world.map?.size) { out(1); } else { out(2); }",
		"const n = world.map ?? 3;",
		"out(n > 2 ? 'big' : 'small');",
		"out(true && 'z');",
		"out(false || 'w');"
	].join("\n")).events, [
		"statement const world = { onWin: () => 1, map: undefined as { size?: number } | undefined };",
		"statement if (world.map?.size) { out(1); } else { out(2); }",
		"optional world.map?.size → undefined",
		"branch if (world.map?.size) { out(1); } else { out(2); } → 1",
		"statement out(2);",
		"statement const n = world.map ?? 3;",
		"nullish world.map ?? 3 → undefined",
		"statement out(n > 2 ? 'big' : 'small');",
		"branch n > 2 ? 'big' : 'small' → 0",
		"statement out(true && 'z');",
		"branch true && 'z' → 0",
		"statement out(false || 'w');",
		"branch false || 'w' → 0"
	]);
});

test("parameters without a default or pattern, and returns; an arrow's expression body returns on the arrow", () => {
	assert.deepEqual(run([
		"function make(name: string, score = 0, { x } = { x: 1 }, ...tags: string[]) { return name.length; }",
		"const twice = (n: number) => n * 2;",
		"out(make('ada') + twice(2));"
	].join("\n")).events, [
		"statement const twice = (n: number) => n * 2;",
		"statement out(make('ada') + twice(2));",
		"parameter name: string → string",
		"parameter ...tags: string[] → array",
		"statement return name.length;",
		"return return name.length; → number",
		"parameter n: number → number",
		"return (n: number) => n * 2 → number"
	]);
});

test("an optional call on a member keeps its this, and reads its object once", () => {
	const { printed, events } = run([
		"let reads = 0;",
		"const counter = { n: 41, next() { return this.n + 1; } };",
		"const get = () => { reads += 1; return counter; };",
		"out(get().next?.());",
		"out(reads);"
	].join("\n"));

	assert.deepEqual(printed, [42, 1]);
	assert.ok(events.includes("optional get().next?.() → function"));
});

test("an embedded statement — an if's arm, a loop's body — is counted in a block of its own", () => {
	const { printed, events } = run("let total = 0;\nfor (let i = 0; i < 3; i++) total += i;\nif (total) out(total);\n");

	assert.deepEqual(printed, [3]);
	assert.equal(events.filter((event) => event === "statement total += i;").length, 3);
	assert.ok(events.includes("statement out(total);"));
});

test("coverage only: statements, no sites", () => {
	const { printed, events } = run("const a = null ?? 1;\nif (a) { out(a); }\n", "coverage");

	assert.deepEqual(printed, [1]);
	assert.deepEqual(events, ["statement const a = null ?? 1;", "statement if (a) { out(a); }", "statement out(a);"]);
});
