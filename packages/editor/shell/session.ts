/**
 * Signing in with GitHub — the shell's side of packages/api (its README.md has the design). The browser never holds a
 * GitHub token: it holds OUR tokens, DPoP-bound to a key it can't export, and reaches GitHub through the API's proxy.
 *
 * - A non-extractable ES256 key, made once and kept in IndexedDB: every request to the API carries a proof signed with it,
 *   so a copied token is useless anywhere else.
 * - Signing in is a full-page round trip (the shell is cross-origin isolated, which a popup's opener can't survive):
 *   `signIn` goes to the API's /auth/github/start with a PKCE challenge, the key's thumbprint and a state, and
 *   `completeSignIn`, on the way back, checks that state and the API's `iss`, and redeems the code for tokens.
 * - `dpopFetch` is a `fetch` that sends our access token and a proof, retries a nonce the API asks for, and refreshes the
 *   token (one refresh at a time, however many requests found it stale). It's the AuthProvider github.ts and the clone use.
 *
 * Shell-side only: the key and the tokens live in the top frame's storage, and no other realm gets a client.
 */
import * as oauth from "oauth4webapi";

/** The API (packages/api), deployed for development. Production gets its own (A7). */
export const API = "https://editor-api-dev.brianjenkins94.workers.dev";

/** The pages the API will send a sign-in back to (its REDIRECT_URIS, wrangler.jsonc): sign-in is offered only on these. */
const PAGES = ["https://brianjenkins94.github.io/editor/", "http://localhost:5173/", "http://editor.localhost:5173/"];

const as: oauth.AuthorizationServer = {
	"issuer": API,
	"authorization_endpoint": `${API}/auth/github/start`,
	"token_endpoint": `${API}/token`,
	"revocation_endpoint": `${API}/revoke`,
	"authorization_response_iss_parameter_supported": true
};

const client: oauth.Client = { "client_id": "editor" };

const none = oauth.None();

const TOKENS = "shell:session";

const PENDING = "shell:signIn";

/** This page, as a redirect URI: no query, no fragment. */
const page = (): string => location.origin + location.pathname;

export function canSignIn(): boolean {
	return PAGES.includes(page());
}

// ── The key ─────────────────────────────────────────────────────────────────────────────────────────────────────

const DB = "editor-session";

const STORE = "keys";

function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1);

		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => {
			resolve(request.result);
		};
		request.onerror = () => {
			reject(request.error ?? new Error("IndexedDB wouldn't open"));
		};
	});
}

async function keys<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | undefined): Promise<T> {
	const db = await database();

	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		const request = run(transaction.objectStore(STORE));

		transaction.oncomplete = () => {
			resolve(request?.result as T);
		};
		transaction.onerror = () => {
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		};
	});
}

let keyPair: Promise<CryptoKeyPair> | undefined;

/** The DPoP key: the stored one, or a new non-extractable one stored. */
function key(): Promise<CryptoKeyPair> {
	keyPair ??= (async () => {
		const stored = await keys<CryptoKeyPair | undefined>("readonly", (store) => store.get("dpop"));

		if (stored !== undefined) {
			return stored;
		}

		const made = await oauth.generateKeyPair("ES256", { "extractable": false });

		await keys("readwrite", (store) => store.put(made, "dpop"));

		return made;
	})();

	return keyPair;
}

/** RFC 7638's thumbprint of the key's public half: what the API binds the sign-in to (`dpop_jkt`). */
async function thumbprint(publicKey: CryptoKey): Promise<string> {
	const { crv, kty, x, y } = await crypto.subtle.exportKey("jwk", publicKey);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })));

	return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** One DPoP handle for the session: it remembers the API's nonce, so it's asked for once, not on every request. */
let handle: Promise<oauth.DPoPHandle> | undefined;

function dpop(): Promise<oauth.DPoPHandle> {
	handle ??= key().then((pair) => oauth.DPoP(client, pair));

	return handle;
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Tokens { "accessToken": string; "refreshToken": string }

function stored(): Tokens | undefined {
	try {
		const raw = localStorage.getItem(TOKENS);

		return raw === null ? undefined : JSON.parse(raw) as Tokens;
	} catch {
		return undefined;
	}
}

function store(tokens: oauth.TokenEndpointResponse | undefined): void {
	try {
		if (tokens === undefined || tokens.refresh_token === undefined) {
			localStorage.removeItem(TOKENS);
		} else {
			localStorage.setItem(TOKENS, JSON.stringify({ "accessToken": tokens.access_token, "refreshToken": tokens.refresh_token }));
		}
	} catch {
		/* storage off (private mode): signed in for this page only */
	}
}

export function isSignedIn(): boolean {
	return stored() !== undefined;
}

/** A token-endpoint call, retried once when the API asks for its nonce (the handle has it from the first answer). */
async function withNonce<T>(request: () => Promise<Response>, process: (response: Response) => Promise<T>): Promise<T> {
	try {
		return await process(await request());
	} catch (error) {
		if (oauth.isDPoPNonceError(error)) {
			return process(await request());
		}

		throw error;
	}
}

// ── Signing in and out ──────────────────────────────────────────────────────────────────────────────────────────

/** Off to GitHub, through the API. Where we were (its query and fragment too) is restored when we're back. */
export async function signIn(): Promise<void> {
	const verifier = oauth.generateRandomCodeVerifier();
	const state = oauth.generateRandomState();
	const url = new URL(as.authorization_endpoint as string);

	url.search = new URLSearchParams({
		"client_id": client.client_id,
		"response_type": "code",
		"redirect_uri": page(),
		"state": state,
		"code_challenge": await oauth.calculatePKCECodeChallenge(verifier),
		"code_challenge_method": "S256",
		"dpop_jkt": await thumbprint((await key()).publicKey)
	}).toString();

	sessionStorage.setItem(PENDING, JSON.stringify({ "verifier": verifier, "state": state, "returnTo": location.href }));
	location.assign(url.href);
}

/**
 * On load: if this page is the end of a sign-in (its state in the URL, ours pending), check it and redeem the code. The
 * URL goes back to where the sign-in started either way. Throws when the sign-in came back refused or invalid.
 */
export async function completeSignIn(): Promise<boolean> {
	const raw = sessionStorage.getItem(PENDING);
	const here = new URL(location.href);

	if (raw === null || !here.searchParams.has("state")) {
		return false;
	}

	sessionStorage.removeItem(PENDING);

	const pending = JSON.parse(raw) as { "verifier": string; "state": string; "returnTo": string };

	history.replaceState(history.state, "", pending.returnTo);

	// Checks the state is ours and `iss` is the API (RFC 9207), and turns `error=` into a thrown error.
	const parameters = oauth.validateAuthResponse(as, client, here, pending.state);
	const tokens = await withNonce(
		async () => oauth.authorizationCodeGrantRequest(as, client, none, parameters, page(), pending.verifier, { "DPoP": await dpop() }),
		async (response) => oauth.processAuthorizationCodeResponse(as, client, response)
	);

	store(tokens);

	return true;
}

/** Forget the session in this browser: our tokens, and the key (the next sign-in makes one). Nothing is asked of the API. */
async function forget(): Promise<void> {
	store(undefined);
	keyPair = undefined;
	handle = undefined;
	await keys("readwrite", (store) => store.delete("dpop")).catch(() => undefined);
}

/** Forget the session here, and end it at the API (which ends GitHub's token too). The key goes; the next sign-in makes one. */
export async function signOut(): Promise<void> {
	const tokens = stored();

	store(undefined);

	if (tokens !== undefined) {
		// RFC 7009 has no DPoP, but our /revoke wants a proof from the sign-in's key: sent as a resource request.
		const revoke = async (): Promise<Response> => oauth.protectedResourceRequest(tokens.accessToken, "POST", new URL(as.revocation_endpoint as string), new Headers({ "content-type": "application/x-www-form-urlencoded" }), new URLSearchParams({ "token": tokens.refreshToken }).toString(), { "DPoP": await dpop() }).catch((error: unknown) => (error instanceof oauth.WWWAuthenticateChallengeError ? error.response : Response.error()));

		if ((await revoke()).status === 400) {
			await revoke();
		}
	}

	await forget();
}

// ── Your sessions and your account (packages/api/src/account.ts) ────────────────────────────────────────────────

export interface Session { "id": string; "current": boolean; "label": string | null; "createdAt": number; "lastUsedAt": number }

/** One of the account calls: the API's JSON answer, or what went wrong. */
async function account<T>(path: string, form?: Record<string, string>): Promise<T> {
	const response = await dpopFetch(`${API}${path}`, form === undefined ? {} : { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(form).toString() });

	if (!response.ok) {
		throw new Error(`${path}: ${response.status}`);
	}

	return response.json() as Promise<T>;
}

/** Where you're signed in, the most recently used first; this browser's marked `current`. */
export async function sessions(): Promise<Session[]> {
	return (await account<{ "sessions": Session[] }>("/sessions")).sessions;
}

/** End one of your other sessions (this one's is `signOut`). */
export async function endSession(id: string): Promise<void> {
	await account(`/sessions/${id}/revoke`, {});
}

/** End every session you have, this one included. */
export async function signOutEverywhere(): Promise<void> {
	await account("/sessions/revoke-all", {});
	await forget();
}

/** Delete the account: at GitHub too (the app's authorization), every session, and everything that points at you. */
export async function deleteAccount(): Promise<{ "githubAuthorizationRevoked": boolean }> {
	const answer = await account<{ "githubAuthorizationRevoked": boolean }>("/account/delete", { "confirm": "delete" });

	await forget();

	return answer;
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────────────────────

let refreshing: Promise<boolean> | undefined;

/** One refresh, however many requests found the access token stale. */
function refresh(): Promise<boolean> {
	refreshing ??= (async () => {
		const tokens = stored();

		if (tokens === undefined) {
			return false;
		}

		store(await withNonce(
			async () => oauth.refreshTokenGrantRequest(as, client, none, tokens.refreshToken, { "DPoP": await dpop() }),
			async (response) => oauth.processRefreshTokenResponse(as, client, response)
		));

		return true;
	})().catch(() => false).finally(() => {
		refreshing = undefined;
	});

	return refreshing;
}

/** One request with our access token and a proof (a nonce the API asks for, retried): the API's answer, whatever it is. */
async function send(url: URL, method: string, headers: Headers, body: oauth.ProtectedResourceRequestBody | undefined): Promise<Response> {
	const tokens = stored();

	if (tokens === undefined) {
		return new Response(JSON.stringify({ "error": "not signed in" }), { "status": 401 });
	}

	const request = async (): Promise<Response> => oauth.protectedResourceRequest(tokens.accessToken, method, url, headers, body, { "DPoP": await dpop() });

	for (let attempt = 0; ; attempt += 1) {
		try {
			return await request();
		} catch (error) {
			if (attempt === 0 && oauth.isDPoPNonceError(error)) {
				continue;
			}

			if (error instanceof oauth.WWWAuthenticateChallengeError) {
				return error.response;
			}

			throw error;
		}
	}
}

/** Signed-out, or the session ended (revoked, or GitHub refused to refresh it): the shell shows signed-out. */
export const SIGNED_OUT = "shell:signedOut";

/**
 * A `fetch` for the API (the AuthProvider for github.ts and the clone): our token and a proof on every request; a stale
 * token refreshed once and the request retried; a session that can't be refreshed forgotten, and SIGNED_OUT dispatched.
 */
export const dpopFetch: typeof fetch = async (input, init = {}) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = init.method ?? (input instanceof Request ? input.method : "GET");
	const headers = new Headers(init.headers);
	const body = (init.body ?? undefined) as oauth.ProtectedResourceRequestBody | undefined;
	let response = await send(url, method, headers, body);

	if (response.status === 401 && isSignedIn()) {
		response = await refresh() ? await send(url, method, headers, body) : response;

		if (response.status === 401) {
			store(undefined);
			window.dispatchEvent(new CustomEvent(SIGNED_OUT));
		}
	}

	return response;
};
