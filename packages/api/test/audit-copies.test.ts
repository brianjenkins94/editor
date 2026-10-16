import type { Copy, Row } from "../src/audit-copies.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, copyKey, parseKey } from "../src/audit-copies.ts";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 16);
const row = (id: number, fields: Partial<Row> = {}): Row => ({ "id": id, "at": now - DAY, "event": "proxy_call", "user_id": "u1", "grant_id": "g1", "country": "US", "ip_hash": "h", "reason": "GitHub 200", "detail": "GET /user", "trace_id": "t", ...fields });
const copies = (...entries: [number, Copy][]): Map<number, Copy> => new Map(entries);

test("a copy's key carries its class's prefix and a sortable id, and parses back", () => {
	assert.equal(copyKey("proxy_call", 42), "routine/000000000042.json");
	assert.equal(copyKey("proxy_denied", 42, ".finished"), "suspicious/000000000042.finished.json");
	assert.deepEqual(parseKey("routine/000000000042.finished.json"), { "id": 42, "finished": true });
	assert.equal(parseKey("routine/42.json"), undefined);
});

test("rows matching their copies are matching; a call's reason may be finished with its bytes", () => {
	const verdict = compare([row(1), row(2, { "reason": "GitHub 200, 10 bytes" })], copies([1, { "row": row(1) }], [2, { "row": row(2), "finished": "GitHub 200, 10 bytes" }]), now);

	assert.deepEqual(verdict.findings, []);
	assert.equal(verdict.matching, 2);
});

test("an edit is found, field by field; a user id taken off by account deletion isn't one", () => {
	const verdict = compare([row(1, { "detail": "GET /repos/x/y" }), row(2, { "user_id": null })], copies([1, { "row": row(1) }], [2, { "row": row(2) }]), now);

	assert.deepEqual(verdict.findings, [{ "id": 1, "kind": "edited", "detail": "detail: \"GET /user\" → \"GET /repos/x/y\"" }]);
	assert.equal(verdict.anonymized, 1);
});

test("a row gone before its time is deleted; gone after it, expired — routine at 90 days, the rest at 365", () => {
	const verdict = compare([row(4)], copies(
		[1, { "row": row(1, { "at": now - 92 * DAY }) }],
		[2, { "row": row(2, { "at": now - 92 * DAY, "event": "proxy_denied" }) }],
		[3, { "row": row(3, { "at": now - 367 * DAY, "event": "proxy_denied" }) }],
		[4, { "row": row(4) }]
	), now);

	assert.deepEqual(verdict.findings.map((finding) => `${finding.kind} ${finding.id}`), ["deleted 2"]);
	assert.equal(verdict.expired, 2);
});

test("a row with no copy is not copied — unless it's from before copies began; an id with neither is missing", () => {
	const verdict = compare([row(1), row(2), row(5)], copies([2, { "row": row(2) }], [3, { "row": row(3) }]), now);

	assert.deepEqual(verdict.findings.map((finding) => `${finding.kind} ${finding.id}`), ["deleted 3", "missing 4", "not copied 5"]);
	assert.equal(verdict.before, 1);
});
