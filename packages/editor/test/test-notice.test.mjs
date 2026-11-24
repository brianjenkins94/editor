/**
 * What a test file's tests notice broken (workbench/test-notice.ts): the statements its tests ran, outside test files,
 * each skipped in turn — their own feature's first — and which tests failed for it.
 *
 *   node --import tsx --test test/test-notice.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { candidatesOf, keyOf, noticingOf, prunedOf, saidOf, triedOf } = await import("../workbench/test-notice.ts");

const SUM = "export function total(items) {\n\tlet sum = 0;\n\tfor (const item of items) sum += item;\n\t;\n\treturn sum;\n}\n";
const TEXTS = { "src/sum.js": SUM, "src/other.js": "seen.push(1);\n" };

function ran(titles, outcome, files) {
	return { "titles": titles, "outcome": outcome, "files": files };
}

function statement(line, from, to) {
	return [
		[line, from],
		[line, to]
	];
}

test("each statement the passing tests ran outside test files, once, with the tests that ran it — its own feature's code first", () => {
	const tests = [
		ran(["adds"], "pass", [
			{
				"file": "/workspace/src/sum.test.js",
				"statements": [
					statement(0, 0, 10)
				]
			},
			{
				"file": "/workspace/src/sum.js",
				"statements": [
					statement(1, 1, 13),
					statement(3, 1, 2),
					statement(4, 1, 12)
				]
			},
			{
				"file": "/workspace/src/other.js",
				"statements": [
					statement(0, 0, 13)
				]
			}
		]),
		ran(["empty"], "pass", [
			{
				"file": "/workspace/src/sum.js",
				"statements": [
					statement(4, 1, 12)
				]
			}
		]),
		ran(["broken"], "fail", [
			{
				"file": "/workspace/src/sum.js",
				"statements": [
					statement(2, 1, 37)
				]
			}
		])
	];
	const found = candidatesOf("src/sum.test.js", tests, (path) => TEXTS[path], (path) => path === "src/sum.js");

	assert.deepEqual(found.map((each) => [each.key, each.tests]), [
		[
			"src/sum.js:5:2",
			["src/sum.test.js › adds", "src/sum.test.js › empty"]
		],
		[
			"src/other.js:1:1",
			["src/sum.test.js › adds"]
		]
	], "the empty statement and the declaration left out, the failing test's reach too");
	assert.deepEqual(found[0].skip, { "file": "/workspace/src/sum.js", "line": 4, "character": 1 });
});

test("a mutant's run: the tests that didn't pass noticed it, and how many times it was skipped", () => {
	const candidate = {
		"key": "src/sum.js:5:2",
		"skip": { "file": "/workspace/src/sum.js", "line": 4, "character": 1 },
		"tests": ["f › a", "f › b", "f › c"]
	};
	const run = {
		"exitCode": 1,
		"ms": 5,
		"effects": [],
		"output": "",
		"attached": true,
		"skipped": 2,
		"tests": [
			ran(["a"], "fail", []),
			ran(["b"], "pass", [])
		]
	};

	assert.deepEqual(triedOf(candidate, run, "f"), {
		"tests": ["f › a", "f › b", "f › c"],
		"noticed": ["f › a", "f › c"],
		"skipped": 2
	}, "one that never reported didn't pass");
});

test("per test, how many statements tried it noticed, and which it missed; one never skipped doesn't count", () => {
	const kept = {
		"file": "f",
		"at": "",
		"digests": {},
		"tried": {
			[keyOf("a.js", 0, 0)]: {
				"tests": ["f › x", "f › y"],
				"noticed": ["f › x"],
				"skipped": 1
			},
			[keyOf("a.js", 1, 0)]: {
				"tests": ["f › x", "f › y"],
				"noticed": [],
				"skipped": 3
			},
			[keyOf("a.js", 2, 0)]: {
				"tests": ["f › y"],
				"noticed": [],
				"skipped": 0
			}
		}
	};

	assert.deepEqual(noticingOf(kept, ["f › x", "f › y"]), [
		{
			"id": "f › x",
			"tried": 2,
			"noticed": 1,
			"missed": ["a.js:2:1"]
		},
		{
			"id": "f › y",
			"tried": 2,
			"noticed": 0,
			"missed": ["a.js:1:1", "a.js:2:1"]
		}
	]);
});

test("what's kept holds while the code it was tried on hasn't changed", () => {
	const kept = {
		"file": "t.js",
		"at": "then",
		"digests": { "t.js": "1", "a.js": "2", "b.js": "3" },
		"tried": {
			"a.js:1:1": { "tests": [], "noticed": [], "skipped": 1 },
			"b.js:1:1": { "tests": [], "noticed": [], "skipped": 1 }
		}
	};

	assert.deepEqual(Object.keys(prunedOf(kept, "t.js", { "t.js": "1", "a.js": "2", "b.js": "changed" }).tried), ["a.js:1:1"]);
	assert.deepEqual(prunedOf(kept, "t.js", { "t.js": "changed", "a.js": "2", "b.js": "3" }).tried, {}, "the test file changed: all of it");
	assert.deepEqual(prunedOf(undefined, "t.js", {}).tried, {});
});

test("said in a line: every, some, none, and what's left", () => {
	assert.equal(saidOf({
		"file": "f",
		"statements": 10,
		"tried": 6,
		"left": 4,
		"none": ["f › c"],
		"tests": [
			{
				"id": "f › a",
				"tried": 6,
				"noticed": 6,
				"missed": []
			},
			{
				"id": "f › b",
				"tried": 6,
				"noticed": 2,
				"missed": []
			},
			{
				"id": "f › c",
				"tried": 3,
				"noticed": 0,
				"missed": []
			}
		]
	}), "6 of the 10 statements its tests run skipped, each in turn: 1 test noticed every one, 1 some, 1 none (in Problems, for you to decide). 4 left: run it again to try them.");
	assert.match(saidOf({
		"file": "f",
		"statements": 0,
		"tried": 0,
		"left": 0,
		"tests": [],
		"none": [],
		"failing": ["f › a"]
	}), /^Not checked: f › a doesn't pass/u);
});
