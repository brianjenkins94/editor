/**
 * Our `expect` on a value, as Playwright's: each matcher, and `.not`; `toEqual` over what a value holds — arrays, maps,
 * sets, dates, nested objects — leaving out properties that are undefined and what class it is, and `toStrictEqual`
 * keeping both; a failure says what was expected of what. No browser: a locator's assertions are engine.test.mjs's.
 *
 *   node --test packages/playwright/test/expect.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { expect } = await import("../src/expect.ts");

const fails = (check, message) => assert.throws(check, (error) => error.name === "AssertionError" && (message === undefined || message.test(error.message)));

test("each matcher on a value, and its .not", () => {
	expect(2).toBe(2);
	expect(Number.NaN).toBe(Number.NaN);
	fails(() => expect({}).toBe({}));
	expect("x").toBeTruthy();
	expect(0).toBeFalsy();
	expect(0).toBeDefined();
	expect(undefined).toBeUndefined();
	expect(null).toBeNull();
	expect("a needle here").toContain("needle");
	expect([1, 2, 3]).toContain(2);
	fails(() => expect([{ "a": 1 }]).toContain({ "a": 1 }), /toContain/u);
	expect([1, 2]).toHaveLength(2);
	expect("abc").toHaveLength(3);
	expect("total 20").toMatch(/\d+$/u);
	expect("total 20").toMatch("tal 2");
	expect(3).toBeGreaterThan(2);
	expect(3).toBeGreaterThanOrEqual(3);
	expect(2).toBeLessThan(3);
	expect(3).toBeLessThanOrEqual(3);

	expect(2).not.toBe(3);
	expect("").not.toBeTruthy();
	expect([1]).not.toContain(2);
	fails(() => expect(3).not.toBeGreaterThan(2), /^expect\(3\)\.not\.toBeGreaterThan\(2\) failed$/u);
});

test("toEqual: what it holds, at any depth — undefined properties and classes aside", () => {
	expect({ "a": [1, { "b": "c" }], "d": new Date(0) }).toEqual({ "a": [1, { "b": "c" }], "d": new Date(0) });
	fails(() => expect({ "a": [1, 2] }).toEqual({ "a": [1, 3] }), /toEqual/u);
	expect(new Map([["k", { "v": 1 }]])).toEqual(new Map([["k", { "v": 1 }]]));
	fails(() => expect(new Map([["k", 1]])).toEqual(new Map()), /toEqual/u);
	fails(() => expect(new Map([["k", 1]])).toEqual(new Map([["k", 2]])));
	expect(new Set([1, { "x": 2 }])).toEqual(new Set([{ "x": 2 }, 1]));
	fails(() => expect(new Set([1])).toEqual(new Set([2])));
	fails(() => expect([1, 2]).toEqual({ "0": 1, "1": 2 }), undefined);
	fails(() => expect(new Date(0)).toEqual(new Date(1)));
	expect(/a/gu).toEqual(/a/gu);

	expect({ "a": 1, "b": undefined }).toEqual({ "a": 1 });

	class Point {
		x = 1;
	}

	expect(new Point()).toEqual({ "x": 1 });
});

test("toStrictEqual: undefined properties and classes count", () => {
	expect({ "a": [1, new Map([["k", 2]])] }).toStrictEqual({ "a": [1, new Map([["k", 2]])] });
	fails(() => expect({ "a": 1, "b": undefined }).toStrictEqual({ "a": 1 }), /toStrictEqual/u);

	class Point {
		x = 1;
	}

	fails(() => expect(new Point()).toStrictEqual({ "x": 1 }));
	expect(new Point()).toStrictEqual(new Point());
});
