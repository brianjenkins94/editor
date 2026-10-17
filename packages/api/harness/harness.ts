/**
 * `npm run harness` (SIGN-IN.md, C0): the API, run locally in Wrangler's test harness, with a page beside it showing
 * everything it stores, live, and what each step of a flow wrote. Modeled on sms-reference-app's debug harness.
 *
 *   http://localhost:8787/__harness              the page: an app in an iframe (?app=, default the admin app on
 *                                                5174), and the stored state with its changes
 *   http://localhost:8787/__harness/state        the same as JSON
 *   http://localhost:8787/…                      everything else is the API itself
 *
 * It listens on 8787 because that's the dev GitHub App's local callback (packages/api/README.md, A0), and passes every
 * other request to the Worker as it came, so the issuer and redirect URIs are the local ones in wrangler.jsonc.
 * Secrets are made fresh each run, except GITHUB_CLIENT_SECRET, read from `.dev.vars` (gitignored) if it's there:
 * without it, signing in with GitHub stops at GitHub's answer. State lives in memory: a restart starts empty.
 */
import type { Changes, Snapshot } from "./state.ts";
import * as fs from "@brianjenkins94/util/fs";
import { proxy } from "@brianjenkins94/util/proxy";
import { createServer } from "node:http";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { diff, snapshot } from "./state.ts";

const PORT = Number(process.env["PORT"] ?? 8787);
const root = new URL("..", import.meta.url).pathname;
const random = (): string => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

/** `.dev.vars`' KEY=VALUE lines, for the GitHub client secret. */
function devVars(): Record<string, string> {
	try {
		return Object.fromEntries(fs.readFileSync(`${root}.dev.vars`, { "encoding": "utf-8" }).split("\n").map((line) => /^(\w+)\s*=\s*"?(.*?)"?\s*$/u.exec(line)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
	} catch {
		return {};
	}
}

const secrets = {
	"SIGNING_JWK": JSON.stringify({ ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "harness" }),
	"NONCE_KEY": random(),
	"TOKEN_KEK": random(),
	"AUDIT_KEY": random(),
	"STATE_KEY": random(),
	"GITHUB_CLIENT_SECRET": devVars()["GITHUB_CLIENT_SECRET"] ?? "no client secret: add GITHUB_CLIENT_SECRET to .dev.vars"
};
const harness = createTestHarness({ "root": root, "workers": [{ "configPath": "wrangler.jsonc", "secrets": secrets }] });

await harness.listen();
await harness.getWorker().applyD1Migrations("DB");

let last: Snapshot = {};
const log: { "at": string; "changes": Changes }[] = [];

/** The state now, and every change since the harness started (newest first), each found by comparing with the last read. */
async function state(): Promise<{ "state": Snapshot; "log": typeof log }> {
	const now = await snapshot(harness);
	const changes = diff(last, now);

	if (Object.keys(changes).length > 0) {
		log.unshift({ "at": new Date().toISOString(), "changes": changes });
		log.length = Math.min(log.length, 200);
	}

	last = now;

	return { "state": now, "log": log };
}

createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

	try {
		if (url.pathname === "/__harness" || url.pathname === "/__harness/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(fs.readFileSync(new URL("page.html", import.meta.url).pathname, { "encoding": "utf-8" }));

			return;
		}

		if (url.pathname === "/__harness/state") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify(await state()));

			return;
		}

		// The API, as the request came (util/proxy): same URL, so the Worker's issuer is this origin; headers and body
		// streamed through; redirects (GitHub's, the sign-in's) handed back as they are; and the client's address as
		// Cloudflare would give it.
		await proxy(request, response, { "fetch": async (forwarded) => harness.fetch(forwarded as never) as unknown as Promise<Response>, "to": url.href, "headers": { "cf-connecting-ip": request.socket.remoteAddress ?? "127.0.0.1" }, "redirect": "manual" });
	} catch (error) {
		response.writeHead(500, { "content-type": "text/plain" });
		response.end(error instanceof Error ? error.message : String(error));
	}
}).listen(PORT, () => {
	process.stdout.write(`API on http://localhost:${PORT}/ · harness at http://localhost:${PORT}/__harness\n`);
});
