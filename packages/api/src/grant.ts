import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";
import { base64url } from "jose";
import { DurableObject } from "cloudflare:workers";
import type { Origin } from "./audit.ts";
import { audit } from "./audit.ts";
import type { Bindings } from "./env.ts";
import { seal } from "./seal.ts";

/**
 * One sign-in (README.md, "Tokens and the flow"). A Durable Object, so everything about the sign-in happens one call at a
 * time: a code redeemed once, a refresh token rotated once (and a second use of an old one caught), a proof's jti seen
 * once. It holds:
 *   - the key the sign-in is bound to (its thumbprint), from the browser's first request;
 *   - GitHub's tokens, sealed under TOKEN_KEK;
 *   - the authorization code (its hash, its PKCE challenge, 60 seconds to live) until it's redeemed;
 *   - the current refresh token's hash, and every earlier one's, for reuse detection;
 *   - the jtis of proofs it has seen, until they'd be too old anyway.
 * A sign-in whose code is never redeemed (the browser closed, the redirect lost) ends when the code would have expired:
 * an alarm revokes it, so GitHub's tokens aren't kept for a sign-in nobody finished.
 * Its id is the grant's id; codes and refresh tokens are `<grant id>.<secret>`, so the Worker knows where to send them.
 * Only hashes of them are stored.
 */

const CODE_TTL = 60_000;

/** A secret's hash as stored: base64url(SHA-256). */
const hash = s256;

/** `<grant id>.<32 random bytes>` */
function token(grantId: string): string {
	return `${grantId}.${base64url.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** GitHub's tokens for a user, as the callback gets them. */
export interface GitHubTokens {
	"accessToken": string;
	"refreshToken": string;
	"expiresAt": number;
	"refreshExpiresAt": number;
}

interface State {
	"user_id": string;
	"jkt": string;
	"code_hash": string | null;
	"code_challenge": string | null;
	"code_expires": number | null;
	"refresh_hash": string | null;
	"revoked_at": number | null;
}

export type Issued = { "ok": true; "userId": string; "refreshToken": string } | { "ok": false };

export class Grant extends DurableObject<Bindings> {
	private readonly sql = this.ctx.storage.sql;

	public constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);

		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				user_id TEXT NOT NULL,
				jkt TEXT NOT NULL,
				github TEXT,
				code_hash TEXT,
				code_challenge TEXT,
				code_expires INTEGER,
				refresh_hash TEXT,
				revoked_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS used_refresh (hash TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS seen_jti (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL);
		`);
	}

	private get id(): string {
		return this.ctx.id.toString();
	}

	private state(): State | undefined {
		return this.sql.exec<State & Record<string, SqlStorageValue>>("SELECT user_id, jkt, code_hash, code_challenge, code_expires, refresh_hash, revoked_at FROM state WHERE id = 1").toArray()[0];
	}

	/**
	 * Start the sign-in, once GitHub has said who this is: the user (made on their first sign-in), the grant's row, GitHub's
	 * tokens sealed, and a code the browser redeems at /token with its PKCE verifier and a proof from key `jkt`. This is the
	 * one call A0's GitHub callback makes.
	 */
	public async begin({ githubId, github, codeChallenge, jkt, from }: { "githubId": number; "github": GitHubTokens; "codeChallenge": string; "jkt": string; "from": Origin }): Promise<{ "code": string }> {
		if (this.state() !== undefined) {
			throw new Error("a grant begins once");
		}

		const now = Date.now();

		await this.env.DB.prepare("INSERT INTO users (id, github_id, created_at) VALUES (?, ?, ?) ON CONFLICT (github_id) DO NOTHING").bind(crypto.randomUUID(), githubId, now).run();

		const user = await this.env.DB.prepare("SELECT id FROM users WHERE github_id = ?").bind(githubId).first<{ "id": string }>();
		const userId = user?.id as string;

		await this.env.DB.prepare("INSERT INTO grants (id, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").bind(this.id, userId, now, now).run();

		const code = token(this.id);

		this.sql.exec("INSERT INTO state (id, user_id, jkt, github, code_hash, code_challenge, code_expires) VALUES (1, ?, ?, ?, ?, ?, ?)", userId, jkt, await seal(this.env.TOKEN_KEK, JSON.stringify(github), this.id), await hash(code), codeChallenge, now + CODE_TTL);
		await audit(this.env.DB, "login", { "userId": userId, "grantId": this.id }, from);
		await this.ctx.storage.setAlarm(now + CODE_TTL);

		return { "code": code };
	}

	/**
	 * Redeem the code (once: it's gone whatever the outcome, so a verifier can't be guessed at) with the PKCE verifier and
	 * a proof from the key the sign-in started with. Gives the first refresh token.
	 */
	public async redeem({ code, verifier, jkt, from }: { "code": string; "verifier": string; "jkt": string; "from": Origin }): Promise<Issued> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null || state.code_hash === null) {
			return this.reject(state, from);
		}

		this.sql.exec("UPDATE state SET code_hash = NULL, code_challenge = NULL, code_expires = NULL WHERE id = 1");

		if ((state.code_expires as number) < Date.now() || await hash(code) !== state.code_hash || await s256(verifier) !== state.code_challenge || jkt !== state.jkt) {
			return this.reject(state, from);
		}

		const refreshToken = await this.issue();

		await audit(this.env.DB, "token_issued", { "userId": state.user_id, "grantId": this.id }, from);

		return { "ok": true, "userId": state.user_id, "refreshToken": refreshToken };
	}

	/**
	 * Swap a refresh token for the next one, with a proof from the sign-in's key. An earlier one, used again, means two
	 * parties hold this sign-in's tokens: the grant is revoked.
	 */
	public async rotate({ refreshToken, jkt, from }: { "refreshToken": string; "jkt": string; "from": Origin }): Promise<Issued> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null) {
			return this.reject(state, from);
		}

		const presented = await hash(refreshToken);

		if (this.sql.exec("SELECT 1 FROM used_refresh WHERE hash = ?", presented).toArray().length > 0) {
			await audit(this.env.DB, "refresh_reuse_detected", { "userId": state.user_id, "grantId": this.id }, from);
			await this.revoke({ "from": from });

			return { "ok": false };
		}

		if (presented !== state.refresh_hash || jkt !== state.jkt) {
			return this.reject(state, from);
		}

		this.sql.exec("INSERT INTO used_refresh (hash) VALUES (?)", presented);

		const next = await this.issue();

		await this.env.DB.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").bind(Date.now(), this.id).run();
		await audit(this.env.DB, "refreshed", { "userId": state.user_id, "grantId": this.id }, from);

		return { "ok": true, "userId": state.user_id, "refreshToken": next };
	}

	/** Record a proof's jti (until `expires`), and say whether it was seen already, and whether the sign-in is live. */
	public use(jti: string, expires: number): { "seen": boolean; "active": boolean } {
		const now = Date.now();

		this.sql.exec("DELETE FROM seen_jti WHERE expires < ?", now);

		const seen = this.sql.exec("INSERT INTO seen_jti (jti, expires) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING", jti, expires).rowsWritten === 0;
		const state = this.state();

		return { "seen": seen, "active": state !== undefined && state.revoked_at === null };
	}

	/** Revoke with the current refresh token and a proof from the sign-in's key (RFC 7009, for the browser's sign-out). */
	public async revokeWith({ refreshToken, jkt, from }: { "refreshToken": string; "jkt": string; "from": Origin }): Promise<void> {
		const state = this.state();

		if (state !== undefined && state.revoked_at === null && await hash(refreshToken) === state.refresh_hash && jkt === state.jkt) {
			await this.revoke({ "from": from });
		}
	}

	/** End the sign-in: its tokens (ours and GitHub's) gone, its row marked. */
	public async revoke({ from }: { "from": Origin }): Promise<void> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null) {
			return;
		}

		const now = Date.now();

		this.sql.exec("UPDATE state SET revoked_at = ?, github = NULL, refresh_hash = NULL, code_hash = NULL WHERE id = 1", now);
		await this.env.DB.prepare("UPDATE grants SET revoked_at = ? WHERE id = ?").bind(now, this.id).run();
		await audit(this.env.DB, "grant_revoked", { "userId": state.user_id, "grantId": this.id }, from);
	}

	/** The platform's call, when the code would have expired (begin sets it). */
	public async alarm(): Promise<void> {
		await this.abandon();
	}

	/** A sign-in that never got its first refresh token is abandoned, so it ends. */
	public async abandon(): Promise<void> {
		const state = this.state();

		if (state !== undefined && state.revoked_at === null && state.refresh_hash === null) {
			await this.revoke({ "from": { "country": null, "ipHash": null } });
		}
	}

	private async issue(): Promise<string> {
		const refreshToken = token(this.id);

		this.sql.exec("UPDATE state SET refresh_hash = ? WHERE id = 1", await hash(refreshToken));

		return refreshToken;
	}

	private async reject(state: State | undefined, from: Origin): Promise<Issued> {
		await audit(this.env.DB, "token_rejected", { "userId": state?.user_id, "grantId": state === undefined ? null : this.id }, from);

		return { "ok": false };
	}
}
