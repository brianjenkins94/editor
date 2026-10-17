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
	/** What each client's sign-in page offers (SIGN-IN.md): `github` now; `email` and `password` as they're built. */
	"SIGN_IN_METHODS": Record<string, string[]>;
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
	/** Cloudflare's analytics (src/traffic.ts): a read-only token (a secret), and which account and zone to ask about. */
	"ANALYTICS_TOKEN"?: string;
	"ANALYTICS_ACCOUNT": string;
	"ANALYTICS_ZONE": string;
	/** Only in tests: where Cloudflare's API is, instead of api.cloudflare.com. */
	"CLOUDFLARE_API"?: string;
	/** Where alerts go (audit.ts): a webhook URL, a secret; without one, nothing is sent and the audit log is the record. */
	"ALERT_WEBHOOK"?: string;
	/** Email (src/mail.ts, SIGN-IN.md C2): Cloudflare Email Service's `send_email` binding where it's set up; in the harness
	 *  and the tests, an outbox stand-in's URL instead. Codes are an HMAC under CODE_KEY (a secret). Without either, or
	 *  without the key, email sign-in says it isn't set up. */
	"EMAIL"?: { "send": (message: { "from": string | { "email": string; "name": string }; "to": string; "subject": string; "text": string; "html": string }) => Promise<{ "messageId": string }> };
	"EMAIL_OUTBOX"?: string;
	"CODE_KEY"?: string;
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
	/** Sign-ins in progress (src/attempt.ts), one per pushed authorization request. */
	"ATTEMPTS": DurableObjectNamespace<import("./attempt.ts").Attempt>;
}

/** Hono's environment: the bindings, and what middleware leaves for the routes after it. */
export interface AppEnv {
	"Bindings": Bindings;
	"Variables": { "span": Span; "user": string; "grant": string; "client": string; "roles"?: import("./rbac.ts").Role[] };
}
