/**
 * The tripwire's watched D1 binding (src/tripwire.ts): another user's row trips it (or, before enforcing, is reported),
 * and the canary trips it always — over a stand-in D1 of fixed rows, so it runs anywhere, in the editor's debugger too.
 * tripwire.test.ts tests the cron and the live API in workerd.
 */
import type { Watch } from "../src/tripwire.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { Breach, crossUser, watched } from "../src/tripwire.ts";

function standInDb(rows: Record<string, unknown>[]): D1Database {
	const statement = (): D1PreparedStatement => ({
		"bind": () => statement(),
		"first": async () => rows[0] ?? null,
		"all": async () => ({ "results": rows, "success": true, "meta": {} }),
		"raw": async () => rows.map((row) => Object.values(row)),
		"run": async () => ({ "results": [], "success": true, "meta": {} })
	}) as unknown as D1PreparedStatement;

	return { "prepare": () => statement(), "batch": async (statements: D1PreparedStatement[]) => Promise.all(statements.map(async (one) => one.all())) } as unknown as D1Database;
}

const watch = (enforce: boolean): Watch => ({ "user": "me", "raw": standInDb([]), "canary": new Set(["the-canary"]), "enforce": enforce, "reports": [] });

test("the watched binding: another user's row trips (or, before enforcing, is reported); one's own rows don't; crossUser is unwatched", async () => {
	const mine = watched(standInDb([{ "user_id": "me", "id": "a" }]), watch(true));

	assert.deepEqual(await mine.prepare("SELECT id, user_id FROM grants WHERE user_id = ?").bind("me").first(), { "user_id": "me", "id": "a" });

	const theirs = standInDb([{ "user_id": "someone else", "id": "b" }]);
	const enforcing = watch(true);

	await assert.rejects(watched(theirs, enforcing).prepare("SELECT id, user_id FROM grants").all(), Breach);
	assert.equal(enforcing.breach?.kind, "another user's row");

	const reporting = watch(false);

	assert.equal((await watched(theirs, reporting).prepare("SELECT id, user_id FROM grants").all()).results.length, 1, "reported, not refused");
	assert.equal(reporting.reports[0]?.other, "someone else");
	assert.equal((await crossUser(watched(theirs, watch(true)), "a test").prepare("SELECT user_id FROM identities").first<{ "user_id": string }>())?.user_id, "someone else", "on purpose: unwatched");
});

test("the canary trips even before enforcing, in a value of any column, in a batch and in raw rows", async () => {
	const canary = standInDb([{ "subject": "the-canary" }]);

	for (const read of [
		async (db: D1Database) => db.prepare("SELECT subject FROM identities").first(),
		async (db: D1Database) => db.batch([db.prepare("SELECT subject FROM identities")]),
		async (db: D1Database) => db.prepare("SELECT subject FROM identities").raw()
	]) {
		const state = watch(false);

		await assert.rejects(read(watched(canary, state)), Breach);
		assert.equal(state.breach?.kind, "canary");
	}
});
