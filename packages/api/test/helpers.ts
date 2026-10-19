import type { createTestHarness } from "wrangler";
import assert from "node:assert/strict";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { BROWSER } from "./browser.ts";
import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";

// What the tests that sign in through the API's own pages share: a browser (from an IP of its own each request, so the
// per-IP limits never meet), an app (its DPoP key, PKCE, the pushed request, the access token once it has one), and
// the shortcuts to a signed-in app by email or GitHub. Each test file keeps its own harness, secrets and stand-ins
// (GitHub's, the outbox, Have I Been Pwned), and hands them here.

type Harness = ReturnType<typeof createTestHarness>;

export type Answer = Awaited<ReturnType<Harness["fetch"]>>;

/** Each client's local page (src/clients.ts). */
export const PAGES = { "editor": "http://localhost:5173/", "admin": "http://localhost:5174/" } as const;

export type Client = keyof typeof PAGES;

/** A new address, nobody's yet. */
export const someone = (): string => `someone-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** The code in the latest email to `address` (in its subject). */
export function codeFor(outbox: { "to": string; "subject": string }[], address: string): string {
	const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/u.exec(outbox.findLast((message) => message.to === address)?.subject ?? "")?.[1];

	assert.ok(code !== undefined, `a code was sent to ${address}`);

	return code;
}

/** The browser and apps for `server`, once it listens at `base()`; `outbox` the email stand-in's, `github` the GitHub
 *  stand-in's next answer (whose account the user said yes as), `db` the Worker's D1, when the file has them. */
export function testBrowser(server: Harness, base: () => URL, { outbox = [], github = { "id": 0 }, db }: { "outbox"?: { "to": string; "subject": string }[]; "github"?: { "id": number }; "db"?: () => D1Database } = {}) {
	const at = (path: string): string => new URL(path, base()).href;

	const browse = async (url: string, { cookie, ...init }: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "cookie"?: string } = {}): Promise<Answer> => server.fetch(url, { ...init, "redirect": "manual", "headers": { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...BROWSER, ...cookie === undefined ? {} : { "cookie": cookie }, ...init.headers } });

	/** A form POST from our own pages, in the browser holding `cookie`. */
	const form = async (path: string, cookie: string | undefined, fields: Record<string, string>): Promise<Answer> => browse(at(path), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(fields).toString(), ...cookie === undefined ? {} : { "cookie": cookie } });

	/** An app: its sign-in pushed and opened in a browser (the cookie); `call` sends a request with its key's proof (and
	 *  the access token once `redeem` has it); `prefix` is where its account routes are, `page` its redirect page. */
	async function app(client: Client = "admin") {
		const page = PAGES[client];
		const { privateKey, publicKey } = await generateKeyPair("ES256");
		const jwk = await exportJWK(publicKey);
		const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
		let nonce: string | undefined;
		let token: string | undefined;
		const call = async (method: string, path: string, fields?: Record<string, string>, json?: unknown): Promise<Answer> => {
			for (let attempt = 0; ; attempt += 1) {
				const ath = token === undefined ? {} : { "ath": await s256(token) };
				const proof = await new SignJWT({ "htm": method, "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...ath }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
				const body = json === undefined ? fields === undefined ? {} : { "body": new URLSearchParams(fields).toString(), "type": "application/x-www-form-urlencoded" } : { "body": JSON.stringify(json), "type": "application/json" };
				const response = await browse(at(path), { "method": method, "headers": { "dpop": proof, ...token === undefined ? {} : { "authorization": `DPoP ${token}` }, ..."type" in body ? { "content-type": body.type } : {} }, ..."body" in body ? { "body": body.body } : {} });

				nonce = response.headers.get("dpop-nonce") ?? nonce;

				if (attempt === 0 && (response.status === 400 || response.status === 401) && (await response.clone().json().catch(() => ({})) as { "error"?: string }).error === "use_dpop_nonce") {
					continue;
				}

				return response;
			}
		};
		const challenge = await s256(verifier);
		const { request_uri } = await (await call("POST", "/auth/par", { "client_id": client, "response_type": "code", "redirect_uri": page, "state": "s", "code_challenge": challenge, "code_challenge_method": "S256" })).json() as { "request_uri": string };
		const opened = await browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": client, "request_uri": request_uri })}`);

		return {
			"cookie": (opened.headers.get("set-cookie") ?? "").split(";")[0] as string,
			"prefix": client === "editor" ? "" : "/admin",
			"page": page,
			"redeem": async (code: string): Promise<string> => {
				token = (await (await call("POST", "/token", { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": client })).json() as { "access_token": string }).access_token;

				return token;
			},
			"call": call
		};
	}

	type App = Awaited<ReturnType<typeof app>>;

	/** As the throttle on emailed codes can tell, a minute later (it counts the address's `email_code_sent` rows). */
	const aMinuteLater = async (): Promise<void> => {
		await db?.().prepare("UPDATE audit SET at = at - 61000 WHERE event = 'email_code_sent'").run();
	};

	/** Signed in by an emailed code to `address` (a new account if it's nobody's), in `signedIn` or a new app; then a
	 *  minute later, so the next code to the same address can be sent. */
	async function byEmail(address: string, signedIn?: App | Client): Promise<App> {
		const signingIn = typeof signedIn === "object" ? signedIn : await app(signedIn ?? "editor");

		await form("/auth/email", signingIn.cookie, { "address": address });

		const { location } = await (await form("/auth/email/verify", signingIn.cookie, { "code": codeFor(outbox, address) })).json() as { "location": string };

		await signingIn.redeem(new URL(location).searchParams.get("code") as string);
		await aMinuteLater();

		return signingIn;
	}

	/** Signed in with GitHub, as `id`, through the sign-in page and the GitHub stand-in. */
	async function byGitHub(id: number, client: Client = "editor"): Promise<App> {
		const signingIn = await app(client);
		const toGitHub = new URL((await browse(at("/auth/github"), { "cookie": signingIn.cookie })).headers.get("location") as string);

		github.id = id;

		const landing = new URL((await browse(`${at("/auth/github/callback")}?${new URLSearchParams({ "code": "github-code", "state": toGitHub.searchParams.get("state") as string })}`, { "cookie": signingIn.cookie })).headers.get("location") as string);

		await signingIn.redeem(landing.searchParams.get("code") as string);

		return signingIn;
	}

	return { at, browse, form, app, aMinuteLater, byEmail, byGitHub, "codeFor": (address: string) => codeFor(outbox, address) };
}

export type App = Awaited<ReturnType<ReturnType<typeof testBrowser>["app"]>>;
