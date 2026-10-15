import type { AppEnv } from "./env.ts";
import { publicKey } from "@brianjenkins94/util/auth/dpop";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { callbackEndpoint, metadataEndpoint, startEndpoint } from "./github.ts";
import { log } from "./log.ts";
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

// The app calls from its own origin (GitHub Pages, in development): the ones in ALLOWED_ORIGINS, no others, and never
// with cookies — the credential is the DPoP-bound Authorization header.
app.use(cors({
	"origin": (requested, context) => (context.env.ALLOWED_ORIGINS.split(",").includes(requested) ? requested : null),
	"allowMethods": ["GET", "POST"],
	"allowHeaders": ["authorization", "content-type", "dpop"],
	"exposeHeaders": ["dpop-nonce", "www-authenticate"],
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

app.notFound((context) => context.json({ "error": "not_found" }, 404));

// The error's name only: a message can quote whatever input caused it.
app.onError((error, context) => {
	context.get("span")?.error("request failed", { "error": error.name });

	return context.json({ "error": "internal" }, 500);
});

export default app;
