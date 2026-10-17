import { accessTokenHash as hash } from "@brianjenkins94/util/auth/dpop";
import { base64url } from "jose";
import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env.ts";

/**
 * A sign-in in progress (SIGN-IN.md, "An attempt holds a sign-in in progress"): one Durable Object per attempt, made by
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
CREATE TABLE IF NOT EXISTS email_step (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	address TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries REAL NOT NULL, tries_at INTEGER NOT NULL
)`;

/** An emailed code's life, and the tries at it: a bucket of TRIES, one back each TRY_REFILL (SIGN-IN.md, "Email"). */
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
	 * Try a code (its HMAC): one try from the bucket, then it must be this attempt's latest, unexpired. A match ends the
	 * attempt, once, with its request and the address the code went to; a code is good once.
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

		this.sql.exec("UPDATE attempt SET finished_at = ? WHERE id = 1", now);
		this.sql.exec("DELETE FROM email_step");

		return { "ok": true, "request": { "client": row.client, "redirectUri": row.redirectUri, "state": row.state, "codeChallenge": row.codeChallenge, "jkt": row.jkt }, "address": step.address };
	}

	/** Its time is up: nothing of it is kept. */
	public override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
