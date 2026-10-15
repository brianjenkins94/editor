import type { Span } from "@brianjenkins94/util/logger";
import type { Grant } from "./grant.ts";

/** The Worker's bindings: vars and bindings from wrangler.jsonc, secrets from `wrangler secret put`. */
export interface Bindings {
	"ENVIRONMENT": string;
	/** The app origins allowed to call this API from a browser, comma-separated. */
	"ALLOWED_ORIGINS": string;
	/** The app pages a sign-in may return to, comma-separated: exact URLs, matched exactly. */
	"REDIRECT_URIS": string;
	/** Only in tests: where GitHub's web and API are, instead of github.com and api.github.com. */
	"GITHUB_ORIGIN"?: string;
	"GITHUB_API"?: string;
	/** A private JWK with `alg` and `kid`: what access tokens are signed with. */
	"SIGNING_JWK": string;
	/** The secret DPoP nonces are an HMAC under. */
	"NONCE_KEY": string;
	/** 32 random bytes, base64url: the key GitHub's tokens are sealed under in a Grant. */
	"TOKEN_KEK": string;
	/** The secret the audit log's IP hashes are keyed by (with the date). */
	"AUDIT_KEY": string;
	/** The GitHub App's client id (not secret), and its secret. */
	"GITHUB_CLIENT_ID": string;
	"GITHUB_CLIENT_SECRET": string;
	/** The key the sign-in's state is sealed under on its way through GitHub. */
	"STATE_KEY": string;
	"DB": D1Database;
	"GRANTS": DurableObjectNamespace<Grant>;
}

/** Hono's environment: the bindings, and what middleware leaves for the routes after it. */
export interface AppEnv {
	"Bindings": Bindings;
	"Variables": { "span": Span; "user": string; "grant": string };
}
