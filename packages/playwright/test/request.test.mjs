/**
 * Our `page.request` against Playwright's own: each request made by both, to the same server, and what each heard
 * compared — status, its text, `ok`, headers, the body as text, JSON and bytes — and what a request sends: its method,
 * headers, query and body, as the server got it.
 *
 *   node --test packages/playwright/test/request.test.mjs
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import { after, before, test } from "node:test";

import { launchChromium } from "@brianjenkins94/util/playwright/chromium";

const { Page, fetched, requestInit } = await import("../src/index.ts");

let browser;
let page;
let ours;
let server;
let origin;

before(async () => {
	// What it was asked, said back; and a few answers of its own.
	server = http.createServer((request, response) => {
		const chunks = [];

		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const url = new URL(request.url, "http://localhost");

			if (url.pathname === "/missing") {
				response.writeHead(404, "Not Found", { "content-type": "text/plain" });
				response.end("nobody here");
			} else if (url.pathname === "/bytes") {
				response.writeHead(200, { "content-type": "application/octet-stream" });
				response.end(Buffer.from([0, 1, 254, 255]));
			} else {
				response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json", "x-said": "back" });
				response.end(request.method === "HEAD" ? undefined : JSON.stringify({ "method": request.method, "query": url.search, "type": request.headers["content-type"] ?? null, "asked": request.headers["x-asked"] ?? null, "body": Buffer.concat(chunks).toString("base64") }));
			}
		});
	});
	await new Promise((resolve) => {
		server.listen(0, resolve);
	});
	origin = `http://localhost:${String(server.address().port)}`;
	browser = await launchChromium({});
	page = await browser.newPage();
	ours = new Page({ "run": async () => ({ "done": true }), "url": async () => "about:blank", "fetch": async (url, init) => fetched(await fetch(url, requestInit(init))) });
});

after(async () => {
	await browser?.close();
	server?.close();
});

/** What a response says, as both have it. */
async function heard(response) {
	const headers = response.headers();

	return { "status": response.status(), "statusText": response.statusText(), "ok": response.ok(), "type": headers["content-type"], "said": headers["x-said"], "text": await response.text() };
}

/** `make` on both: what each heard, and that they're the same. */
async function both(make) {
	const [theirs, mine] = [await heard(await make(page.request)), await heard(await make(ours.request))];

	assert.deepEqual(mine, theirs);

	return mine;
}

test("a GET, its query given as params, and a header of its own", async () => {
	const said = await both(async (request) => request.get(`${origin}/echo`, { "params": { "a": 1, "b": "two" }, "headers": { "x-asked": "yes" } }));
	const { method, query, asked } = JSON.parse(said.text);

	assert.deepEqual([said.status, method, query, asked], [200, "GET", "?a=1&b=two", "yes"]);
});

test("a POST of an object is JSON, of a string as it is, each with its content-type", async () => {
	const json = JSON.parse((await both(async (request) => request.post(`${origin}/echo`, { "data": { "n": 1 } }))).text);

	assert.deepEqual([json.method, json.type, Buffer.from(json.body, "base64").toString()], ["POST", "application/json", "{\"n\":1}"]);

	const text = JSON.parse((await both(async (request) => request.post(`${origin}/echo`, { "data": "plain", "headers": { "content-type": "text/plain" } }))).text);

	assert.deepEqual([text.type, Buffer.from(text.body, "base64").toString()], ["text/plain", "plain"]);
});

test("put, patch, delete and head, by their methods; fetch's method its option, GET without one", async () => {
	const echo = `${origin}/echo`;

	for (const method of ["put", "patch", "delete"]) {
		assert.equal(JSON.parse((await both(async (request) => request[method](echo))).text).method, method.toUpperCase());
	}

	assert.equal((await both(async (request) => request.head(`${origin}/echo`))).text, "");
	assert.equal(JSON.parse((await both(async (request) => request.fetch(`${origin}/echo`))).text).method, "GET");
	assert.equal(JSON.parse((await both(async (request) => request.fetch(`${origin}/echo`, { "method": "put" }))).text).method, "PUT");
});

test("not ok: said, or thrown with failOnStatusCode", async () => {
	const said = await both(async (request) => request.get(`${origin}/missing`));

	assert.deepEqual([said.status, said.ok, said.text], [404, false, "nobody here"]);
	await assert.rejects(page.request.get(`${origin}/missing`, { "failOnStatusCode": true }));
	await assert.rejects(ours.request.get(`${origin}/missing`, { "failOnStatusCode": true }), /404/u);
});

test("its body as bytes, as they were, and as JSON", async () => {
	const [theirs, mine] = [await page.request.get(`${origin}/bytes`), await ours.request.get(`${origin}/bytes`)];

	assert.deepEqual([...await mine.body()], [...await theirs.body()]);
	assert.deepEqual([...await mine.body()], [0, 1, 254, 255]);
	assert.deepEqual(await (await ours.request.get(`${origin}/echo`)).json(), await (await page.request.get(`${origin}/echo`)).json());
});

test("a page that can't make requests says so", async () => {
	await assert.rejects(new Page({ "run": async () => ({ "done": true }) }).request.get(`${origin}/echo`), /can't make requests/u);
});
