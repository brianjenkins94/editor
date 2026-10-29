/**
 * `node:test`, as a test file run in the editor has it: written in JavaScript and run by tsval as the program's own code
 * is (the debug worker serves it for `node:test`), so a test's awaits are the program's — on its deterministic event
 * loop — and stepping and breakpoints work in a test as anywhere. Tests run once the file has loaded, one at a time, in
 * the order they were declared; a test's subtests (`t.test`) as it calls them.
 *
 * Each test's start and end are told to the debug worker (`__editorTest`): what ran between them is that test's — its
 * hooks and subtests included — kept as a trace of the test on each file it ran (RUNNING.md, *Tests*).
 *
 * What's here: `test` (`it`), `describe` (`suite`), their `.skip` and `.todo` (and `.only`, run as any other), the
 * `skip` and `todo` options, `before`, `after`, `beforeEach`, `afterEach`, and a test's context: `name`, `diagnostic`,
 * `skip`, `todo`, `test`, `after` and `assert` (node:assert). Callback tests (`(t, done)`) too. Not here: `mock`,
 * snapshots, `only` filtering, timeouts and concurrency — a test that never settles ends with the run.
 */
"use strict";

const assert = require("node:assert");

/** The debug worker's (absent elsewhere): told each test's start and end, and the run's end. */
const tell = typeof globalThis.__editorTest === "function" ? globalThis.__editorTest : () => undefined;

const hooks = () => ({ "before": [], "after": [], "beforeEach": [], "afterEach": [] });
/** The tests declared at the top of the file, and its suites: a tree. */
const root = { "kind": "suite", "name": "", "children": [], "hooks": hooks(), "parent": undefined };
/** The suite being declared now (a describe's body runs as it's declared). */
let declaring = root;
let scheduled = false;
const counts = { "tests": 0, "pass": 0, "fail": 0, "skipped": 0, "todo": 0 };

/** `(name?, options?, fn?)`, as node:test takes them. */
function parse(name, options, fn) {
	if (typeof name === "function") {
		return { "name": name.name || "<anonymous>", "options": {}, "fn": name };
	}

	if (typeof options === "function") {
		return { "name": name ?? "<anonymous>", "options": {}, "fn": options };
	}

	if (typeof name === "object" && name !== null) {
		return { "name": (typeof options === "function" ? options.name : "") || "<anonymous>", "options": name, "fn": options };
	}

	return { "name": name ?? "<anonymous>", "options": options ?? {}, "fn": fn };
}

function schedule() {
	if (!scheduled) {
		scheduled = true;
		setTimeout(runAll, 0);
	}
}

function declare(kind, args, extra = {}) {
	const { name, options, fn } = parse(...args);
	const node = { "kind": kind, "name": String(name), "options": { ...options, ...extra }, "fn": fn, "children": [], "hooks": hooks(), "parent": declaring };

	declaring.children.push(node);

	if (kind === "suite" && typeof fn === "function" && node.options.skip === undefined && node.options.todo === undefined) {
		const outer = declaring;

		declaring = node;

		try {
			fn();
		} finally {
			declaring = outer;
		}
	}

	schedule();

	return Promise.resolve();
}

function test(...args) {
	return declare("test", args);
}

function describe(...args) {
	return declare("suite", args);
}

test.skip = (...args) => declare("test", args, { "skip": true });
test.todo = (...args) => declare("test", args, { "todo": true });
test.only = test;
describe.skip = (...args) => declare("suite", args, { "skip": true });
describe.todo = (...args) => declare("suite", args, { "todo": true });
describe.only = describe;

/** A hook on the suite being declared (the file's, at its top). */
const hook = (kind) => (fn) => {
	declaring.hooks[kind].push(fn);
};

/** The suites from the file's down to `suite`. */
function chain(suite) {
	const suites = [];

	for (let each = suite; each !== undefined; each = each.parent) {
		suites.unshift(each);
	}

	return suites;
}

/** Call `fn` as node:test does: with `done` when it takes two arguments, else awaited. */
function call(fn, context) {
	if (typeof fn !== "function") {
		return undefined;
	}

	if (fn.length >= 2) {
		return new Promise((resolve, reject) => {
			fn(context, (error) => (error ? reject(error) : resolve()));
		});
	}

	return fn(context);
}

function print(depth, line) {
	console.log("  ".repeat(depth) + line);
}

/** What a test threw: its name and message (an assertion's says what differed), and where in the program's own code —
 *  never the debugger's frames, which an error thrown by a built-in carries. */
function errorText(error) {
	if (typeof error !== "object" || error === null || !("message" in error)) {
		return String(error);
	}

	const frames = String(error.stack ?? "").split("\n").filter((line) => /^\s+at /u.test(line) && line.includes("/workspace/"));

	return [`${error.name ?? "Error"}: ${error.message}`, ...frames.map((line) => line.trim())].join("\n");
}

/** A value as an assertion's message would show it, short. */
function shown(value) {
	let text;

	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}

	return text.length > 500 ? text.slice(0, 500) + "…" : text;
}

/** What a failed assertion compared (node:assert's AssertionError), as JSON for the debug worker; undefined otherwise. */
function assertionOf(error) {
	if (typeof error !== "object" || error === null || error.code !== "ERR_ASSERTION" || !("actual" in error)) {
		return undefined;
	}

	return JSON.stringify({ "actual": shown(error.actual), "expected": shown(error.expected), ...typeof error.operator === "string" ? { "operator": error.operator } : {} });
}

async function runTest(node, titles, suite, depth) {
	const skip = node.options.skip;
	const todo = node.options.todo;

	counts.tests += 1;

	if (skip !== undefined && skip !== false) {
		counts.skipped += 1;
		tell("end", JSON.stringify(titles), "skip");
		print(depth, `﹣ ${node.name} # SKIP${typeof skip === "string" ? " " + skip : ""}`);

		return;
	}

	const subtests = [];
	const afters = [];
	let skipped;
	let todoed = todo !== undefined && todo !== false ? todo : undefined;
	const context = {
		"name": node.name,
		"assert": assert,
		"diagnostic": (message) => print(depth + 1, `ℹ ${message}`),
		"skip": (message) => { skipped = message ?? true; },
		"todo": (message) => { todoed = message ?? true; },
		"after": (fn) => { afters.push(fn); },
		"test": (...args) => {
			const { name, options, fn } = parse(...args);
			const child = { "kind": "test", "name": String(name), "options": options, "fn": fn, "children": [], "hooks": hooks(), "parent": node };
			const running = runTest(child, [...titles, child.name], suite, depth + 1);

			subtests.push(running);

			return running;
		}
	};
	const suites = chain(suite);
	let error;

	tell("start", JSON.stringify(titles));

	try {
		for (const each of suites) {
			for (const fn of each.hooks.beforeEach) {
				await call(fn, context);
			}
		}

		await call(node.fn, context);
		await Promise.all(subtests);

		for (const each of suites.toReversed()) {
			for (const fn of each.hooks.afterEach) {
				await call(fn, context);
			}
		}
	} catch (thrown) {
		error = thrown;
	}

	for (const fn of afters) {
		try {
			await fn(context);
		} catch (thrown) {
			error ??= thrown;
		}
	}

	const outcome = skipped !== undefined ? "skip" : todoed !== undefined ? "todo" : error === undefined ? "pass" : "fail";

	counts[{ "pass": "pass", "fail": "fail", "skip": "skipped", "todo": "todo" }[outcome]] += 1;
	tell("end", JSON.stringify(titles), outcome, error === undefined ? undefined : errorText(error), assertionOf(error));

	if (outcome === "pass") {
		print(depth, `✔ ${node.name}`);
	} else if (outcome === "fail") {
		print(depth, `✖ ${node.name}`);

		for (const line of errorText(error).split("\n")) {
			print(depth + 2, line);
		}
	} else {
		print(depth, `﹣ ${node.name} # ${outcome.toUpperCase()}${typeof (skipped ?? todoed) === "string" ? " " + (skipped ?? todoed) : ""}`);
	}
}

async function runSuite(suite, titles, depth) {
	const skip = suite.options?.skip ?? suite.options?.todo;

	if (suite !== root) {
		print(depth, `▶ ${suite.name}`);
	}

	if (skip !== undefined && skip !== false) {
		return;
	}

	for (const fn of suite.hooks.before) {
		await call(fn, {});
	}

	for (const child of suite.children) {
		const childTitles = [...titles, child.name];

		if (child.kind === "suite") {
			await runSuite(child, childTitles, depth + 1);
		} else {
			await runTest(child, childTitles, suite, suite === root ? depth : depth + 1);
		}
	}

	for (const fn of suite.hooks.after) {
		await call(fn, {});
	}
}

async function runAll() {
	try {
		await runSuite(root, [], 0);
	} catch (error) {
		counts.fail += 1;
		console.log("✖ a hook failed");
		console.log(errorText(error));
	}

	console.log(`ℹ tests ${counts.tests}`);
	console.log(`ℹ pass ${counts.pass}`);
	console.log(`ℹ fail ${counts.fail}`);
	console.log(`ℹ skipped ${counts.skipped}`);
	console.log(`ℹ todo ${counts.todo}`);
	tell("done", String(counts.fail));
}

module.exports = test;
Object.assign(test, {
	"test": test,
	"it": test,
	"describe": describe,
	"suite": describe,
	"before": hook("before"),
	"after": hook("after"),
	"beforeEach": hook("beforeEach"),
	"afterEach": hook("afterEach")
});
