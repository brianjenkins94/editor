import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";
import { open, seal } from "@brianjenkins94/util/auth/seal";
import { base64url } from "jose";
import { DurableObject } from "cloudflare:workers";
import type { Origin } from "./audit.ts";
import { audit, NOWHERE } from "./audit.ts";
import type { Difference, Fingerprint } from "./behavior.ts";
import { clientKind, differences, gapOf, learn, START } from "./behavior.ts";
import type { Bindings } from "./env.ts";
import { github as githubOrigins } from "./github.ts";

/**
 * One sign-in (README.md, "Tokens and the flow"). A Durable Object, so everything about the sign-in happens one call at a
 * time: a code redeemed once, a refresh token rotated once (and a second use of an old one caught), a proof's jti seen
 * once. It holds:
 *   - the key the sign-in is bound to (its thumbprint), from the browser's first request;
 *   - GitHub's tokens, sealed under TOKEN_KEK;
 *   - the authorization code (its hash, its PKCE challenge, 60 seconds to live) until it's redeemed;
 *   - the current refresh token's hash, and every earlier one's, for reuse detection;
 *   - the jtis of proofs it has seen, until they'd be too old anyway;
 *   - its client's fingerprint (BEHAVIOR.md: which headers it sent, keyed hashes of them), from the code's redemption,
 *     and how often each header has differed since, and how;
 *   - its last action and the transitions since its last flush (BEHAVIOR.md, B8), added to the shared model hourly.
 * A sign-in whose code is never redeemed (the browser closed, the redirect lost) ends when the code would have expired:
 * an alarm revokes it, so GitHub's tokens aren't kept for a sign-in nobody finished.
 * GitHub's token is spent here, for the proxy (src/proxy.ts), and refreshed here, one refresh at a time: GitHub's refresh
 * tokens work once, so two requests refreshing together would end the sign-in.
 * Its id is the grant's id; codes and refresh tokens are `<grant id>.<secret>`, so the Worker knows where to send them.
 * Only hashes of them are stored.
 */

const CODE_TTL = 60_000;

/** How often a sign-in's transitions are added to the shared model (learn()), batched. */
const FLUSH_EVERY = 60 * 60_000;

/** At most this many proxied requests in flight for one sign-in (lease()): GitHub's secondary rate limits punish a token's
 *  concurrent requests, and a burst of large clones is the shape a scripted session takes. */
const CONCURRENT = 8;

/** A lease returns itself when GitHub's answer has streamed; this frees one whose connection dropped first. */
const LEASE_TTL = 120_000;

/** This many proxy refusals within DENIAL_WINDOW end the sign-in (denied()). */
const DENIALS = 5;

const DENIAL_WINDOW = 10 * 60_000;

/** GitHub's token is refreshed when it has less than this left. */
const REFRESH_MARGIN = 5 * 60_000;

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
	/** The OAuth client the sign-in is for (REDIRECT_URIS' keys). Null for grants from before clients: the editor's. */
	"client": string | null;
}

/** A grant that predates clients was the editor's: the only client there was. */
const clientOf = (state: State): string => state.client ?? "editor";

/** What a Grant keeps, table by table (the admin app's architecture page lists them from here). */
export const SCHEMA = `
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
	CREATE TABLE IF NOT EXISTS denials (at INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS fingerprint (name TEXT PRIMARY KEY, value TEXT);
	CREATE TABLE IF NOT EXISTS walk (id INTEGER PRIMARY KEY CHECK (id = 1), action TEXT NOT NULL, at INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS pending (from_action TEXT NOT NULL, to_action TEXT NOT NULL, gap INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (from_action, to_action, gap));
	CREATE TABLE IF NOT EXISTS differences (name TEXT NOT NULL, kind TEXT NOT NULL, strength TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (name, kind, strength));
`;

export type Issued = { "ok": true; "userId": string; "refreshToken": string; "client": string } | { "ok": false };

export class Grant extends DurableObject<Bindings> {
	private readonly sql = this.ctx.storage.sql;

	public constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);

		this.schema();
	}

	private schema(): void {
		this.sql.exec(SCHEMA);

		// Added with the admin client (packages/admin): the grants that began before it have none, and are the editor's.
		if (!this.sql.exec<{ "name": string }>("PRAGMA table_info(state)").toArray().some((column) => column.name === "client")) {
			this.sql.exec("ALTER TABLE state ADD COLUMN client TEXT");
		}
	}

	private get id(): string {
		return this.ctx.id.toString();
	}

	private state(): State | undefined {
		return this.sql.exec<State & Record<string, SqlStorageValue>>("SELECT user_id, jkt, code_hash, code_challenge, code_expires, refresh_hash, revoked_at, client FROM state WHERE id = 1").toArray()[0];
	}

	/**
	 * Start the sign-in, once a method has said who this is: by GitHub (`githubId`, the user made on their first sign-in,
	 * and GitHub's tokens, sealed), or by another method that found or made its user (`userId`: an emailed code, C2). Then
	 * the grant's row, and a code the browser redeems at /token with its PKCE verifier and a proof from key `jkt`. The
	 * `login` row says which method. `client` is the OAuth client it's for: only that client can redeem the code and
	 * refresh what it gives.
	 */
	public async begin({ client = "editor", githubId, userId: known, github, method = "github", codeChallenge, jkt, from, label }: { "client"?: string; "githubId"?: number; "userId"?: string; "github"?: GitHubTokens; "method"?: string; "codeChallenge": string; "jkt": string; "from": Origin; "label"?: string }): Promise<{ "code": string }> {
		if (this.state() !== undefined) {
			throw new Error("a grant begins once");
		}

		const now = Date.now();

		// GitHub's sign-in names its user by GitHub's id (made on their first sign-in); another method has found its user.
		if (githubId !== undefined) {
			await this.env.DB.prepare("INSERT INTO users (id, github_id, created_at) VALUES (?, ?, ?) ON CONFLICT (github_id) DO NOTHING").bind(crypto.randomUUID(), githubId, now).run();
		}

		const user = githubId === undefined
			? await this.env.DB.prepare("SELECT id, deleted_at FROM users WHERE id = ?").bind(known ?? "").first<{ "id": string; "deleted_at": number | null }>()
			: await this.env.DB.prepare("SELECT id, deleted_at FROM users WHERE github_id = ?").bind(githubId).first<{ "id": string; "deleted_at": number | null }>();

		if (user === null) {
			throw new Error("a grant begins for a user");
		}

		const userId = user.id;

		// Signing in again within the grace period of a deletion restores the account (account.ts, GRACE_DAYS).
		if (user.deleted_at !== null) {
			await this.env.DB.prepare("UPDATE users SET deleted_at = NULL WHERE id = ?").bind(userId).run();
			await audit(this.env, "account_restored", { "userId": userId, "grantId": this.id }, from, { "reason": "signed in within the grace period" });
		}

		await this.env.DB.prepare("INSERT INTO grants (id, user_id, created_at, last_used_at, label, client) VALUES (?, ?, ?, ?, ?, ?)").bind(this.id, userId, now, now, label ?? null, client).run();

		const code = token(this.id);

		this.sql.exec("INSERT INTO state (id, user_id, jkt, github, code_hash, code_challenge, code_expires, client) VALUES (1, ?, ?, ?, ?, ?, ?, ?)", userId, jkt, github === undefined ? null : await seal(this.env.TOKEN_KEK, JSON.stringify(github), this.id), await hash(code), codeChallenge, now + CODE_TTL, client);
		await audit(this.env, "login", { "userId": userId, "grantId": this.id }, from, { "reason": method });
		await this.ctx.storage.setAlarm(now + CODE_TTL);

		return { "code": code };
	}

	/**
	 * Redeem the code (once: it's gone whatever the outcome, so a verifier can't be guessed at) with the PKCE verifier and
	 * a proof from the key the sign-in started with, by the client it started for. Gives the first refresh token.
	 */
	public async redeem({ code, verifier, jkt, client, from, print }: { "code": string; "verifier": string; "jkt": string; "client": string; "from": Origin; "print"?: Fingerprint }): Promise<Issued> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null || state.code_hash === null) {
			return this.reject(state, from, state?.revoked_at === null ? "code already used" : "grant revoked");
		}

		this.sql.exec("UPDATE state SET code_hash = NULL, code_challenge = NULL, code_expires = NULL WHERE id = 1");

		const refused = (state.code_expires as number) < Date.now() ? "code expired"
			: await hash(code) !== state.code_hash ? "code unknown"
				: await s256(verifier) !== state.code_challenge ? "PKCE verifier"
					: jkt !== state.jkt ? "another key"
						: client !== clientOf(state) ? "another client" : undefined;

		if (refused !== undefined) {
			return this.reject(state, from, refused);
		}

		const refreshToken = await this.issue();

		await audit(this.env, "token_issued", { "userId": state.user_id, "grantId": this.id }, from);

		// The client as it is now is the one this sign-in is known by. One that isn't a browser is a script signing in
		// for itself: recorded, by what it didn't send.
		if (print !== undefined) {
			this.remember(print);

			const kind = clientKind(print);

			if (kind.kind === "other") {
				await audit(this.env, "client_unusual", { "userId": state.user_id, "grantId": this.id }, from, { "reason": `not a browser: no ${kind.missing.join(", no ")}` });
			}
		}

		return { "ok": true, "userId": state.user_id, "refreshToken": refreshToken, "client": clientOf(state) };
	}

	/**
	 * Swap a refresh token for the next one, with a proof from the sign-in's key, by the client it's for. An earlier one,
	 * used again, means two parties hold this sign-in's tokens: the grant is revoked.
	 */
	public async rotate({ refreshToken, jkt, client, from, print }: { "refreshToken": string; "jkt": string; "client": string; "from": Origin; "print"?: Fingerprint }): Promise<Issued> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null) {
			return this.reject(state, from, "grant revoked");
		}

		const presented = await hash(refreshToken);

		if (this.sql.exec("SELECT 1 FROM used_refresh WHERE hash = ?", presented).toArray().length > 0) {
			await audit(this.env, "refresh_reuse_detected", { "userId": state.user_id, "grantId": this.id }, from);
			await this.revoke({ "from": from });

			return { "ok": false };
		}

		if (presented !== state.refresh_hash || jkt !== state.jkt || client !== clientOf(state)) {
			return this.reject(state, from, presented !== state.refresh_hash ? "refresh token unknown" : jkt !== state.jkt ? "another key" : "another client");
		}

		this.sql.exec("INSERT INTO used_refresh (hash) VALUES (?)", presented);

		const next = await this.issue();

		await this.env.DB.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").bind(Date.now(), this.id).run();
		await audit(this.env, "refreshed", { "userId": state.user_id, "grantId": this.id }, from);

		// Refreshing takes the sign-in's key, so this is still its client: what's tolerated about how it differs now (a
		// header added, the browser updated) becomes how it's known.
		const known = this.known();

		if (print !== undefined && known !== undefined) {
			const tolerated = differences(known, print).filter((difference) => difference.strength === "tolerated");

			for (const { name } of tolerated) {
				this.sql.exec("INSERT INTO fingerprint (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", name, print[name] ?? null);
			}
		}

		return { "ok": true, "userId": state.user_id, "refreshToken": next, "client": clientOf(state) };
	}

	/**
	 * Record a proof's jti (until `expires`), and say whether it was seen already, and whether the sign-in is live. Every
	 * request's proof comes here, so its client's `print` is compared here too (BEHAVIOR.md): each way a header differs
	 * from how the sign-in's client is known is counted (by how much it matters, so a tolerated change doesn't hide a later
	 * one that matters), and the ones that matter are handed back the first time, for the Worker to record.
	 */
	public async use(jti: string, expires: number, { print, action }: { "print"?: Fingerprint; "action"?: string } = {}): Promise<{ "seen": boolean; "active": boolean; "changed": Difference[] }> {
		const now = Date.now();

		this.sql.exec("DELETE FROM seen_jti WHERE expires < ?", now);

		const seen = this.sql.exec("INSERT INTO seen_jti (jti, expires) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING", jti, expires).rowsWritten === 0;
		const state = this.state();
		const active = state !== undefined && state.revoked_at === null;
		const known = this.known();
		const changed: Difference[] = [];

		if (active && !seen && print !== undefined && known !== undefined) {
			for (const difference of differences(known, print)) {
				const [{ "count": count } = { "count": 0 }] = this.sql.exec<{ "count": number }>("INSERT INTO differences (name, kind, strength, count) VALUES (?, ?, ?, 1) ON CONFLICT (name, kind, strength) DO UPDATE SET count = count + 1 RETURNING count", difference.name, difference.kind, difference.strength).toArray();

				if (count === 1 && difference.strength !== "tolerated") {
					changed.push(difference);
				}
			}
		}

		if (active && !seen && action !== undefined) {
			await this.step(action, now);
		}

		return { "seen": seen, "active": active, "changed": changed };
	}

	/** The sign-in took `action`: the transition from its last one counted, to be added to the model at the next flush. */
	private async step(action: string, now: number): Promise<void> {
		const [last] = this.sql.exec<{ "action": string; "at": number }>("SELECT action, at FROM walk WHERE id = 1").toArray();

		this.sql.exec("INSERT INTO pending (from_action, to_action, gap, count) VALUES (?, ?, ?, 1) ON CONFLICT (from_action, to_action, gap) DO UPDATE SET count = count + 1", last?.action ?? START, action, last === undefined ? 0 : gapOf(now - last.at));
		this.sql.exec("INSERT INTO walk (id, action, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET action = excluded.action, at = excluded.at", action, now);

		if (await this.ctx.storage.getAlarm() === null) {
			await this.ctx.storage.setAlarm(now + FLUSH_EVERY);
		}
	}

	/** Add the transitions since the last flush to the shared model, scoring them first (learn()). The alarm's, hourly;
	 *  public for the tests (alarm() is reserved over RPC). Says how many were scored. */
	public async flush(): Promise<number> {
		const pending = this.sql.exec<{ "from_action": string; "to_action": string; "gap": number; "count": number }>("SELECT from_action, to_action, gap, count FROM pending").toArray();
		const scored = await learn(this.env.DB, this.id, pending.map((row) => ({ "from": row.from_action, "to": row.to_action, "gap": row.gap, "count": row.count })));

		this.sql.exec("DELETE FROM pending");

		return scored;
	}

	/** How this sign-in's client is known: its fingerprint, once the code has been redeemed. */
	private known(): Fingerprint | undefined {
		const rows = this.sql.exec<{ "name": string; "value": string | null }>("SELECT name, value FROM fingerprint").toArray();

		return rows.length === 0 ? undefined : Object.fromEntries(rows.map((row) => [row.name, row.value]));
	}

	private remember(print: Fingerprint): void {
		this.sql.exec("DELETE FROM fingerprint");

		for (const [name, value] of Object.entries(print)) {
			this.sql.exec("INSERT INTO fingerprint (name, value) VALUES (?, ?)", name, value);
		}
	}

	/** Revoke with the current refresh token and a proof from the sign-in's key (RFC 7009, for the browser's sign-out). */
	public async revokeWith({ refreshToken, jkt, from }: { "refreshToken": string; "jkt": string; "from": Origin }): Promise<void> {
		const state = this.state();

		if (state !== undefined && state.revoked_at === null && await hash(refreshToken) === state.refresh_hash && jkt === state.jkt) {
			await this.revoke({ "from": from });
		}
	}

	/**
	 * GitHub's token for this sign-in, refreshed first when it's close to expiring; undefined once the sign-in is over. A
	 * refresh GitHub refuses (its refresh token expired, or the user revoked the app) ends the sign-in; one GitHub didn't
	 * answer just fails this request. Null for a sign-in that never had one (by email or a password, C2–C3): it isn't
	 * over, it just can't reach GitHub.
	 */
	public async githubToken(): Promise<string | null | undefined> {
		let token: string | null | undefined;

		// Nothing else reaches this object while a refresh is out: a second one would spend the same refresh token.
		await this.ctx.blockConcurrencyWhile(async () => {
			try {
				token = await this.currentGithubToken();
			} catch {
				token = undefined;
			}
		});

		return token;
	}

	private async currentGithubToken(): Promise<string | null | undefined> {
		const [row] = this.sql.exec<{ "github": string | null; "revoked_at": number | null; "user_id": string }>("SELECT github, revoked_at, user_id FROM state WHERE id = 1").toArray();

		if (row === undefined || row.revoked_at !== null) {
			return undefined;
		}

		if (row.github === null) {
			return null;
		}

		const current = JSON.parse(await open(this.env.TOKEN_KEK, row.github, this.id)) as GitHubTokens;

		if (current.expiresAt - REFRESH_MARGIN > Date.now()) {
			return current.accessToken;
		}

		const refreshed = await fetch(`${githubOrigins(this.env).web}/login/oauth/access_token`, {
			"method": "POST",
			"headers": { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
			"body": new URLSearchParams({ "client_id": this.env.GITHUB_CLIENT_ID, "client_secret": this.env.GITHUB_CLIENT_SECRET, "grant_type": "refresh_token", "refresh_token": current.refreshToken })
		}).then((response) => response.json() as Promise<{ "access_token"?: string; "refresh_token"?: string; "expires_in"?: number; "refresh_token_expires_in"?: number; "error"?: string }>);

		if (typeof refreshed.access_token !== "string" || typeof refreshed.refresh_token !== "string") {
			await audit(this.env, "github_refresh_refused", { "userId": row.user_id, "grantId": this.id }, NOWHERE);
			await this.revoke({ "from": NOWHERE });

			return undefined;
		}

		const now = Date.now();
		const next: GitHubTokens = { "accessToken": refreshed.access_token, "refreshToken": refreshed.refresh_token, "expiresAt": now + (refreshed.expires_in ?? 28_800) * 1000, "refreshExpiresAt": now + (refreshed.refresh_token_expires_in ?? 15_897_600) * 1000 };

		this.sql.exec("UPDATE state SET github = ? WHERE id = 1", await seal(this.env.TOKEN_KEK, JSON.stringify(next), this.id));

		return next.accessToken;
	}

	/** End the sign-in: its tokens (ours and GitHub's) gone, its row marked. GitHub's token is revoked at GitHub too. */
	public async revoke({ from, reason }: { "from": Origin; "reason"?: string }): Promise<void> {
		const state = this.state();

		if (state === undefined || state.revoked_at !== null) {
			return;
		}

		const now = Date.now();
		const [sealed] = this.sql.exec<{ "github": string | null }>("SELECT github FROM state WHERE id = 1").toArray();

		if (sealed?.github !== null && sealed?.github !== undefined) {
			// Best effort: ours is wiped below whatever GitHub says, and a token GitHub doesn't revoke expires on its own.
			try {
				const { accessToken } = JSON.parse(await open(this.env.TOKEN_KEK, sealed.github, this.id)) as GitHubTokens;

				await fetch(`${githubOrigins(this.env).api}/applications/${this.env.GITHUB_CLIENT_ID}/token`, {
					"method": "DELETE",
					"headers": { "authorization": `Basic ${btoa(`${this.env.GITHUB_CLIENT_ID}:${this.env.GITHUB_CLIENT_SECRET}`)}`, "accept": "application/vnd.github+json", "user-agent": "editor-api", "content-type": "application/json" },
					"body": JSON.stringify({ "access_token": accessToken })
				});
			} catch {
				/* GitHub unreachable: the token runs out by itself */
			}
		}

		this.sql.exec("UPDATE state SET revoked_at = ?, github = NULL, refresh_hash = NULL, code_hash = NULL WHERE id = 1", now);
		await this.env.DB.prepare("UPDATE grants SET revoked_at = ? WHERE id = ?").bind(now, this.id).run();
		await audit(this.env, "grant_revoked", { "userId": state.user_id, "grantId": this.id }, from, reason === undefined ? {} : { "reason": reason });
	}

	/**
	 * The proxy refused this sign-in a call the editor never makes, or it asked for a route that doesn't exist (a probe).
	 * A few in a short while is a session probing — a compromised one, or someone scripting it — so it ends. Says whether
	 * it did.
	 */
	public async denied({ from }: { "from": Origin }): Promise<boolean> {
		const now = Date.now();

		this.sql.exec("DELETE FROM denials WHERE at < ?", now - DENIAL_WINDOW);
		this.sql.exec("INSERT INTO denials (at) VALUES (?)", now);

		const [{ "count": count } = { "count": 0 }] = this.sql.exec<{ "count": number }>("SELECT COUNT(*) AS count FROM denials").toArray();
		const state = this.state();

		if (count < DENIALS || state === undefined || state.revoked_at !== null) {
			return false;
		}

		await audit(this.env, "proxy_abuse", { "userId": state.user_id, "grantId": this.id }, from, { "reason": `${count} refused calls in ${DENIAL_WINDOW / 60_000} minutes` });
		await this.revoke({ "from": from });

		return true;
	}

	/**
	 * Revoke the GitHub App's authorization for this sign-in's user, at GitHub (DELETE /applications/{client_id}/grant):
	 * every token GitHub gave the app for them stops working, and signing in again asks them to authorize it again. Says
	 * whether GitHub confirmed it; it needs a GitHub token that still works, so a sign-in GitHub won't refresh can't.
	 */
	public async deauthorize(): Promise<boolean> {
		const token = await this.githubToken();

		if (token === undefined || token === null) {
			return false;
		}

		try {
			const response = await fetch(`${githubOrigins(this.env).api}/applications/${this.env.GITHUB_CLIENT_ID}/grant`, {
				"method": "DELETE",
				"headers": { "authorization": `Basic ${btoa(`${this.env.GITHUB_CLIENT_ID}:${this.env.GITHUB_CLIENT_SECRET}`)}`, "accept": "application/vnd.github+json", "user-agent": "editor-api", "content-type": "application/json" },
				"body": JSON.stringify({ "access_token": token })
			});

			return response.status === 204;
		} catch {
			return false;
		}
	}

	/** For an account's purge (account.ts): the sign-in ended, then everything this object kept erased. Its tables are made again, empty,
	 *  so a token still in someone's hands meets a sign-in that's over rather than an error. */
	public async forget({ from }: { "from": Origin }): Promise<void> {
		await this.revoke({ "from": from, "reason": "account deleted" });
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.schema();
	}

	/** A slot for one proxied request, if fewer than CONCURRENT are in flight; release() it when the answer has streamed. */
	public lease(): string | undefined {
		const now = Date.now();

		this.sql.exec("DELETE FROM leases WHERE expires < ?", now);

		const [{ "count": count } = { "count": 0 }] = this.sql.exec<{ "count": number }>("SELECT COUNT(*) AS count FROM leases").toArray();

		if (count >= CONCURRENT) {
			return undefined;
		}

		const id = crypto.randomUUID();

		this.sql.exec("INSERT INTO leases (id, expires) VALUES (?, ?)", id, now + LEASE_TTL);

		return id;
	}

	public release(id: string): void {
		this.sql.exec("DELETE FROM leases WHERE id = ?", id);
	}

	/** The platform's call: when the code would have expired (begin sets it), and hourly while there's something to
	 *  flush (step sets it). */
	public async alarm(): Promise<void> {
		await this.abandon();
		await this.flush();
	}

	/** A sign-in that never got its first refresh token is abandoned, so it ends. */
	public async abandon(): Promise<void> {
		const state = this.state();

		if (state !== undefined && state.revoked_at === null && state.refresh_hash === null) {
			await this.revoke({ "from": NOWHERE });
		}
	}

	private async issue(): Promise<string> {
		const refreshToken = token(this.id);

		this.sql.exec("UPDATE state SET refresh_hash = ? WHERE id = 1", await hash(refreshToken));

		return refreshToken;
	}

	private async reject(state: State | undefined, from: Origin, reason: string): Promise<Issued> {
		await audit(this.env, "token_rejected", { "userId": state?.user_id, "grantId": state === undefined ? null : this.id }, from, { "reason": reason });

		return { "ok": false };
	}
}
