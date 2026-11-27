// What BABLR's worker keeps of a parse for placing annotations (workers/bablr-places.ts): a file's places, kept by its
// parser's version and blob, so the second time a version is placed — another keep, another What Nothing Ran…, a
// hover after a reload — is a read, not seconds of parsing.
//
//   node --import tsx --test test/bablr-places.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { logger, sinks } from "@brianjenkins94/util/logger";

const { blobOid, pack, placer, placesOf, shapesOf, unpack } = await import("../workers/bablr-places.ts");
const { cstSpansAsync, spanAnchors } = await import("@brianjenkins94/bablr");

const SOURCE = "export function add(left: number, right: number) {\n\treturn left + right;\n}\n";

function closes() {
	const seen = [];
	const sink = (record) => {
		if (record.kind === "span-close" && record.span === "editor.workers.bablr-places.place") {
			seen.push(record.attrs);
		}
	};

	sinks.splice(0, sinks.length, sink);

	return seen;
}

function memory() {
	const kept = new Map();

	return {
		"kept": kept,
		"store": {
			"get": async (key) => kept.get(key),
			"put": async (key, bytes) => { kept.set(key, bytes); }
		}
	};
}

test("a file's places give the shapes its parse does: each span's atoms the code's tokens inside it", async () => {
	const cst = await cstSpansAsync(SOURCE, "Program", {});
	const places = placesOf(spanAnchors(SOURCE, "Program", cst), cst.spans);
	const shapes = shapesOf(places);
	const tokens = cst.spans.filter((span) => span.token && !span.trivia);

	assert.ok(shapes.length > 0);

	for (const shape of shapes) {
		assert.deepEqual(shape.atoms, tokens.filter((token) => token.start >= shape.start && token.end <= shape.end).toSorted((left, right) => left.start - right.start).map((token) => token.text ?? ""));
	}

	assert.deepEqual(await unpack(await pack(places)), places);
});

test("placed once, a version is a read after: in memory, then from what's kept, by another worker", async () => {
	const seen = closes();
	const { kept, store } = memory();
	let parses = 0;
	const place = async () => {
		parses += 1;

		return {
			"places": {
				"anchors": [
					{
						"type": "Identifier",
						"start": 0,
						"end": 3,
						"id": "a"
					}
				],
				"tokens": [
					[0, 3, "add"]
				]
			}
		};
	};

	const first = placer({
		"version": "v1",
		"kept": store,
		"place": place,
		"log": logger({})
	});
	const placed = await first(SOURCE, new AbortController().signal);

	assert.equal(placed.blob, await blobOid(SOURCE));
	assert.deepEqual(await first(SOURCE, new AbortController().signal), placed);
	assert.equal(parses, 1);
	assert.deepEqual([
		...kept.keys()
	], [`v1/${placed.blob}`]);

	const another = placer({
		"version": "v1",
		"kept": store,
		"place": place,
		"log": logger({})
	});

	assert.deepEqual(await another(SOURCE, new AbortController().signal), placed);
	assert.equal(parses, 1);
	assert.deepEqual(seen.map(({ cached }) => cached), [false, true]);

	const newer = placer({
		"version": "v2",
		"kept": store,
		"place": place,
		"log": logger({})
	});

	await newer(SOURCE, new AbortController().signal);
	assert.equal(parses, 2);
});

test("a file that can't be parsed is kept as that; a placing that's stopped isn't kept", async () => {
	const { kept, store } = memory();
	const unparsable = placer({
		"version": "v1",
		"kept": store,
		"place": async () => ({ "why": "no" }),
		"log": logger({})
	});

	assert.deepEqual(await unparsable(SOURCE, new AbortController().signal), { "why": "no", "blob": await blobOid(SOURCE) });
	assert.equal(kept.size, 1);

	const stopped = memory();
	const aborting = placer({
		"version": "v1",
		"kept": stopped.store,
		"place": async () => { throw new Error("aborted"); },
		"log": logger({})
	});

	await assert.rejects(aborting("other", new AbortController().signal), /aborted/u);
	assert.equal(stopped.kept.size, 0);
});
