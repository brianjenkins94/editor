/**
 * `@playwright/test`, as a test file run in the editor has it: Playwright's test API over the editor's node:test
 * (node-test.js, so each test is told and traced as any other, and stepping and breakpoints work in it), with a `page`
 * per test that drives the preview you have open. The page and `expect` are packages/playwright's, handed over by the
 * debug worker (`__editorPlaywright`): they run in the worker, not stepped, and each op runs on the preview's page in
 * the shell (`playwright.run`).
 *
 * What's here: `test` (its `page` and `browserName` fixtures, and its info), `.skip` (declared, or called in a test),
 * `.fixme`, `.only`, `.describe` (`.skip`, `.only`, `.serial`, `.parallel`, `.configure`), `beforeEach`, `afterEach`,
 * `beforeAll`, `afterAll`, `step`, `info`; `expect`. Not here: `test.extend` (fixtures of your own), `test.use`'s
 * options (accepted, unused), other browsers, contexts, `request`, and timeouts — a test that never settles ends with
 * the run.
 */
"use strict";

const nodeTest = require("node:test");

/** The debug worker's (absent elsewhere): `page()` makes a page, and `expect`. */
const host = globalThis.__editorPlaywright;

const outside = () => new Error("@playwright/test runs in the editor's debugger, against the preview you have open: there's no page here");

/** Each running test's fixtures, by its node:test context — its hooks and its body share one page. */
const fixtures = new WeakMap();
/** The test running now (they run one at a time): what `test.skip()` and `test.info()` in it are about. */
let current;

function fixturesOf(context) {
	let known = fixtures.get(context);

	if (known === undefined) {
		if (host === undefined) {
			throw outside();
		}

		known = { "page": host.page(), "browserName": "chromium" };
		fixtures.set(context, known);
	}

	return known;
}

/** A test's info, as Playwright gives a test its second argument. */
const infoOf = (context) => ({ "title": context.name ?? "", "annotations": [], "skip": (...args) => skip(...args) });

/** A Playwright test or hook body as node:test calls it: one argument (node:test takes two as a callback test), with
 *  the fixtures it destructures and the test's info. */
function wrapped(fn) {
	if (typeof fn !== "function") {
		return fn;
	}

	return async (context) => {
		current = context;

		return fn(fixturesOf(context), infoOf(context));
	};
}

/** `(title, details?, body)`, as Playwright declares a test or a hook, as node:test's arguments. */
function declared(title, details, body) {
	if (typeof title === "function") {
		return [wrapped(title)];
	}

	return [title, wrapped(typeof details === "function" ? details : body)];
}

/** Skipped where it stops: in a test, Playwright's `test.skip()` (or `skip(condition, reason)`) ends it, skipped. */
class Skipped extends Error {}

function skip(condition = true, reason = undefined) {
	if (condition) {
		current?.skip(reason);

		throw new Skipped(reason ?? "skipped");
	}
}

function test(title, details, body) {
	return nodeTest.test(...declared(title, details, body));
}

/** `test.skip(title, body)` declares a skipped test; `test.skip()` / `test.skip(condition, reason)` in one skips it. */
test.skip = (title, details, body) => {
	if (typeof title === "string" && (typeof details === "function" || typeof body === "function")) {
		return nodeTest.test.skip(...declared(title, details, body));
	}

	return skip(title, details);
};
test.fixme = test.skip;
test.only = test;
test.slow = () => undefined;
test.setTimeout = () => undefined;
test.use = () => undefined;
test.info = () => infoOf(current ?? {});
test.step = async (title, body) => body();
test.extend = () => {
	throw new Error("test.extend isn't here: the editor's @playwright/test has its page and browserName fixtures only");
};

function describe(title, body) {
	return typeof title === "function" ? nodeTest.describe(title) : nodeTest.describe(title, body);
}

describe.skip = (title, body) => nodeTest.describe.skip(title, body);
describe.only = describe;
describe.serial = describe;
describe.parallel = describe;
describe.configure = () => undefined;
test.describe = describe;

test.beforeEach = (title, body) => nodeTest.beforeEach(declared(title, body).at(-1));
test.afterEach = (title, body) => nodeTest.afterEach(declared(title, body).at(-1));
test.beforeAll = (title, body) => nodeTest.before(declared(title, body).at(-1));
test.afterAll = (title, body) => nodeTest.after(declared(title, body).at(-1));

const expect = host?.expect ?? (() => {
	throw outside();
});

module.exports = { "test": test, "expect": expect, "devices": {}, "defineConfig": (config) => config };
