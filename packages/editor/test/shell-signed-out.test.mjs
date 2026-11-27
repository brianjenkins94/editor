// What the shell does with GitHub and the editor's API signed out (shell/git-push.ts `remote`, shell/github.ts
// `connectGitHub` and `actions`, shell/session.ts `reportError`): a push is refused, with why; CI's runs come from
// GitHub's public API; an error report is posted and its id handed back, or nothing when it can't be.
//
//   node --import tsx --test test/shell-signed-out.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

/** What the page's fetch is asked (stood in for before the modules load): each call, answered by `answer`. */
const asked = [];
let answer = async () => new Response(null, { "status": 500 });

globalThis.fetch = async (input, init = {}) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

	asked.push({ "url": url, "method": (init.method ?? "GET").toUpperCase(), "body": typeof init.body === "string" ? init.body : undefined });

	return answer(url, init);
};

const { remote } = await import("../shell/git-push.ts");
const { actions } = await import("../shell/github.ts");
const { API, reportError } = await import("../shell/session.ts");

const json = (value, status = 200) => new Response(JSON.stringify(value), { "status": status, "headers": { "content-type": "application/json" } });

test("a push goes to a github.com repository, and only signed in", async () => {
	await assert.rejects(remote({ "url": "https://gitlab.com/a/b.git/info/refs", "method": "GET", "headers": {} }), /a push goes to a github\.com repository, not https:\/\/gitlab\.com/u);
	await assert.rejects(remote({ "url": "https://github.com/a/b.git/info/refs", "method": "GET", "headers": {} }), /pushing needs you signed in with GitHub/u);
});

test("CI's runs, signed out: from GitHub's public API, said as signed out; a repository not owner/repo is refused", async () => {
	asked.length = 0;
	answer = async (url) => (url.includes("/repos/ann/app/actions/runs") ? json({ "total_count": 1, "workflow_runs": [{ "id": 7, "conclusion": "success" }] }) : json({ "message": "no" }, 404));

	const runs = await actions({ "repository": "ann/app", "branch": "main", "limit": 3 });

	assert.equal(runs.signedIn, false);
	assert.deepEqual(runs.workflow_runs, [{ "id": 7, "conclusion": "success" }]);

	const call = asked.find(({ url }) => url.includes("/actions/runs"));

	assert.ok(call.url.startsWith("https://api.github.com/repos/ann/app/actions/runs"), call.url);
	assert.match(call.url, /branch=main/u);
	assert.match(call.url, /per_page=3/u);
	await assert.rejects(actions({ "repository": "ann" }), TypeError);
	await assert.rejects(actions({ "repository": "a/b/c" }), TypeError);
});

test("an error report is posted to the API, and its id handed back; none when the API can't take it", async () => {
	asked.length = 0;
	answer = async () => json({ "id": "E-TEST-0001" });

	const report = { "name": "TypeError", "message": "boom", "source": "shell", "release": "test", "breadcrumbs": ["opened"] };

	assert.equal(await reportError(report), "E-TEST-0001");
	assert.deepEqual([asked[0].url, asked[0].method, JSON.parse(asked[0].body).message], [`${API}/errors`, "POST", "boom"]);

	answer = async () => json({}, 503);
	assert.equal(await reportError(report), undefined, "a refused report");

	answer = async () => {
		throw new TypeError("offline");
	};
	assert.equal(await reportError(report), undefined, "and one that never reached it");
});
