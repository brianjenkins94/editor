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
 * `skip`, `todo` and `timeout` options, `before`, `after`, `beforeEach`, `afterEach`, and a test's context: `name`,
 * `diagnostic`, `skip`, `todo`, `test`, `after`, `passed`, `assert` (node:assert) and `mock`. Callback tests (`(t, done)`)
 * too. `mock`: `fn`, `method` (not `getter` or `setter`), `reset`, `restoreAll`, and `timers` (`enable` — setTimeout, setInterval, setImmediate, Date
 * — `tick`, `runAll`, `setTime`, `reset`), as node's are; the runner's own timers are the real ones, so a test's mocked
 * clock doesn't stop it. Not here: snapshots, `only` filtering and concurrency — a test that never settles, with no `timeout`, ends with the
 * run. A `timeout` is the run's clock's, as the program's own time is: in the debugger, where the code runs many times
 * slower than in Node, a limit written for Node holds for what the test waits on, not for how long its code takes.
 */
"use strict";

const assert = require("node:assert");

/** The run's own timers and clock, as they are when this loads: what the runner itself waits with, mocked or not. */
const real = { "setTimeout": globalThis.setTimeout, "clearTimeout": globalThis.clearTimeout, "setInterval": globalThis.setInterval, "clearInterval": globalThis.clearInterval, "setImmediate": globalThis.setImmediate, "clearImmediate": globalThis.clearImmediate, "Date": globalThis.Date };

/** The debug worker's (absent elsewhere): told each test's start and end, and the run's end. */
const tell = typeof globalThis.__editorTest === "function" ? globalThis.__editorTest : () => undefined;

/** What `mock.fn` and `mock.method` made, to restore and reset all at once. */
const made = [];

/** node:test's `mock.fn`: a function that keeps each call (`.mock.calls`), and runs `implementation` (else `original`). */
function fn(original = function () {}, implementation = original, options = {}) {
	const calls = [];
	let current = implementation;
	const once = [];
	let restore = () => undefined;
	function mocked(...args) {
		const run = once.length > 0 ? once.shift() : current;
		const call = { "arguments": args, "this": this, "result": undefined, "error": undefined, "stack": new Error("mock call") };

		calls.push(call);

		try {
			call.result = new.target === undefined ? run.apply(this, args) : Reflect.construct(run, args, new.target);
		} catch (error) {
			call.error = error;

			throw error;
		} finally {
			if (options.times !== undefined && calls.length >= options.times) {
				current = original;
			}
		}

		return call.result;
	}

	mocked.mock = {
		"calls": calls,
		"callCount": () => calls.length,
		"mockImplementation": (next) => { current = next; },
		"mockImplementationOnce": (next) => { once.push(next); },
		"resetCalls": () => { calls.length = 0; },
		"restore": () => { restore(); },
		"_restoring": (how) => { restore = how; }
	};
	made.push(mocked);

	return mocked;
}

/** node:test's `mock.method`: `object[name]` a mock of itself (or of `implementation`), until it's restored. */
function method(object, name, implementation, options = {}) {
	const original = object[name];

	if (typeof original !== "function") {
		throw new TypeError(`The argument 'methodName' must be a method. Received ${String(name)}`);
	}

	const mocked = fn(original, implementation ?? original, options);
	const own = Object.getOwnPropertyDescriptor(object, name);

	object[name] = mocked;
	mocked.mock._restoring(() => {
		if (own === undefined) {
			delete object[name];
		} else {
			Object.defineProperty(object, name, own);
		}
	});

	return mocked;
}

/** node:test's mock timers: the APIs it's enabled for replaced by ones on a clock of its own, which only `tick`,
 *  `runAll` and `setTime` move; each timer due by then run, in the order it's due — one set as another runs, due within
 *  the same tick, too. */
const timers = (() => {
	let enabled;
	let now = 0;
	let next = 1;
	/** What's set: by id, each with when it's due, what it runs, and its interval if it repeats. */
	const queue = new Map();
	const set = (callback, delay, args, every) => {
		const id = next;

		next += 1;
		const wait = Math.max(0, Number(delay) || 0);

		queue.set(id, { "id": id, "at": now + wait, "callback": callback, "args": args, "every": every === undefined ? undefined : Math.max(1, wait) });

		return id;
	};
	const clear = (id) => { queue.delete(typeof id === "object" && id !== null ? id.id : id); };
	/** A timer's handle, as node's mocked ones are: its id, and ref and unref doing nothing. */
	const handle = (id) => ({ "id": id, "ref": () => handle(id), "unref": () => handle(id), "hasRef": () => true, "refresh": () => handle(id), [Symbol.toPrimitive]: () => id });
	const due = () => [...queue.values()].filter((each) => each.at <= now).toSorted((one, other) => one.at - other.at || one.id - other.id)[0];
	const run = () => {
		for (let timer = due(); timer !== undefined; timer = due()) {
			if (timer.every === undefined) {
				queue.delete(timer.id);
			} else {
				timer.at += timer.every;
			}

			timer.callback(...timer.args);
		}
	};
	const fakes = {
		"setTimeout": (callback, delay, ...args) => handle(set(callback, delay, args)),
		"clearTimeout": clear,
		"setInterval": (callback, delay, ...args) => handle(set(callback, delay, args, delay)),
		"clearInterval": clear,
		"setImmediate": (callback, ...args) => handle(set(callback, 0, args)),
		"clearImmediate": clear
	};
	/** Date on the mocked clock: `new Date()` and `Date.now()` are its time; given a value, the real Date's. */
	function MockDate(...args) {
		if (!(this instanceof MockDate)) {
			return new real.Date(now).toString();
		}

		return Reflect.construct(real.Date, args.length === 0 ? [now] : args, new.target ?? MockDate);
	}

	Object.setPrototypeOf(MockDate, real.Date);
	MockDate.prototype = real.Date.prototype;
	MockDate.now = () => now;

	const names = { "setTimeout": ["setTimeout", "clearTimeout"], "setInterval": ["setInterval", "clearInterval"], "setImmediate": ["setImmediate", "clearImmediate"], "Date": ["Date"] };

	return {
		"enable": ({ "apis": apis = ["setInterval", "setTimeout", "setImmediate", "Date"], "now": at = 0 } = {}) => {
			if (enabled !== undefined) {
				throw Object.assign(new Error("MockTimers is already enabled!"), { "code": "ERR_INVALID_STATE" });
			}

			now = typeof at === "object" ? at.getTime() : Number(at);
			enabled = apis.flatMap((api) => names[api] ?? []);

			for (const name of enabled) {
				globalThis[name] = name === "Date" ? MockDate : fakes[name];
			}
		},
		"tick": (ms = 1) => {
			now += ms;
			run();
		},
		"runAll": () => {
			const last = Math.max(now, ...[...queue.values()].filter((each) => each.every === undefined).map((each) => each.at));

			now = last;
			run();
		},
		"setTime": (ms) => { now = ms; },
		"reset": () => {
			for (const name of enabled ?? []) {
				globalThis[name] = real[name];
			}

			enabled = undefined;
			queue.clear();
			now = 0;
		},
		[Symbol.dispose]: () => { timers.reset(); }
	};
})();

/** node:test's `mock`: functions and methods mocked, and timers. */
const mock = {
	"fn": fn,
	"method": method,
	"timers": timers,
	"reset": () => {
		for (const each of made) {
			each.mock.resetCalls();
			each.mock.restore();
		}

		made.length = 0;
		timers.reset();
	},
	"restoreAll": () => {
		for (const each of made) {
			each.mock.restore();
		}
	}
};

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
		real.setTimeout(runAll, 0);
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

/** `work`, or node's failure once `timeout` ms pass without it settling (a test's `timeout` option); `work` as it is
 *  with none. */
async function within(work, timeout) {
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
		return work;
	}

	let timer;

	try {
		return await Promise.race([work, new Promise((_resolve, reject) => {
			timer = real.setTimeout(() => {
				reject(Object.assign(new Error(`test timed out after ${timeout}ms`), { "code": "ERR_TEST_FAILURE", "failureType": "testTimeoutFailure" }));
			}, timeout);
		})]);
	} finally {
		real.clearTimeout(timer);
	}
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
	let error;
	const context = {
		"name": node.name,
		"assert": assert,
		"diagnostic": (message) => print(depth + 1, `ℹ ${message}`),
		"skip": (message) => { skipped = message ?? true; },
		"todo": (message) => { todoed = message ?? true; },
		"after": (fn) => { afters.push(fn); },
		get "passed"() { return error === undefined; },
		"mock": mock,
		"test": (...args) => {
			const { name, options, fn } = parse(...args);
			const child = { "kind": "test", "name": String(name), "options": options, "fn": fn, "children": [], "hooks": hooks(), "parent": node };
			const running = runTest(child, [...titles, child.name], suite, depth + 1);

			subtests.push(running);

			return running;
		}
	};
	const suites = chain(suite);

	tell("start", JSON.stringify(titles));

	try {
		// (its hooks, itself and its subtests, within its `timeout`, as node times them)
		await within((async () => {
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
		})(), node.options.timeout);
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
	"mock": mock,
	"test": test,
	"it": test,
	"describe": describe,
	"suite": describe,
	"before": hook("before"),
	"after": hook("after"),
	"beforeEach": hook("beforeEach"),
	"afterEach": hook("afterEach")
});
