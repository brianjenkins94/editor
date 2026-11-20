/**
 * The top bar's Commit (shell/commit.tsx `commitAndPush`): the branch brought up to GitHub's first, then every change
 * committed and the branch pushed — each step the workbench's git over the hub, here a stand-in that answers as told and
 * keeps what it was asked. What it says, and what it doesn't do: nothing committed when GitHub changed a file changed here,
 * a merge after the commit when each moved on (and no push while its conflicts wait), no commit when nothing changed, the
 * commit kept and said when the push after it is refused.
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

test("when GitHub changed a file changed here, nothing is committed, and it says which", async () => {
	const conflicts = workbench({ "git.pull": { "ref": "main", "outcome": "conflicts", "conflicts": ["a.txt", "b.txt"] } });

	assert.equal((await commitAndPush(conflicts.rpc, "m", "someone/repo")).said, "GitHub changed files you've changed here, so it can't catch up: a.txt, b.txt");
	assert.deepEqual(conflicts.asked, ["git.pull"]);
});

test("each moved on: the changes committed, then GitHub's merged in, then pushed", async () => {
	const pulls = [{ "ref": "main", "outcome": "diverged" }, { "ref": "main", "outcome": "merged", "files": ["x"] }];
	const { rpc, asked } = workbench({ "git.pull": () => pulls.shift(), "git.status": { "files": [] }, "git.commit": { "oid": "abcdef0123" }, "git.push": pushed });

	assert.deepEqual(await commitAndPush(rpc, "m", "someone/repo"), { "said": "Merged GitHub (1 files). Committed abcdef0 and pushed main", "failed": false, "made": "abcdef0" });
	assert.deepEqual(asked, ["git.pull", "git.commit", "git.pull", "git.status", "git.push"]);
});

test("a merge with conflicts: committed here, not pushed, and which files to settle", async () => {
	const pulls = [{ "ref": "main", "outcome": "diverged" }, { "ref": "main", "outcome": "merge conflicts", "conflicts": ["a.txt"] }];
	const { rpc, asked } = workbench({ "git.pull": () => pulls.shift(), "git.commit": { "oid": "abcdef0123" } });
	const outcome = await commitAndPush(rpc, "m", "someone/repo");

	assert.equal(outcome.failed, true);
	assert.match(outcome.said, /^Committed abcdef0, but not pushed: GitHub and this workspace changed the same lines of a\.txt: both are marked in the file\. Settle them and commit again/u);
	assert.equal(asked.includes("git.push"), false);
});

test("a push refused after the commit: the commit's kept and said, with GitHub's reason", async () => {
	const refused = workbench({ "git.pull": { "ref": "main", "outcome": "up to date" }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": { "oid": "feedface00" }, "git.push": { "ref": "main", "ok": false, "error": "protected branch" } });
	const failed = workbench({ "git.pull": { "ref": "main", "outcome": "up to date" }, "git.status": { "files": [{ "path": "a.txt" }] }, "git.commit": { "oid": "feedface00" }, "git.push": () => { throw new Error("pushing needs you signed in with GitHub"); } });

	assert.deepEqual(await commitAndPush(refused.rpc, "m", "someone/repo"), { "said": "Committed feedfac, but not pushed: GitHub refused the push to main: protected branch", "failed": true, "made": "feedfac" });
	assert.equal((await commitAndPush(failed.rpc, "m", "someone/repo")).said, "Committed feedfac, but not pushed: pushing needs you signed in with GitHub");
});
