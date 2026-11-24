/**
 * A file's notes as an agent reads them: beside their lines in `files.read`, among its whys in `decisions.for`.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/notes-read.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("notes-read");
const { ask } = session;

test("a file's notes, read as the Margin shows them: beside its lines in files_read, among its whys in decisions_for", async () => {
	await ask("files.write", { "path": "tools/noted.mjs", "content": "const rate = 2;\nconst total = rate * 10;\n" });
	assert.deepEqual(await session.request("notes.add", { "path": "tools/noted.mjs", "at": "const total = rate * 10;", "text": "ten of them" }, 60_000), { "path": "tools/noted.mjs", "line": 2 });

	const read = await session.eventually("the note beside its line", async () => {
		const answer = await ask("files.read", { "path": "tools/noted.mjs" });

		return answer.notes?.length === 1 ? answer : undefined;
	}, 60_000);

	assert.deepEqual(read.notes.map(({ line, text }) => [line, text]), [[2, "ten of them"]]);
	// (lines it wasn't asked for, no note)
	assert.equal((await ask("files.read", { "path": "tools/noted.mjs", "limit": 1 })).notes, undefined);
	assert.deepEqual((await ask("decisions.for", { "target": "tools/noted.mjs" })).notes?.map(({ line, text }) => [line, text]), [[2, "ten of them"]]);
	// (an edit that takes a note's code out says so: an orphan, as Problems tells a person)
	assert.deepEqual((await ask("files.edit", { "path": "tools/noted.mjs", "old": "const total = rate * 10;\n", "new": "" })).orphaned?.map(({ path, text }) => [path, text]), [["tools/noted.mjs", "ten of them"]]);
	// (a file with none says nothing of notes)
	await ask("files.write", { "path": "tools/plain.mjs", "content": "const plain = 1;\n" });
	assert.equal((await ask("files.read", { "path": "tools/plain.mjs" })).notes, undefined);
});
