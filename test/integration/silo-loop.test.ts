/**
 * The static→dynamic loop, end to end, against the REAL static kernel: silo predicts (`detect`) and
 * locates (`findReach`) capabilities statically; tsval's canary runs the program with recording shims
 * and checks the divergence predicate `runtime-caps ⊆ static-caps` (ASSIGNMENT §1, §5 S5).
 *
 * What the loop must show:
 * - agreement on straightforward code (and the resource VALUES agree);
 * - static under-prediction is caught dynamically (the reason tsval exists): aliasing / computed
 *   member names / reflection defeat the regexes, the shims do not care how the callee was reached;
 * - the dynamic side RESOLVES resources static analysis could not (a concatenated URL);
 * - static over-prediction is fine (`runtime ⊆ static` holds when a predicted branch never runs);
 * - the two sides share one capability vocabulary.
 *
 * Skipped when `../lib` isn't checked out next to this repo.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exploreCanary, runCanary } from "../../src/canary.ts";
import { loadSilo, type Silo } from "./silo.ts";

const silo = await loadSilo();
const skip = silo === undefined ? "../lib/util/silo (and lib's tsx) not available" : false;

function loop(kernel: Silo, code: string) {
	const predicted = kernel.detect(code);
	const reaches = kernel.findReach("program.ts", code);
	const report = runCanary(code, { predicted });
	return { predicted, reaches, report };
}

test("agreement: a literal fetch is predicted, located, and observed with the same resource", { skip }, () => {
	const { predicted, reaches, report } = loop(silo as Silo, `fetch("https://api.example.com/data")`);
	assert.deepEqual(predicted, ["net"]);
	assert.ok(report.ok && !report.aborted);
	assert.deepEqual(report.observedCaps, ["net"]);
	assert.equal(report.observed[0].value, reaches[0].value);
	assert.equal(report.observed[0].callee, reaches[0].callee);
});

test("static under-prediction is caught dynamically (aliasing / computed names / reflection)", { skip }, () => {
	for (const code of [
		`const f = globalThis["fe" + "tch"]; f("https://sneaky.example")`,
		`const name = "fet" + "ch"; globalThis[name]("https://sneaky.example")`,
		`Reflect.get(globalThis, ["fetch"].join(""))("https://sneaky.example")`,
		`const g = globalThis; const { fetch: alias } = g; alias("https://sneaky.example")`,
	]) {
		const { predicted, reaches, report } = loop(silo as Silo, code);
		assert.deepEqual(predicted, [], `static must not see it: ${code}`);
		assert.deepEqual(reaches, []);
		assert.ok(report.aborted, `the canary must trip: ${code}`);
		assert.equal(report.divergence?.capability, "net");
		assert.equal(report.divergence?.value, "https://sneaky.example");
	}
});

test("the dynamic side resolves resources static analysis could not (Axis 2)", { skip }, () => {
	const code = `const base = "https://api.example.com"; const path = ["users", 42].join("/"); fetch(base + "/" + path)`;
	const { predicted, reaches, report } = loop(silo as Silo, code);
	assert.deepEqual(predicted, ["net"]); // the regex sees `fetch(`
	assert.deepEqual(reaches, []); // but no literal resource to locate
	assert.ok(report.ok);
	assert.equal(report.observed[0].value, "https://api.example.com/users/42");
});

test("static over-prediction is fine: runtime ⊆ static holds when the predicted branch never runs", { skip }, () => {
	const code = `let mode = "read"; if (mode === "write") fetch("https://never.example"); process.env.HOME; mode`;
	const { predicted, report } = loop(silo as Silo, code);
	assert.deepEqual(predicted, ["env", "net"]);
	assert.ok(report.ok);
	assert.deepEqual(report.observedCaps, ["env"]);
	assert.equal(report.completion, "read");
});

test("fs granularity agrees: a read is fs:read on both sides, and a write outside the prediction trips", { skip }, () => {
	const read = loop(silo as Silo, `import fs from "node:fs"; fs.readFileSync("/etc/hosts")`);
	assert.deepEqual(read.predicted, ["fs:read"]);
	assert.ok(read.report.ok);
	assert.deepEqual(read.report.observedCaps, ["fs:read"]);
	assert.equal(read.report.observed[0].value, read.reaches[0].value);

	// The write is reached through a member computed at runtime: static sees only the import (`fs`, coarse).
	const write = loop(silo as Silo, `import fs from "node:fs"; const op = "write" + "FileSync"; fs[op]("/etc/passwd", "x")`);
	assert.deepEqual(write.predicted, ["fs"]);
	assert.ok(write.report.ok, "coarse `fs` covers fs:write — the prediction is honest, if imprecise");
	assert.deepEqual(write.report.observedCaps, ["fs:write"]);
	assert.equal(write.report.observed[0].value, "/etc/passwd");

	// Both the module and the member reached through computed names: nothing for the regexes to see.
	const undeclared = loop(silo as Silo, `const fs = globalThis["req" + "uire"]?.("fs"); const op = "write" + "FileSync"; fs?.[op]("/etc/passwd", "x")`);
	assert.deepEqual(undeclared.predicted, []);
	assert.ok(undeclared.report.aborted || undeclared.report.observedCaps.length === 0, "either the tripwire trips or nothing is reachable — never a silent write");
});

test("exploration covers every branch against the static prediction", { skip }, () => {
	const code = `if (Math.random() > 0.5) fetch("https://a.example"); else process.env.HOME`;
	const kernel = silo as Silo;
	const predicted = kernel.detect(code);
	const exploration = exploreCanary(code, { predicted });
	assert.ok(exploration.ok);
	assert.equal(exploration.paths.length, 2);
	assert.deepEqual([...new Set(exploration.observed.map((e) => e.capability))].sort(), ["env", "net"]);

	// Narrow the prediction and exploration finds the path that escapes it.
	const narrowed = exploreCanary(code, { predicted: ["env"] });
	assert.ok(!narrowed.ok);
	assert.ok(narrowed.paths.some((p) => p.divergence?.capability === "net"));
});

test("the two sides share one capability vocabulary", { skip }, () => {
	const kernel = silo as Silo;
	const known = new Set(["net", "env", "eval", "fs", ...Object.keys(kernel.CALL_DETECTORS)]);
	const programs = [
		`fetch("https://a.example")`,
		`process.env.PATH`,
		`import { spawnSync } from "node:child_process"; spawnSync("ls")`,
		`import { writeFileSync, readFileSync } from "node:fs"; writeFileSync("/tmp/x", readFileSync("/tmp/y"))`,
		`eval("1 + 1")`,
	];
	for (const code of programs) {
		const { predicted, report } = loop(kernel, code);
		for (const cap of report.observedCaps) assert.ok(known.has(cap), `canary capability '${cap}' is not in silo's vocabulary`);
		for (const cap of report.observedCaps) assert.ok(predicted.includes(cap) || (cap.startsWith("fs:") && predicted.includes("fs")), `${code}: '${cap}' observed but static predicted ${JSON.stringify(predicted)}`);
	}
});
