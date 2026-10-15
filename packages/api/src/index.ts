import type { AppEnv } from "./env.ts";
import { publicKey } from "@brianjenkins94/util/auth/dpop";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { callbackEndpoint, metadataEndpoint, startEndpoint } from "./github.ts";
import { log } from "./log.ts";
import { githubApi, githubGit } from "./proxy.ts";
import { revokeEndpoint, session, tokenEndpoint } from "./tokens.ts";

export { Grant } from "./grant.ts";

// The editor's API Worker (README.md): health, logging, errors (A1); the access-token key's JWKS (A2); our tokens, and
// DPoP in front of routes, and signing in through GitHub (A3).

const app = new Hono<AppEnv>();

// Every request is one span, active for all the work it does, so the runtime's own spans (fetch, storage) nest under
// it. Its path is the URL's pathname: the query string is where OAuth puts codes and state, so it's never logged.
app.use((context, next) => log.span("request", { "method": context.req.method, "path": new URL(context.req.url).pathname }, async (span) => {
	context.set("span", span);

	await next();

	span.end({ "status": context.res.status });
}));

app.use(secureHeaders());

// Sizes, before anything parses or verifies (README.md, "Hardening"). A proof or an access token is about a kilobyte:
// one ten times that is refused before jose sees it.
const HEADER_CAP = 8 * 1024;

app.use(async (context, next) => {
	if ((context.req.header("dpop")?.length ?? 0) > HEADER_CAP || (context.req.header("authorization")?.length ?? 0) > HEADER_CAP) {
		context.get("span").info("request refused", { "reason": "header too large" });

		return context.json({ "error": "request_header_fields_too_large" }, 431);
	}

	await next();
});

/** A route's body limit: counted as it streams, so a body without (or lying about) Content-Length can't get past it. */
const limit = (maxSize: number): ReturnType<typeof bodyLimit> => bodyLimit({
	"maxSize": maxSize,
	"onError": (context) => {
		(context.get("span") as AppEnv["Variables"]["span"] | undefined)?.info("request refused", { "reason": "body too large" });

		return context.json({ "error": "payload_too_large" }, 413);
	}
});

// OAuth forms are a few hundred bytes; a commit's blobs can be large (GitHub takes up to 100 MB a blob, the Worker 100
// MB a request); a clone's upload-pack request is its wants and haves.
app.use("/token", limit(4 * 1024));
app.use("/revoke", limit(4 * 1024));
app.use("/github/api/*", limit(32 * 1024 * 1024));
app.use("/github/git/*", limit(1024 * 1024));

// The app calls from its own origin (GitHub Pages, in development): the ones in ALLOWED_ORIGINS, no others, and never
// with cookies — the credential is the DPoP-bound Authorization header.
app.use(cors({
	"origin": (requested, context) => (context.env.ALLOWED_ORIGINS.split(",").includes(requested) ? requested : null),
	"allowMethods": ["GET", "POST", "PATCH"],
	"allowHeaders": ["authorization", "content-type", "dpop", "accept", "x-github-api-version"],
	// And GitHub's, through the proxy: what fido paginates (link) and backs off by (retry-after, x-ratelimit-*).
	"exposeHeaders": ["dpop-nonce", "www-authenticate", "link", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used"],
	"maxAge": 600
}));

app.get("/health", (context) => context.json({ "ok": true, "environment": context.env.ENVIRONMENT }));

// The public half of the key access tokens are signed with (SIGNING_JWK, a secret: a private JWK with alg and kid), so
// anyone can check a token we issued. Only ever the public members: publicKey drops the private ones.
app.get("/.well-known/jwks.json", (context) => {
	context.header("cache-control", "public, max-age=300");

	return context.json({ "keys": [publicKey(JSON.parse(context.env.SIGNING_JWK))] });
});

app.get("/.well-known/oauth-authorization-server", metadataEndpoint);

app.get("/auth/github/start", startEndpoint);

app.get("/auth/github/callback", callbackEndpoint);

app.post("/token", tokenEndpoint);

app.post("/revoke", revokeEndpoint);

// Who the access token is for: our user id (README.md: GitHub's login and avatar are fetched live, never stored).
app.get("/me", session, (context) => context.json({ "user": context.get("user") }));

// GitHub, for a signed-in browser (src/proxy.ts): the API calls the editor makes, and a clone's fetch.
app.on(["GET", "POST", "PATCH"], "/github/api/*", session, githubApi);

app.on(["GET", "POST"], "/github/git/*", session, githubGit);

app.notFound((context) => context.json({ "error": "not_found" }, 404));

// The error's name only: a message can quote whatever input caused it.
app.onError((error, context) => {
	context.get("span")?.error("request failed", { "error": error.name });

	return context.json({ "error": "internal" }, 500);
});

export default app;
