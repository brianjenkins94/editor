// The GitHub data plane, proven against a fake provider (a recording fetch) — no network. Covers the auth seam
// (the PAT provider attaches the bearer, per request, without clobbering an explicit one), the Git Data commit flow
// (ref → base commit → blobs → tree → commit → move ref, with text inline and binary uploaded as a blob), and the
// error surface (a 404 is `undefined` for existence checks, a real error otherwise). Run: tsx --test.
import assert from "node:assert/strict";
import test from "node:test";
import { patProvider } from "../github-auth.ts";
import { createGitHub, decodeBase64ToText, GitHubError } from "../github.ts";

/** A provider (fetch) that records calls and replies from a routing table; parses JSON bodies for assertions. */
function fakeProvider(routes) {
	const calls = [];

	const provider = async (input, init = {}) => {
		const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
		const method = (init.method ?? "GET").toUpperCase();
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;

		calls.push({ "method": method, "path": url.pathname, "query": url.search, "body": body, "auth": new Headers(init.headers).get("Authorization") });

		for (const [match, reply] of routes) {
			if (match.method === method && url.pathname.endsWith(match.path)) {
				const { status = 200, json } = reply(body);

				return new Response(json === undefined ? null : JSON.stringify(json), { "status": status, "headers": { "Content-Type": "application/json" } });
			}
		}

		return new Response(JSON.stringify({ "message": "no route for " + method + " " + url.pathname }), { "status": 404, "headers": { "Content-Type": "application/json" } });
	};

	return { "provider": provider, "calls": calls };
}

test("patProvider attaches the bearer per request, and leaves an explicit Authorization alone", async () => {
	const seen = [];
	const realFetch = globalThis.fetch;

	globalThis.fetch = async (input, init) => {
		seen.push(new Headers(init?.headers).get("Authorization"));

		return new Response("{}", { "status": 200, "headers": { "Content-Type": "application/json" } });
	};

	try {
		const provider = patProvider(() => "abc123");

		await provider("https://api.github.com/user", {});
		await provider("https://api.github.com/user", { "headers": { "Authorization": "Bearer explicit" } });

		assert.deepEqual(seen, ["Bearer abc123", "Bearer explicit"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the token is resolved fresh per request (changing it needs no new client)", async () => {
	let token = "first";
	const { provider, calls } = fakeProvider([[{ "method": "GET", "path": "/user" }, () => ({ "json": { "login": "me" } })]]);
	// Wrap the recording provider in the PAT provider so we exercise per-request token resolution.
	const gh = createGitHub(patProvider(() => token));
	// Redirect the PAT provider's underlying fetch at our recorder.
	const realFetch = globalThis.fetch;

	globalThis.fetch = provider;

	try {
		await gh.viewer();
		token = "second";
		await gh.viewer();

		assert.deepEqual(calls.map((call) => call.auth), ["Bearer first", "Bearer second"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("commitFiles runs the Git Data flow in order, inlining text and uploading binary as a blob", async () => {
	const { provider, calls } = fakeProvider([
		[{ "method": "GET", "path": "/git/ref/heads/main" }, () => ({ "json": { "object": { "sha": "BASE" } } })],
		[{ "method": "GET", "path": "/git/commits/BASE" }, () => ({ "json": { "tree": { "sha": "BASETREE" } } })],
		[{ "method": "POST", "path": "/git/blobs" }, (body) => ({ "status": 201, "json": { "sha": "BLOB:" + body.encoding } })],
		[{ "method": "POST", "path": "/git/trees" }, () => ({ "status": 201, "json": { "sha": "NEWTREE" } })],
		[{ "method": "POST", "path": "/git/commits" }, () => ({ "status": 201, "json": { "sha": "NEWCOMMIT" } })],
		[{ "method": "PATCH", "path": "/git/refs/heads/main" }, (body) => ({ "json": { "object": { "sha": body.sha } } })]
	]);
	const gh = createGitHub(provider);

	const sha = await gh.commitFiles("me", "games", {
		"branch": "main",
		"message": "add example",
		"files": [
			{ "path": "games/example/game.ts", "content": "export const x = 1;\n" },
			{ "path": "games/example/assets/sprites/boulder.png", "base64": "iVBORw0KGgo=" }
		]
	});

	assert.equal(sha, "NEWCOMMIT", "returns the new commit sha");

	// The flow happens in dependency order.
	const order = calls.map((call) => call.method + " " + call.path.replace(/^\/repos\/me\/games/u, ""));

	assert.deepEqual(order, [
		"GET /git/ref/heads/main",
		"GET /git/commits/BASE",
		"POST /git/blobs", // only the binary file needs a blob
		"POST /git/trees",
		"POST /git/commits",
		"PATCH /git/refs/heads/main"
	]);

	// The tree is built over the base tree; text is inline, binary references the uploaded blob.
	const treeCall = calls.find((call) => call.path.endsWith("/git/trees"));

	assert.equal(treeCall.body.base_tree, "BASETREE", "tree extends the base tree (not a full replace)");

	const byPath = new Map(treeCall.body.tree.map((entry) => [entry.path, entry]));

	assert.equal(byPath.get("games/example/game.ts").content, "export const x = 1;\n", "text is inlined");
	assert.equal(byPath.get("games/example/game.ts").sha, undefined, "text carries no blob sha");
	assert.equal(byPath.get("games/example/assets/sprites/boulder.png").sha, "BLOB:base64", "binary references the base64 blob");
	assert.equal(byPath.get("games/example/assets/sprites/boulder.png").content, undefined, "binary is not inlined");

	// The commit parents the old tip; the ref is moved to the new commit.
	const commitCall = calls.find((call) => call.path.endsWith("/git/commits") && call.method === "POST");

	assert.deepEqual(commitCall.body.parents, ["BASE"]);
	assert.equal(commitCall.body.tree, "NEWTREE");

	const patchCall = calls.find((call) => call.method === "PATCH");

	assert.equal(patchCall.body.sha, "NEWCOMMIT");
	assert.equal(patchCall.body.force, false);
});

test("readTree requests the recursive tree; getRepo returns undefined on 404 but throws otherwise", async () => {
	const { provider, calls } = fakeProvider([
		[{ "method": "GET", "path": "/git/trees/HEAD" }, () => ({ "json": { "sha": "T", "tree": [{ "path": "a", "type": "blob", "sha": "s", "mode": "100644" }], "truncated": false } })],
		[{ "method": "GET", "path": "/repos/me/missing" }, () => ({ "status": 404, "json": { "message": "Not Found" } })],
		[{ "method": "GET", "path": "/repos/me/boom" }, () => ({ "status": 500, "json": { "message": "Server Error" } })]
	]);
	const gh = createGitHub(provider);

	const tree = await gh.readTree("me", "games");

	assert.equal(tree.tree.length, 1);
	assert.match(calls.find((call) => call.path.includes("/git/trees/")).query, /recursive=1/u, "tree is fetched recursively");

	assert.equal(await gh.getRepo("me", "missing"), undefined, "a 404 existence check is undefined");

	await assert.rejects(() => gh.getRepo("me", "boom"), (error) => error instanceof GitHubError && error.status === 500, "a non-404 error still throws");
});

test("readRepo returns every blob as decoded bytes (text + binary), skipping tree entries", async () => {
	const textB64 = Buffer.from("hello\n", "utf8").toString("base64");
	const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic — arbitrary binary
	const pngB64 = Buffer.from(pngBytes).toString("base64");
	const { provider } = fakeProvider([
		[{ "method": "GET", "path": "/git/trees/HEAD" }, () => ({ "json": { "sha": "T", "truncated": false, "tree": [
			{ "path": "dir", "type": "tree", "sha": "d", "mode": "040000" },
			{ "path": "a.ts", "type": "blob", "sha": "s1", "mode": "100644" },
			{ "path": "assets/img.png", "type": "blob", "sha": "s2", "mode": "100644" }
		] } })],
		[{ "method": "GET", "path": "/git/blobs/s1" }, () => ({ "json": { "content": textB64, "encoding": "base64" } })],
		[{ "method": "GET", "path": "/git/blobs/s2" }, () => ({ "json": { "content": pngB64, "encoding": "base64" } })]
	]);
	const gh = createGitHub(provider);

	const files = await gh.readRepo("me", "games");
	const byPath = new Map(files.map((file) => [file.path, file.bytes]));

	assert.deepEqual([...byPath.keys()].sort(), ["a.ts", "assets/img.png"], "blobs only — the tree entry is skipped");
	assert.equal(new TextDecoder().decode(byPath.get("a.ts")), "hello\n", "text decodes");
	assert.deepEqual([...byPath.get("assets/img.png")], [...pngBytes], "binary bytes are preserved");
});

test("decodeBase64ToText round-trips UTF-8 through GitHub's wrapped base64", () => {
	const text = "const π = 3.14;\nexport { π };\n";
	const base64 = Buffer.from(text, "utf8").toString("base64");
	// GitHub wraps blob base64 at 60 columns — the decoder must tolerate the newlines.
	const wrapped = base64.replace(/(.{4})/u, "$1\n");

	assert.equal(decodeBase64ToText(wrapped), text);
});
