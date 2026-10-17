import type { Span } from "@brianjenkins94/util/logger";
import type { Grant } from "./grant.ts";

/** The Worker's bindings: vars and bindings from wrangler.jsonc, secrets from `wrangler secret put`. */
export interface Bindings {
	"ENVIRONMENT": string;
	/** The app origins allowed to call this API from a browser, comma-separated: every client's. */
	"ALLOWED_ORIGINS": string;
	/** Our OAuth clients (`editor`, `admin`), each with the pages a sign-in for it may return to: exact URLs, matched
	 *  exactly. A client id that isn't a key here isn't one of ours. */
	"REDIRECT_URIS": Record<string, string[]>;
	/** The platform owners (src/rbac.ts): GitHub user ids, not secret. Only a commit makes one. */
	"OWNERS": number[];
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
	/** Where alerts go (audit.ts): a webhook URL, a secret; without one, nothing is sent and the audit log is the record. */
	"ALERT_WEBHOOK"?: string;
	/** Rate limits (wrangler.jsonc `ratelimits`, src/limits.ts): sign-in by IP, the token endpoint by IP and by grant, the
	 *  proxy by user — and one alert a minute per event and subject. */
	"SIGN_IN_BY_IP": RateLimit;
	"TOKEN_BY_IP": RateLimit;
	"TOKEN_BY_GRANT": RateLimit;
	"PROXY_BY_USER": RateLimit;
	"ALERTS": RateLimit;
	"DB": D1Database;
	/** The audit log's write-once copies (audit-copies.ts), in a bucket whose lock rules keep each as long as D1 keeps its row. */
	"AUDIT_COPIES": R2Bucket;
	"GRANTS": DurableObjectNamespace<Grant>;
}

/** Hono's environment: the bindings, and what middleware leaves for the routes after it. */
export interface AppEnv {
	"Bindings": Bindings;
	"Variables": { "span": Span; "user": string; "grant": string; "client": string; "roles"?: import("./rbac.ts").Role[] };
}
