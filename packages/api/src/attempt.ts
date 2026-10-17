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

export class Attempt extends DurableObject<Bindings> {
	private readonly sql = this.ctx.storage.sql;

	public constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);

		this.sql.exec(`CREATE TABLE IF NOT EXISTS attempt (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			client TEXT NOT NULL, redirectUri TEXT NOT NULL, state TEXT NOT NULL, codeChallenge TEXT NOT NULL, jkt TEXT NOT NULL,
			pushed_at INTEGER NOT NULL, opened_at INTEGER, secret_hash TEXT, finished_at INTEGER
		)`);
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

	/** Its time is up: nothing of it is kept. */
	public override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
