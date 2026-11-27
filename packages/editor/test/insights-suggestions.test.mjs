// What runs say could go (extensions/insights/suggestions.ts): from evidence placed in a file's text, each suggestion,
// how sure it is, and the edit that removes it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { armsOf, bound, strength, suggestions, topLevelOperators } from "../extensions/insights/suggestions.ts";

const source = `function shipping(order) {
	const country = order.address?.country ?? "US";

	if (country === "US") {
		return 5;
	} else if (country === "CA") {
		return 8;
	}

	return 20;
}

function discount(order) {
	return order.coupon ? 0.1 : 0;
}
`;

/** Evidence on the span whose text is `text` (its `nth` occurrence). */
function at(text, evidence, type, nth = 0) {
	let start = -1;

	for (let index = 0; index <= nth; index += 1) {
		start = source.indexOf(text, start + 1);
	}

	assert.notEqual(start, -1, text);

	return {
		"start": start,
		"end": start + text.length,
		...type === undefined
			? {}
			: { "type": type },
		"evidence": evidence
	};
}

const runs = { "ever": 4, "runs": 4, "lastAt": "2026-10-05T00:00:00Z" };
const placed = [
	at("order.address?.country", {
		"value": {
			"seen": 12,
			"nullish": 0,
			"tags": { "object": 12 },
			...runs
		}
	}, "MemberExpression"),
	at(`order.address?.country ?? "US"`, {
		"value": {
			"seen": 12,
			"nullish": 0,
			"tags": { "string": 12 },
			...runs
		}
	}, "BinaryExpression"),
	at("order.coupon ? 0.1 : 0", {
		"branch": {
			"arms": [0, 12],
			...runs
		}
	}, "TernaryExpression"),
	at(`if (country === "CA") {\n\t\treturn 8;\n\t}`, {
		"branch": {
			"arms": [4, 0],
			...runs
		}
	}, "If"),
	at("return 20;", {
		"reached": { "ever": 0, "runs": 4, "lastAt": runs.lastAt }
	}),
	at("return 5;", {
		"reached": { "ever": 4, "runs": 4, "lastAt": runs.lastAt }
	})
];

/** `text` with `fix` applied. */
const apply = (fix) => source.slice(0, fix.start) + fix.text + source.slice(fix.end);

test("never isn't proof: how rare it could still be, and how strongly to say so", () => {
	assert.equal(bound(5), "too few tries yet to say how rare", "3 in 5 is no bound");
	assert.equal(bound(6), "at most 1 in 2, 95% sure");
	assert.equal(bound(12), "at most 1 in 4, 95% sure");
	assert.equal(bound(3000), "at most 1 in 1,000, 95% sure");
	assert.deepEqual([
		strength(12),
		strength(30),
		strength(300)
	], [0, 1, 2]);
});

test("a branch's arms, in its text", () => {
	const ternary = "a?.b ? x ?? y : (c ? 1 : 2)";
	const { arms, "test": condition } = armsOf(ternary, "TernaryExpression");

	assert.deepEqual(arms.map((arm) => ternary.slice(...arm)), ["x ?? y", "(c ? 1 : 2)"]);
	assert.equal(ternary.slice(...condition), "a?.b");

	const branch = "if (a) {\n\tone();\n} else {\n\ttwo();\n}";

	assert.deepEqual(armsOf(branch, "If").arms.map((arm) => branch.slice(...arm)), ["{\n\tone();\n}", "{\n\ttwo();\n}"]);
	assert.equal(armsOf("if (a) b();", "If").arms[1], undefined, "no else: no code");
	assert.deepEqual(topLevelOperators("a?.b ?? f(c?.d)"), {
		"optional": [1],
		"nullish": [5]
	});
});

test("what could go: each, marked, sure as its tries, with the edit that removes it", () => {
	const found = suggestions(source, placed, 3, 10);
	const byCode = (code) => found.filter((suggestion) => suggestion.code === code);

	const [optional] = byCode("unneeded-optional-chain");

	assert.equal(source.slice(optional.start, optional.end), "?.");
	assert.equal(optional.style, "underline");
	assert.match(optional.message, /12 values in 4 runs .* nullish at most 1 in 4, 95% sure/u);
	assert.match(apply(optional.fix), /order\.address\.country \?\?/u);

	const [nullish] = byCode("unneeded-nullish-coalescing");

	assert.equal(source.slice(nullish.start, nullish.end), `?? "US"`);
	assert.match(apply(nullish.fix), /const country = order\.address\?\.country;/u);

	// The ?: never true: its true arm tinted, the whole replaced by its false.
	const [ternary] = byCode("branch-never-taken");

	assert.equal(source.slice(ternary.start, ternary.end), "0.1");
	assert.equal(ternary.style, "tint");
	assert.match(apply(ternary.fix), /return 0;/u);

	// `if (country === "CA")` ran 4 times, below 10 tries: no suggestion. Nor for `return 5`, which ran.
	assert.equal(byCode("branch-never-taken").length, 1);

	// return 20 never ran, in 4 runs: tinted, its line removed by the fix.
	const [unreached] = byCode("never-reached");

	assert.equal(source.slice(unreached.start, unreached.end), "return 20;");
	assert.match(unreached.message, /not once in 4 runs since this code last changed — too few tries yet to say how rare/u);
	assert.doesNotMatch(apply(unreached.fix), /return 20/u);
	assert.ok(apply(unreached.fix).includes("\t}\n\n}\n"), "the line, not a blank in it");
	assert.equal(found.length, 4);
	assert.deepEqual(found.map((suggestion) => `${suggestion.label} — ${suggestion.evidence}`), [
		"?. never nullish — 12 values in 4 runs · at most 1 in 4",
		"?? right side never ran — 12 values in 4 runs · at most 1 in 4",
		"?:'s true never ran — 12 times in 4 runs · at most 1 in 4",
		"never ran — 4 runs · too few tries yet to say how rare"
	], "each short, for a list's row");
});

test("an if never taken: its then tinted, and the fix keeps the else, unwrapped", () => {
	const text = "function f(x) {\n\tif (x) {\n\t\tone();\n\t} else {\n\t\ttwo();\n\t\tthree();\n\t}\n}\n";
	const start = text.indexOf("if (x)");
	const end = text.indexOf("\t}\n}") + 2;
	const [suggestion] = suggestions(text, [
		{
			"start": start,
			"end": end,
			"type": "If",
			"evidence": {
				"branch": {
					"arms": [0, 40],
					...runs
				}
			}
		}
	], 3, 10);

	assert.equal(text.slice(suggestion.start, suggestion.end), "{\n\t\tone();\n\t}");
	assert.equal(suggestion.strength, 1, "40 tries: the middle strength");
	assert.equal(text.slice(0, suggestion.fix.start) + suggestion.fix.text + text.slice(suggestion.fix.end), "function f(x) {\n\ttwo();\n\tthree();\n}\n");
});

test("a statement inside an arm already marked isn't marked again", () => {
	const text = "if (x) {\n\tone();\n}\n";
	const found = suggestions(text, [
		{
			"start": 0,
			"end": text.length - 1,
			"type": "If",
			"evidence": {
				"branch": {
					"arms": [0, 10],
					...runs
				}
			}
		},
		{
			"start": text.indexOf("one();"),
			"end": text.indexOf("one();") + 6,
			"evidence": {
				"reached": { "ever": 0, "runs": 4, "lastAt": runs.lastAt }
			}
		}
	], 3, 10);

	assert.deepEqual(found.map((suggestion) => suggestion.code), ["branch-never-taken"]);
	assert.equal(found[0].fix.text, "", "no else: the if goes");
});

test("on someone else's committed lines, only what's claimed: a fix needs a claim, and nothing anywhere against it", () => {
	const committed = { "ever": 30, "runs": 30, "lastAt": "", "coarse": true };
	const optional = (value) => suggestions(source, [at("order.address?.country", { "value": { "seen": 30, "nullish": 0, "tags": { "object": 30 }, ...committed, ...value } }, "MemberExpression")], 3, 10);
	const branch = (evidence) => suggestions(source, [at("order.coupon ? 0.1 : 0", { "branch": { "arms": [0, 1], ...committed, ...evidence } }, "TernaryExpression")], 3, 10);
	const unreached = (evidence) => suggestions(source, [at("return 20;", { "reached": { "ever": 0, "runs": 30, "lastAt": "", "coarse": true, ...evidence } })], 3, 10);

	assert.deepEqual(optional({}), [], "30+ runs never nullish, unclaimed: no fix");
	assert.deepEqual(branch({}), []);
	assert.deepEqual(unreached({}), []);

	const [claimed] = optional({ "claimed": true });

	assert.equal(claimed.code, "unneeded-optional-chain");
	assert.equal(claimed.fix.title, "Remove the `?.` (never nullish in 30+ runs)");
	assert.match(claimed.message, /claimed in a commit/u);
	assert.equal(claimed.evidence, "30+ runs · claimed");
	assert.equal(branch({ "claimed": true })[0].code, "branch-never-taken");
	assert.match(branch({ "claimed": true })[0].message, /every time the false in 30\+ runs, claimed/u);
	assert.equal(unreached({ "claimed": true })[0].fix.title, "Remove it (never ran in 30+ runs)");

	assert.deepEqual(optional({ "claimed": true, "nullish": 1 }), [], "claimed by one, nullish in another's line: no fix");
	assert.deepEqual(branch({ "claimed": true, "arms": [1, 1] }), [], "the other arm taken in another's line: no fix");
	assert.deepEqual(unreached({ "claimed": true, "ever": 3 }), [], "ran in another's line: no fix");
});
