/**
 * The root domain's gate (src/gate.ts): a browser, and anyone asking for robots.txt, gets the site; anything else is asked
 * to pay, and doesn't get it. Coinbase's facilitator, which the gate asks what it takes, is stood in for.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ "format": "jwk" });
// (a CDP key's secret: an Ed25519 seed and its public half, base64)
const secret = Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]).toString("base64");

globalThis.fetch = (async () => Response.json({ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "eip155:8453" }], "extensions": [], "signers": {} })) as typeof fetch;

const { "default": gate } = await import("../src/gate.ts");
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

async function ask(path: string, headers: Record<string, string>): Promise<{ "status": number; "served": string[]; "headers": Headers }> {
	const served: string[] = [];
	const env = { "ASSETS": { "fetch": async (request: Request) => {
		served.push(new URL(request.url).pathname);

		return new Response("the site");
	} }, "PAY_TO": "0x0000000000000000000000000000000000000001", "CDP_API_KEY_ID": "00000000-0000-4000-8000-000000000000", "CDP_API_KEY_SECRET": secret };
	const response = await gate.fetch(new Request(`https://unusuallygood.dev${path}`, { "headers": headers }), env as never, { "waitUntil": () => undefined, "passThroughOnException": () => undefined } as never);

	return { "status": response.status, "served": served, "headers": response.headers };
}

test("a browser gets the site", async () => {
	assert.deepEqual((await ask("/", { "user-agent": CHROME, "sec-fetch-mode": "navigate" })).served, ["/"]);
});

test("anyone gets robots.txt", async () => {
	assert.deepEqual((await ask("/robots.txt", { "user-agent": "curl/8.7.1" })).served, ["/robots.txt"]);
});

for (const [who, headers] of [
	["curl", { "user-agent": "curl/8.7.1" }],
	["a crawler that names itself", { "user-agent": `${CHROME} compatible; SomeBot/1.0`, "sec-fetch-mode": "navigate" }],
	["a headless browser that says so", { "user-agent": CHROME.replace("Chrome", "HeadlessChrome"), "sec-fetch-mode": "navigate" }],
	["a browser's name with nothing a browser sends", { "user-agent": CHROME }]
] as [string, Record<string, string>][]) {
	test(`${who} is asked to pay, and isn't given the site`, async () => {
		const { status, served } = await ask("/", headers);

		assert.equal(status, 402);
		assert.deepEqual(served, []);
	});
}
