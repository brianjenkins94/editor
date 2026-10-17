import type { Hono } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { audit, NOWHERE } from "./audit.ts";
import { inboxAddresses } from "./inbox.ts";

/**
 * The email smoke test (packages/admin/README.md, the Mail page): a whole sign-in by email, as the admin app and a browser
 * would make it, against this Worker's own routes, with the first of our own addresses (INBOX). The code goes out
 * through Email Service and comes back through Email Routing to our inbox (src/inbox.ts), where the test reads it: real
 * delivery, our DNS records, and every step of the flow, with no one's mailbox. Then the sign-in is ended.
 *
 * Run by the daily cron and from the Mail page. Each run is an audit row: `smoke_test_passed` (with how long the email
 * took), or `smoke_test_failed` (at which step, and why), which alerts.
 */

/** The router, set by index.ts (it can't be imported here: it imports the routes that run this). */
export const ROUTER: { "app"?: Hono<AppEnv> } = {};

/** How long to wait for the email, checking every few seconds. */
const WAIT = 90_000;

const EVERY = 3000;

/** Where the requests seem to come from: an address reserved for documentation, never a real client's. */
const FROM_IP = "192.0.2.1";

/** A step failed: which, and why. */
class Failed extends Error {
	public readonly step: string;

	public constructor(step: string, reason: string) {
		super(reason);
		this.step = step;
	}
}

export async function smokeTest(env: Bindings, executionContext: Pick<ExecutionContext, "waitUntil" | "passThroughOnException">): Promise<{ "ok": true; "seconds": number } | { "ok": false; "step": string; "reason": string }> {
	const app = ROUTER.app;
	const address = inboxAddresses(env)[0];
	const redirectUri = env.REDIRECT_URIS["admin"]?.[0];

	if (app === undefined || address === undefined || redirectUri === undefined) {
		return record(env, { "ok": false, "step": "setup", "reason": address === undefined ? "no INBOX address" : "no admin redirect page" });
	}

	const origin = "https://smoke.invalid";
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;
	let cookie: string | undefined;

	/** One request, as a browser at FROM_IP would send it: with the attempt's cookie, and a DPoP proof when asked. */
	const send = async (method: string, path: string, { form, proof = false, query = "" }: { "form"?: Record<string, string>; "proof"?: boolean; "query"?: string } = {}): Promise<Response> => {
		for (let attempt = 0; ; attempt += 1) {
			const url = `${origin}${path}${query}`;
			const headers: Record<string, string> = { "cf-connecting-ip": FROM_IP, ...cookie === undefined ? {} : { "cookie": cookie }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };

			if (proof) {
				headers["dpop"] = await new SignJWT({ "htm": method, "htu": `${origin}${path}`, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce } }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
			}

			const response = await app.fetch(new Request(url, { "method": method, "headers": headers, "redirect": "manual", ...form === undefined ? {} : { "body": new URLSearchParams(form) } }), env, executionContext as ExecutionContext);

			nonce = response.headers.get("dpop-nonce") ?? nonce;

			if (proof && attempt === 0 && response.status === 400 && (await response.clone().json().catch(() => ({})) as { "error"?: string }).error === "use_dpop_nonce") {
				continue;
			}

			return response;
		}
	};
	const expect = async (step: string, response: Response, status: number): Promise<Response> => {
		if (response.status !== status) {
			throw new Failed(step, `${response.status} ${(await response.clone().text()).slice(0, 120)}`);
		}

		return response;
	};

	try {
		const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const pushed = await (await expect("push", await send("POST", "/auth/par", { "proof": true, "form": { "client_id": "admin", "response_type": "code", "redirect_uri": redirectUri, "state": "smoke", "code_challenge": challenge, "code_challenge_method": "S256" } }), 201)).json() as { "request_uri": string };
		const opened = await expect("open", await send("GET", "/auth/start", { "query": `?${new URLSearchParams({ "client_id": "admin", "request_uri": pushed.request_uri })}` }), 302);

		cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];

		const asked = Date.now();

		await expect("send", await send("POST", "/auth/email", { "form": { "address": address } }), 200);

		// The email, back through Email Routing: its subject has the code.
		let code: string | undefined;

		while (code === undefined && Date.now() - asked < WAIT) {
			await new Promise((resolve) => {
				setTimeout(resolve, EVERY);
			});

			const arrived = await env.DB.prepare("SELECT subject FROM inbox WHERE address = ? AND at >= ? ORDER BY id DESC LIMIT 1").bind(address, asked - 1000).first<{ "subject": string }>();

			code = /([A-Z2-9]{4}-[A-Z2-9]{4})/u.exec(arrived?.subject ?? "")?.[1];
		}

		if (code === undefined) {
			throw new Failed("receive", `no email in ${WAIT / 1000} seconds`);
		}

		const seconds = Math.round((Date.now() - asked) / 1000);
		const { location } = await (await expect("verify", await send("POST", "/auth/email/verify", { "form": { "code": code } }), 200)).json() as { "location": string };
		const tokens = await (await expect("redeem", await send("POST", "/token", { "proof": true, "form": { "grant_type": "authorization_code", "code": new URL(location).searchParams.get("code") ?? "", "code_verifier": verifier, "client_id": "admin" } }), 200)).json() as { "refresh_token": string };

		await expect("end", await send("POST", "/revoke", { "proof": true, "form": { "token": tokens.refresh_token } }), 200);

		return record(env, { "ok": true, "seconds": seconds });
	} catch (error) {
		return record(env, error instanceof Failed ? { "ok": false, "step": error.step, "reason": error.message } : { "ok": false, "step": "unexpected", "reason": error instanceof Error ? error.name : "error" });
	}
}

async function record<T extends { "ok": true; "seconds": number } | { "ok": false; "step": string; "reason": string }>(env: Bindings, result: T): Promise<T> {
	await audit(env, result.ok ? "smoke_test_passed" : "smoke_test_failed", {}, NOWHERE, "seconds" in result ? { "reason": `email back in ${result.seconds} s` } : { "reason": `${result.step}: ${result.reason}` });

	return result;
}
