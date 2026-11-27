/**
 * Our `page.route` (src/route.ts): which URLs a route's glob or RegExp matches, held to Playwright's own — the same
 * routes on a real Playwright page, the same requests made, and which each route caught compared — and how a held
 * request is handled, on a driver standing in for the shell: the newest route first, `fallback` to the one before,
 * `times`, a handler that throws, and what `fulfill`, `continue` and `abort` answer.
 *
 *   node --test packages/playwright/test/route.test.mjs
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import { after, before, test } from "node:test";

import { launchChromium } from "@brianjenkins94/util/playwright/chromium";

const { Page } = await import("../src/index.ts");
const { crossing, matchesCrossed } = await import("../src/route.ts");

let browser;
let server;
let origin;

before(async () => {
	server = http.createServer((request, response) => {
		response.setHeader("access-control-allow-origin", "*");
		response.end(request.url === "/" ? "<!doctype html><title>routes</title>" : "real");
	});
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${String(server.address().port)}`;
	browser = await launchChromium();
});

after(async () => {
	await browser?.close();
	server?.close();
});

const PATHS = ["/api/users", "/api/users/7", "/api/users?page=2", "/assets/app.js", "/assets/deep/app.css", "/api/v2/items", "/data.json", "/a?b"];
const ROUTES = ["**/api/users", "**/api/*", "**/api/**", "**/*.{js,css}", "**/assets/*.js", "**/data.json", /\/api\/users\/\d+$/u, "**/a?b", `${"http://127.0.0.1"}:*/api/users`];

test("a route's glob or RegExp matches what Playwright's matches", async () => {
	const page = await browser.newPage();
	const at = origin;

	await page.goto(at);

	for (const route of ROUTES) {
		const caught = [];

		await page.route(route, async (handled) => {
			caught.push(new URL(handled.request().url()).pathname + new URL(handled.request().url()).search);
			await handled.fulfill({ "body": "routed" });
		});

		for (const path of PATHS) {
			await page.evaluate(async (url) => fetch(url).then((response) => response.text()), `${at}${path}`);
		}

		await page.unrouteAll();

		const ours = PATHS.filter((path) => matchesCrossed(crossing(route), `${at}${path}`));

		assert.deepEqual(ours, caught, `${String(route)}: Playwright caught ${JSON.stringify(caught)}, ours ${JSON.stringify(ours)}`);
	}

	await page.close();
});

/** A driver standing in for the shell: what the page asks it to hold, and held requests handed out as the test says. */
function shell() {
	const told = { "matches": [], "answers": new Map() };
	let handOut;
	const next = [];

	return {
		told,
		"hold": (held) => {
			const answered = new Promise((resolve) => {
				told.answers.set(held.id, resolve);
			});

			if (handOut === undefined) {
				next.push(held);
			} else {
				handOut([held]);
				handOut = undefined;
			}

			return answered;
		},
		"driver": {
			"run": async () => ({ "done": true }),
			"routes": async (matches) => {
				told.matches = matches;
			},
			"routed": async () => (next.length > 0 ? next.splice(0) : new Promise((resolve) => { handOut = resolve; })),
			"answer": async (id, answer) => {
				told.answers.get(id)?.(answer);
			}
		}
	};
}

const held = (id, url, extra = {}) => ({ "id": id, "url": url, "method": "GET", "headers": {}, "resourceType": "fetch", ...extra });
const text = (answer) => new TextDecoder().decode(Uint8Array.from(atob(answer.fulfill.body), (character) => character.codePointAt(0)));

test("the newest route answers first; fallback hands it to the one before; times runs out; a throw aborts", async () => {
	const { told, hold, driver } = shell();
	const page = new Page(driver);

	await page.route("**/api/**", async (route) => route.fulfill({ "status": 201, "json": { "from": "older" } }));
	await page.route("**/api/users", async (route) => route.fallback());
	await page.route("**/api/once", async (route) => route.fulfill({ "body": "once" }), { "times": 1 });
	await page.route((url) => url.pathname === "/broken", async () => {
		throw new Error("nope");
	});

	assert.deepEqual(told.matches, [{ "glob": "**/api/**" }, { "glob": "**/api/users" }, { "glob": "**/api/once" }, { "any": true }], "a predicate's crosses as any");

	const older = await hold(held("1", "http://x/api/users"));

	assert.equal(older.fulfill.status, 201);
	assert.equal(older.fulfill.headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(text(older)), { "from": "older" });

	assert.equal(text(await hold(held("2", "http://x/api/once"))), "once");
	assert.equal(text(await hold(held("3", "http://x/api/once"))), "{\"from\":\"older\"}", "once, then the route before it");
	assert.ok(!told.matches.some((match) => match.glob === "**/api/once"), "and it's no longer held for");
	assert.match((await hold(held("4", "http://x/broken"))).abort, /nope/u);
	assert.deepEqual(await hold(held("5", "http://x/elsewhere")), { "continue": true });

	await page.unrouteAll();
	assert.deepEqual(told.matches, []);
});

test("what a handler reads of the request, and continue, abort and fulfill's own headers and bytes", async () => {
	const { hold, driver } = shell();
	const page = new Page(driver);
	let read;

	await page.route("**/post", async (route, request) => {
		read = [request.method(), request.postData(), request.postDataJSON(), request.headers()["x-test"], request.resourceType()];
		await route.fulfill({ "status": 404, "headers": { "X-Made": "here" }, "contentType": "text/plain", "body": new Uint8Array([104, 105]) });
	});
	await page.route("**/go", async (route) => route.continue());
	await page.route("**/stop", async (route) => route.abort("blockedbyclient"));

	const posted = await hold(held("1", "http://x/post", { "method": "POST", "headers": { "x-test": "yes" }, "body": btoa("{\"a\":1}") }));

	assert.deepEqual(read, ["POST", "{\"a\":1}", { "a": 1 }, "yes", "fetch"]);
	assert.deepEqual([posted.fulfill.status, posted.fulfill.headers, text(posted)], [404, { "x-made": "here", "content-type": "text/plain" }, "hi"]);
	assert.deepEqual(await hold(held("2", "http://x/go")), { "continue": true });
	assert.deepEqual(await hold(held("3", "http://x/stop")), { "abort": "blockedbyclient" });
	await page.unrouteAll();
});
