// Evidence from a preview means what evidence from a tsval run means (RUNTIME-EVIDENCE.md, the third slice): the same
// programs, run in tsval with `observe` and instrumented for a preview (almostnode's frameworks/instrument.ts), tell the
// same sites the same values and count the same statements. Run:
//   node --import tsx --test test/preview-instrument.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createVM, typeTag } from "@brianjenkins94/tsval";
import ts from "typescript";
import { instrument } from "../../almostnode/frameworks/instrument.ts";

const at = ([line, character]) => `${line}:${character}`;

/** What tsval observes of `source`: each site event and each statement's count, as comparable lines. */
function tsvalEvents(source) {
	const events = [];
	const { vm, sourceFile } = createVM(source, {
		"coverage": true,
		"globals": { "out": () => undefined },
		"observe": (node, site, value) => {
			const position = (offset) => { const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset); return [line, character]; };

			events.push(`${site} ${at(position(node.getStart(sourceFile)))}-${at(position(node.getEnd()))} ${site === "branch" ? value : typeTag(value)}`);
		}
	});

	vm.run();

	for (const [node, count] of vm.coverage) {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

		for (let n = 0; n < count; n += 1) {
			events.push(`statement ${line}:${character}`);
		}
	}

	return events.sort();
}

/** What the instrumented module tells the page runtime of `source`, as the same lines. */
function previewEvents(source) {
	const events = [];
	const instrumented = instrument("/workspace/app.ts", "oid");
	const compiled = ts.transpileModule(source, { "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ES2020 }, "transformers": { "before": [instrumented.before] } }).outputText;
	const sites = instrumented.sites();
	const range = (index) => `${at(sites[index].start)}-${at(sites[index].end)}`;
	const stopped = new Map();
	const runtime = {
		"module": () => ({
			"s": (index) => { events.push(`statement ${at(sites[index].start)}`); },
			"v": (index, value) => { stopped.set(index, value === null || value === undefined); events.push(`${sites[index].kind} ${range(index)} ${typeTag(value)}`); return value; },
			"c": (index, before, value) => {
				if (stopped.get(before) === true) {
					stopped.set(index, true);
				} else {
					stopped.set(index, value === null || value === undefined);
					events.push(`${sites[index].kind} ${range(index)} ${typeTag(value)}`);
				}

				return value;
			},
			"b": (index, value) => { events.push(`branch ${range(index)} ${value ? 0 : 1}`); return value; },
			"a": (index, value) => { events.push(`branch ${range(index)} ${value ? 0 : 1}`); return value; },
			"o": (index, value) => { events.push(`branch ${range(index)} ${value ? 1 : 0}`); return value; }
		})
	};

	runInNewContext(instrumented.prelude() + "\n" + compiled, { "__evidence": runtime, "out": () => undefined });

	return events.sort();
}

const programs = {
	"optional chains, nullish, branches": [
		"const world = { onWin: () => 1, map: undefined as { size?: number } | undefined };",
		"for (const key of ['a', undefined]) { if (key === 'a') { world.onWin?.(); } }",
		"const size = world.map?.size ?? 0;",
		"out(size > 1 ? 'big' : 'small');",
		"out((size && 'some') || 'none');"
	],
	"parameters and returns": [
		"function pick(key?: string, fallback = 'none', ...rest: number[]) { if (key) { return key; } return fallback; }",
		"const twice = (n: number) => n * 2;",
		"for (const key of ['a', undefined]) { out(pick(key)); }",
		"out(twice(2));"
	],
	"a chain an earlier link stopped": [
		"const world = { map: undefined as { size?: { n: number } } | undefined };",
		"out(world.map?.size?.n);",
		"const other = { map: {} as { size?: { n: number } } };",
		"out(other.map?.size?.n);"
	],
	"a method called optionally keeps its this": [
		"class Counter { n = 1; next(step: number) { return this.n + step; } }",
		"const counter: Counter | undefined = new Counter();",
		"out(counter?.next(1));",
		"const maybe = { tick: undefined as (() => void) | undefined };",
		"out(maybe.tick?.());"
	]
};

for (const [name, lines] of Object.entries(programs)) {
	test(`same evidence from tsval and a preview: ${name}`, () => {
		const source = lines.join("\n");

		assert.deepEqual(previewEvents(source), tsvalEvents(source));
	});
}
