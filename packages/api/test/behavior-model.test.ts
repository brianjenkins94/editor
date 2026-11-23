/**
 * The behavior model's pure parts (src/behavior.ts): a proxied call's template, how a difference in a browser's
 * signals is weighed, an action's name, the editor's flows, and the surprise of a step. Pure, so it runs anywhere — in
 * the editor's debugger too; behavior.test.ts tests the probes and the model's keeping in workerd.
 */
import type { Model } from "../src/behavior.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { actionOf, differences, FLOWS, proxied, surprisal } from "../src/behavior.ts";

test("a proxied call is its template: the query's names kept, every value left for the hash", () => {
	assert.deepEqual(proxied("api", "GET", "/repos/octo/hello/git/trees/main", "?recursive=1"), { "template": "GET /repos/:owner/:repo/git/trees/:ref?recursive", "repository": "octo/hello", "rest": "main\n?recursive=1" });
	assert.deepEqual(proxied("api", "GET", "/user", ""), { "template": "GET /user", "rest": "" });
	assert.equal(proxied("api", "DELETE", "/repos/octo/hello", ""), undefined, "a method the editor doesn't use");
	assert.equal(proxied("api", "GET", "/repos/octo/hello/git/trees/heads/../../secret", ""), undefined, "a ref can't climb");
	assert.deepEqual(proxied("git", "GET", "/octo/hello.git/info/refs", "?service=git-receive-pack"), { "template": "GET /:owner/:repo.git/info/refs?service", "repository": "octo/hello", "rest": "?service=git-receive-pack" }, "a push's, the same template as a clone's");
	assert.equal(proxied("git", "GET", "/octo/hello.git/info/refs", "?service=git-upload-archive"), undefined, "no other service");
});

test("weighing a difference: what a browser update or a new release does is tolerated; a browser becoming something else is strong", () => {
	const known = { "origin": "o", "sec-fetch-mode": "m", "user-agent": "u141", "accept-language": "en", "browser": "Chrome", "major": "141", "os": "macOS" };
	const weigh = (now: Record<string, string | null>): string[] => differences(known, { ...known, ...now }).map((difference) => `${difference.strength}: ${difference.name} ${difference.kind}`);

	assert.deepEqual(weigh({ "sec-ch-ua": "new" }), ["tolerated: sec-ch-ua added"]);
	assert.deepEqual(weigh({ "user-agent": "u142", "major": "142" }), ["tolerated: user-agent changed", "tolerated: major changed"]);
	assert.deepEqual(weigh({ "origin": null }), ["strong: origin omitted"]);
	assert.deepEqual(weigh({ "user-agent": "u140", "major": "140" }), ["medium: user-agent changed", "strong: major changed"]);
	assert.deepEqual(weigh({ "browser": "Firefox" }), ["strong: browser changed"]);
	assert.deepEqual(weigh({ "accept-language": "de" }), ["medium: accept-language changed"]);
});

test("an action is its route's template, the proxy's template, or no route at all", () => {
	assert.equal(actionOf("GET", new URL("https://api.test/github/api/repos/octo/hello/git/trees/main?recursive=1"), "/github/api/*"), "GET /github/api/repos/:owner/:repo/git/trees/:ref?recursive");
	assert.equal(actionOf("DELETE", new URL("https://api.test/github/api/repos/octo/hello"), "/github/api/*"), "DELETE /github/api/… (refused)");
	assert.equal(actionOf("POST", new URL("https://api.test/sessions/abc/revoke"), "/sessions/:id/revoke"), "POST /sessions/:id/revoke");
	assert.equal(actionOf("GET", new URL("https://api.test/wp-admin"), "/*"), "GET (no such route)");
});

test("the editor's flows name only calls the proxy allows", () => {
	for (const action of new Set(FLOWS.flat())) {
		const [method = "", template = ""] = action.split(" ");

		if (template.startsWith("/github/")) {
			const [path = "", names] = template.split("?");
			const url = new URL(`https://api.test${path.replaceAll(":owner", "octo").replaceAll(":repo", "hello").replaceAll(":ref", "main")}${names === undefined ? "" : `?${names === "service" ? "service=git-upload-pack" : `${names}=1`}`}`);

			assert.equal(actionOf(method, url, "/github/*"), action, action);
		}
	}
});

test("the score: a step the editor takes is unsurprising, a jump it never makes is, a new action is capped, and too little behind an action isn't scored", () => {
	const model: Model = { "counts": new Map(), "out": new Map(), "into": new Map(), "total": 0, "firstSeen": new Map([["GET /github/api/repos/:owner/:repo/git/blobs/:ref", 0], ["POST /account/delete", 0]]) };
	const from = "GET /github/api/repos/:owner/:repo/git/trees/:ref?recursive";
	const usual = surprisal(model, { "from": from, "to": "GET /github/api/repos/:owner/:repo/git/blobs/:ref", "gap": 0 }) as number;
	const jump = surprisal(model, { "from": from, "to": "POST /account/delete", "gap": 0 }) as number;

	assert.ok(usual < 3, `a flow's step: ${usual} bits`);
	assert.ok(jump > usual + 3, `a jump: ${jump} bits`);
	assert.equal(surprisal(model, { "from": from, "to": "GET /brand-new-feature", "gap": 0 }), 4, "new: capped");
	assert.equal(surprisal(model, { "from": "GET /never-seen", "to": "POST /account/delete", "gap": 0 }), undefined, "nothing behind it");
});
