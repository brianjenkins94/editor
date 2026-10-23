import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { accessTokenHash as hash } from "@brianjenkins94/util/auth/dpop";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { base64url } from "jose";
import { DurableObject } from "cloudflare:workers";

/**
 * A sign-in in progress (README.md, "Sign-in methods"): one Durable Object per attempt, made by
 * a client's pushed authorization request (/auth/par) and spent when it ends in a code (Grant.begin), or when it
 * expires. It holds the client's request (redirect page, state, PKCE challenge, the DPoP key the push was proven with),
 * so nothing of it rides in a browser redirect.
 *
 * Bound to one browser: /auth/start opens it once, within the push's lifetime, and hands the browser a secret (the
 * attempt cookie). Every step after that needs the secret, so a link or code carried to another browser can't finish
 * someone's sign-in.
 */

/** How long a pushed request waits to be opened (RFC 9126 suggests a short lifetime), and an attempt to be finished. */
export const PUSH_TTL = 120_000;

export const ATTEMPT_TTL = 15 * 60_000;

/** The client's request, as pushed. */
export interface Pushed {
	"client": string;
	"redirectUri": string;
	"state": string;
	"codeChallenge": string;
	"jkt": string;
}

interface Row extends Pushed {
	"pushed_at": number;
	"opened_at": number | null;
	"secret_hash": string | null;
	"finished_at": number | null;
}

/** A refusal's reason: a fixed string, for the audit log. */
export type Refused = { "ok": false; "reason": string };

/** What an Attempt keeps (the admin app's architecture page lists it from here). */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS attempt (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	client TEXT NOT NULL, redirectUri TEXT NOT NULL, state TEXT NOT NULL, codeChallenge TEXT NOT NULL, jkt TEXT NOT NULL,
	pushed_at INTEGER NOT NULL, opened_at INTEGER, secret_hash TEXT, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS first_factor (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	user_id TEXT NOT NULL, method TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_step (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	address TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries REAL NOT NULL, tries_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_challenge (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	challenge TEXT NOT NULL, expires INTEGER NOT NULL
)`;

/** How long a passkey sign-in's challenge is good for: the browser's prompt, and someone choosing a passkey. */
const CHALLENGE_TTL = 5 * 60_000;

/** An emailed code's life, and the tries at it: a bucket of TRIES, one back each TRY_REFILL (README.md, C2). */
export const CODE_TTL = 10 * 60_000;

const TRIES = 5;

const TRY_REFILL = 60_000;

export class Attempt extends DurableObject<Bindings> {
	private readonly sql = this.ctx.storage.sql;

	public constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);

		this.sql.exec(SCHEMA);
	}

	private row(): Row | undefined {
		return this.sql.exec<Row & Record<string, SqlStorageValue>>("SELECT client, redirectUri, state, codeChallenge, jkt, pushed_at, opened_at, secret_hash, finished_at FROM attempt WHERE id = 1").toArray()[0];
	}

	/** The pushed request, once. It's gone, with everything else, when the attempt's time is up. */
	public async push(request: Pushed): Promise<void> {
		if (this.row() !== undefined) {
			throw new Error("an attempt is pushed once");
		}

		const now = Date.now();

		this.sql.exec("INSERT INTO attempt (id, client, redirectUri, state, codeChallenge, jkt, pushed_at) VALUES (1, ?, ?, ?, ?, ?, ?)", request.client, request.redirectUri, request.state, request.codeChallenge, request.jkt, now);
		await this.ctx.storage.setAlarm(now + ATTEMPT_TTL);
	}

	/** Open it in the browser that will sign in: once, within the push's lifetime, for the client that pushed it. Gives the
	 *  secret that browser holds from now on. */
	public async open(client: string): Promise<{ "ok": true; "secret": string } | Refused> {
		const row = this.row();

		if (row === undefined) {
			return { "ok": false, "reason": "no such request_uri" };
		}

		if (row.client !== client) {
			return { "ok": false, "reason": "request_uri for another client" };
		}

		if (row.opened_at !== null) {
			return { "ok": false, "reason": "request_uri already used" };
		}

		if (Date.now() - row.pushed_at > PUSH_TTL) {
			return { "ok": false, "reason": "request_uri expired" };
		}

		const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

		this.sql.exec("UPDATE attempt SET opened_at = ?, secret_hash = ? WHERE id = 1", Date.now(), await hash(secret));

		return { "ok": true, "secret": secret };
	}

	/** Whether `secret` is this attempt's, and it's still running: what the sign-in page may show. */
	public async describe(secret: string): Promise<{ "ok": true; "client": string } | Refused> {
		const row = await this.running(secret);

		return "reason" in row ? row : { "ok": true, "client": row.client };
	}

	/** End it, once: the pushed request, for Grant.begin to start the sign-in with. Spent whatever comes next. */
	public async finish(secret: string): Promise<{ "ok": true; "request": Pushed } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		this.sql.exec("UPDATE attempt SET finished_at = ? WHERE id = 1", Date.now());

		return { "ok": true, "request": { "client": row.client, "redirectUri": row.redirectUri, "state": row.state, "codeChallenge": row.codeChallenge, "jkt": row.jkt } };
	}

	private async running(secret: string): Promise<Row | Refused> {
		const row = this.row();

		if (row === undefined || row.secret_hash === null) {
			return { "ok": false, "reason": "no such attempt" };
		}

		if (await hash(secret) !== row.secret_hash) {
			return { "ok": false, "reason": "another browser" };
		}

		if (row.finished_at !== null) {
			return { "ok": false, "reason": "attempt already finished" };
		}

		if (Date.now() - row.pushed_at > ATTEMPT_TTL) {
			return { "ok": false, "reason": "attempt expired" };
		}

		return row;
	}

	/**
	 * The email step (C2): a code was sent to `address`; its HMAC (`codeHash`, src/email.ts) is what's kept, valid for
	 * CODE_TTL. A new code replaces the last one, but not the tries left: asking again doesn't buy guesses.
	 */
	public async emailed(secret: string, address: string, codeHash: string): Promise<{ "ok": true } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		const now = Date.now();

		this.sql.exec("INSERT INTO email_step (id, address, code_hash, expires, tries, tries_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET address = excluded.address, code_hash = excluded.code_hash, expires = excluded.expires", address, codeHash, now + CODE_TTL, TRIES, now);

		return { "ok": true };
	}

	/**
	 * Try a code (its HMAC): one try from the bucket, then it must be this attempt's latest, unexpired. A match hands back
	 * the request and the address the code went to, and the code is gone (good once); the caller ends the attempt
	 * (`finish`), or, when the account has MFA, records the first factor passed (`passed`) for the second to finish.
	 */
	public async confirm(secret: string, codeHash: string): Promise<{ "ok": true; "request": Pushed; "address": string } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		const [step] = this.sql.exec<{ "address": string; "code_hash": string; "expires": number; "tries": number; "tries_at": number }>("SELECT address, code_hash, expires, tries, tries_at FROM email_step WHERE id = 1").toArray();

		if (step === undefined) {
			return { "ok": false, "reason": "no code sent" };
		}

		const now = Date.now();
		const tries = Math.min(TRIES, step.tries + (now - step.tries_at) / TRY_REFILL);

		if (tries < 1) {
			return { "ok": false, "reason": "too many tries" };
		}

		this.sql.exec("UPDATE email_step SET tries = ?, tries_at = ? WHERE id = 1", tries - 1, now);

		const given = new TextEncoder().encode(codeHash);
		const kept = new TextEncoder().encode(step.code_hash);

		if (given.byteLength !== kept.byteLength || !crypto.subtle.timingSafeEqual(given, kept)) {
			return { "ok": false, "reason": "code wrong" };
		}

		if (step.expires < now) {
			return { "ok": false, "reason": "code expired" };
		}

		this.sql.exec("DELETE FROM email_step");

		return { "ok": true, "request": { "client": row.client, "redirectUri": row.redirectUri, "state": row.state, "codeChallenge": row.codeChallenge, "jkt": row.jkt }, "address": step.address };
	}

	/**
	 * A passkey sign-in (src/passkeys.ts): the challenge the browser's passkey signs, kept until it's checked (once,
	 * whatever the outcome), for CHALLENGE_TTL. A new one replaces the last.
	 */
	public async challenged(secret: string, challenge: string): Promise<{ "ok": true } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		this.sql.exec("INSERT OR REPLACE INTO passkey_challenge (id, challenge, expires) VALUES (1, ?, ?)", challenge, Date.now() + CHALLENGE_TTL);

		return { "ok": true };
	}

	/** The passkey challenge, taken (good once), if one is out and unexpired. */
	public async takeChallenge(secret: string): Promise<{ "ok": true; "challenge": string } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		const [kept] = this.sql.exec<{ "challenge": string; "expires": number }>("SELECT challenge, expires FROM passkey_challenge WHERE id = 1").toArray();

		this.sql.exec("DELETE FROM passkey_challenge");

		return kept === undefined || kept.expires < Date.now() ? { "ok": false, "reason": "no passkey challenge" } : { "ok": true, "challenge": kept.challenge };
	}

	/** The first factor passed, for `user`, by `method` ("email", "password"): what the second (MFA, C5) finishes. */
	public async passed(secret: string, user: string, method: string): Promise<{ "ok": true } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		this.sql.exec("INSERT INTO first_factor (id, user_id, method) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, method = excluded.method", user, method);

		return { "ok": true };
	}

	/** Whom the first factor found, and how, if one passed: what the second step checks. */
	public async firstFactor(secret: string): Promise<{ "ok": true; "user": string; "method": string } | Refused> {
		const row = await this.running(secret);

		if ("reason" in row) {
			return row;
		}

		const [first] = this.sql.exec<{ "user_id": string; "method": string }>("SELECT user_id, method FROM first_factor WHERE id = 1").toArray();

		return first === undefined ? { "ok": false, "reason": "no first factor" } : { "ok": true, "user": first.user_id, "method": first.method };
	}

	/** Its time is up: nothing of it is kept. */
	public override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

// ── How a browser holds its attempt ────────────────────────────────────────────────────────────────────────────────

/** The attempt's cookie: `__Host-signin`, the attempt's id and this browser's secret. */
const COOKIE = "signin";

export const attemptOf = (context: Context<AppEnv>, id: string): DurableObjectStub<Attempt> | undefined => {
	try {
		return context.env.ATTEMPTS.get(context.env.ATTEMPTS.idFromString(id));
	} catch {
		return undefined; // not an id of ours
	}
};

/** The attempt this browser holds, from its cookie. */
export function heldAttempt(context: Context<AppEnv>): { "id": string; "secret": string; "stub": DurableObjectStub<Attempt> } | undefined {
	const [id, secret] = (getCookie(context, COOKIE, "host") ?? "").split(".");
	const stub = id === undefined || secret === undefined ? undefined : attemptOf(context, id);

	return stub === undefined ? undefined : { "id": id as string, "secret": secret as string, "stub": stub };
}

export function forgetAttempt(context: Context<AppEnv>): void {
	deleteCookie(context, COOKIE, { "path": "/", "secure": true, "prefix": "host" });
}

/** Hold attempt `id` in this browser: the cookie, `HttpOnly`, `SameSite=Lax`, for the attempt's life. */
export function holdAttempt(context: Context<AppEnv>, id: string, secret: string): void {
	setCookie(context, COOKIE, `${id}.${secret}`, { "path": "/", "secure": true, "httpOnly": true, "sameSite": "Lax", "maxAge": ATTEMPT_TTL / 1000, "prefix": "host" });
}
