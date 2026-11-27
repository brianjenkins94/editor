// BABLR's parses as the editor keeps them (workers/bablr-parses.ts): one store for every BABLR request — annotations'
// places, the cosmetic verdict, edit groups, a file's comments, whether it parses — kept by the parser's version and the
// text's blob, so a version parsed once is read after, by any feature, without knowing it's kept.
//
//   node --import tsx --test test/bablr-parses.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { logger, sinks } from "@brianjenkins94/util/logger";

const { blobOid, pack, parseOf, parser, shapesOf, spansOf, unpack } = await import("../workers/bablr-parses.ts");
// (BABLR's source, as its own tests run it: its bundle, dist/, is built for the editor, not before the unit tests)
const { atomsOf, cstSpansAsync, deriveIdentityAsync, editGroups, spanAnchors } = await import("../../bablr/src/index.js");

const HEAD = "export function add(left: number, right: number) {\n\t// the sum\n\treturn left + right;\n}\n";
const REINDENTED = "export function add(left: number, right: number) {\n    // the sum\n    return left + right;\n}\n";
const CHANGED = "export function add(left: number, right: number) {\n\t// the sum\n\treturn left - right;\n}\n";

async function kept(source) {
	const cst = await cstSpansAsync(source, "Program", {});

	return {
		"cst": cst,
		"parse": parseOf(spanAnchors(source, "Program", cst), cst.spans)
	};
}

test("a kept parse gives what the parse does: shapes, the diff's atoms, the comments", async () => {
	const { cst, parse } = await kept(HEAD);
	const tokens = cst.spans.filter((span) => span.token && !span.trivia);

	for (const shape of shapesOf(parse)) {
		assert.deepEqual(shape.atoms, tokens.filter((token) => token.start >= shape.start && token.end <= shape.end).toSorted((left, right) => left.start - right.start).map((token) => token.text ?? ""));
	}

	assert.deepEqual(atomsOf(spansOf(parse)), atomsOf(cst));
	assert.deepEqual(parse.comments.map((at) => HEAD.slice(at, at + 2)), ["//", "\n\t"]);
	assert.deepEqual(await unpack(await pack(parse)), parse);
});

test("the cosmetic verdict and edit groups from kept parses are the parse's own", async () => {
	const parses = new Map(await Promise.all([HEAD, REINDENTED, CHANGED].map(async (text) => [
		text,
		spansOf((await kept(text)).parse)
	])));
	const fromKept = {
		"parse": async (text) => parses.get(text)
	};

	for (const working of [REINDENTED, CHANGED]) {
		const parsed = await deriveIdentityAsync([HEAD, working]);
		const read = await deriveIdentityAsync([HEAD, working], fromKept);

		assert.deepEqual([read.verdict, read.changedNodeIds, read.changedLines], [parsed.verdict, parsed.changedNodeIds, parsed.changedLines]);
	}

	assert.deepEqual(await editGroups([HEAD, CHANGED], fromKept), await editGroups([HEAD, CHANGED]));
});

function closes() {
	const seen = [];

	sinks.splice(0, sinks.length, (record) => {
		if (record.kind === "span-close" && record.span === "editor.workers.bablr-parses.parse") {
			seen.push(record.attrs);
		}
	});

	return seen;
}

function memory() {
	const store = new Map();

	return {
		"store": store,
		"kept": {
			"get": async (key) => store.get(key),
			"put": async (key, bytes) => {
				store.set(key, bytes);
			}
		}
	};
}

test("parsed once, a version is read after: in memory, then from what's kept, by another worker", async () => {
	const seen = closes();
	const { store, "kept": into } = memory();
	let parses = 0;
	const parse = async () => {
		parses += 1;

		return {
			"nodes": [
				{
					"type": "Identifier",
					"start": 0,
					"end": 3,
					"id": "a",
					"text": "add"
				}
			],
			"comments": []
		};
	};

	const first = parser({
		"version": "v1",
		"kept": into,
		"parse": parse,
		"log": logger({})
	});
	const parsed = await first(HEAD, new AbortController().signal);

	assert.equal(parsed.blob, await blobOid(HEAD));
	assert.deepEqual(await first(HEAD, new AbortController().signal), parsed);
	assert.equal(parses, 1);
	assert.deepEqual([
		...store.keys()
	], [`v1/${parsed.blob}`]);

	const another = parser({
		"version": "v1",
		"kept": into,
		"parse": parse,
		"log": logger({})
	});

	assert.deepEqual(await another(HEAD, new AbortController().signal), parsed);
	assert.equal(parses, 1);
	assert.deepEqual(seen.map(({ cached }) => cached), [false, true]);

	await parser({
		"version": "v2",
		"kept": into,
		"parse": parse,
		"log": logger({})
	})(HEAD, new AbortController().signal);
	assert.equal(parses, 2);
});

test("a text that can't be parsed is kept as that; a parse that's stopped isn't kept", async () => {
	const { store, "kept": into } = memory();
	const unparsable = parser({
		"version": "v1",
		"kept": into,
		"parse": async () => ({ "why": "no" }),
		"log": logger({})
	});

	assert.deepEqual(await unparsable(HEAD, new AbortController().signal), { "why": "no", "blob": await blobOid(HEAD) });
	assert.equal(store.size, 1);

	const stopped = memory();
	const aborting = parser({
		"version": "v1",
		"kept": stopped.kept,
		"parse": async () => {
			throw new Error("aborted");
		},
		"log": logger({})
	});

	await assert.rejects(aborting("other", new AbortController().signal), /aborted/u);
	assert.equal(stopped.store.size, 0);
});
