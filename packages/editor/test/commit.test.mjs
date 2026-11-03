/**
 * The top bar's Commit (shell/commit.tsx `commitAndPush`): the branch brought up to GitHub's first, then every change
 * committed and the branch pushed — each step the workbench's git over the hub, here a stand-in that answers as told and
 * keeps what it was asked. What it says, and what it doesn't do: nothing committed when it can't catch up, no commit when
 * nothing changed, the commit kept and said when the push after it is refused.
 *
 *   node --import tsx --test test/commit.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { commitAndPush } = await import("../shell/commit.tsx");

/** An rpc answering each request as `answers` says (a value, or a function of the request's arguments), and the
 *  requests it was asked, in order. */
function workbench(answers) {
	const asked = [];

	return {
		"asked": asked,
		"rpc": {
			"request": async (subject, args) => {
				asked.push(subject);

				const answer = answers[subject];

				if (answer === undefined) {
					throw new Error(`nothing answers ${subject}`);
				}

				return typeof answer === "function" ? answer(args) : answer;
			}
		}
	};
}

const pushed = { "ref": "main", "ok": true };

test("changes committed and pushed, up to date with GitHub first", async () => {
	const { rpc, asked } = workbench({ "git.pull": { "ref": "main", "outcome": "up to date" }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": ({ message }) => ({ "oid": message === "the message" ? "abcdef0123456789" : "wrong" }), "git.push": pushed });

	assert.deepEqual(await commitAndPush(rpc, "the message", "someone/repo"), { "said": "Committed abcdef0 and pushed main", "failed": false, "made": "abcdef0" });
	assert.deepEqual(asked, ["git.pull", "git.status", "git.commit", "git.push"]);
});

test("caught up with GitHub first, it says so", async () => {
	const { rpc } = workbench({ "git.pull": { "ref": "main", "outcome": "fast-forwarded", "files": ["x", "y"] }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": { "oid": "1234567890" }, "git.push": pushed });

	assert.equal((await commitAndPush(rpc, "m", "someone/repo")).said, "Caught up with GitHub (2 files). Committed 1234567 and pushed main");
});

test("nothing changed — or only .silo's own seeds — pushes what's committed, committing nothing", async () => {
	const { rpc, asked } = workbench({ "git.pull": { "ref": "main", "outcome": "ahead" }, "git.status": { "files": [{ "path": ".silo/.gitignore" }, { "path": ".silo/.gitattributes" }] }, "git.push": pushed });

	assert.deepEqual(await commitAndPush(rpc, "m", "someone/repo"), { "said": "Nothing to commit: pushed main", "failed": false });
	assert.equal(asked.includes("git.commit"), false);
});

test("when it can't catch up — the two moved on, or a file changed on both — nothing is committed, and it says why", async () => {
	const diverged = workbench({ "git.pull": { "ref": "main", "outcome": "diverged" } });
	const conflicts = workbench({ "git.pull": { "ref": "main", "outcome": "conflicts", "conflicts": ["a.txt", "b.txt"] } });

	assert.match((await commitAndPush(diverged.rpc, "m", "someone/repo")).said, /each moved on.*rebase or a merge/u);
	assert.equal((await commitAndPush(conflicts.rpc, "m", "someone/repo")).said, "GitHub changed files you've changed here, so it can't catch up: a.txt, b.txt");
	assert.deepEqual([diverged.asked, conflicts.asked], [["git.pull"], ["git.pull"]]);
});

test("a push refused after the commit: the commit's kept and said, with GitHub's reason", async () => {
	const refused = workbench({ "git.pull": { "ref": "main", "outcome": "up to date" }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": { "oid": "feedface00" }, "git.push": { "ref": "main", "ok": false, "error": "protected branch" } });
	const failed = workbench({ "git.pull": { "ref": "main", "outcome": "up to date" }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": { "oid": "feedface00" }, "git.push": () => { throw new Error("pushing needs you signed in with GitHub"); } });

	assert.deepEqual(await commitAndPush(refused.rpc, "m", "someone/repo"), { "said": "Committed feedfac, but not pushed: GitHub refused the push to main: protected branch", "failed": true, "made": "feedfac" });
	assert.equal((await commitAndPush(failed.rpc, "m", "someone/repo")).said, "Committed feedfac, but not pushed: pushing needs you signed in with GitHub");
});
