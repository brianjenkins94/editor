import type { Span } from "@brianjenkins94/util/logger";
import { publicKey } from "@brianjenkins94/util/auth/dpop";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { log } from "./log.ts";

// The editor's API Worker (README.md): health, logging, errors (A1); the access-token key's JWKS (A2).

/** Bindings and its vars are named by Hono and wrangler.jsonc, not by us. */
interface Env { "Bindings": { "ENVIRONMENT": string; "SIGNING_JWK": string }; "Variables": { "span": Span } }

const app = new Hono<Env>();

// Every request is one span, active for all the work it does, so the runtime's own spans (fetch, storage) nest under
// it. Its path is the URL's pathname: the query string is where OAuth puts codes and state, so it's never logged.
app.use((context, next) => log.span("request", { "method": context.req.method, "path": new URL(context.req.url).pathname }, async (span) => {
	context.set("span", span);

	await next();

	span.end({ "status": context.res.status });
}));

app.use(secureHeaders());

app.get("/health", (context) => context.json({ "ok": true, "environment": context.env.ENVIRONMENT }));

// The public half of the key access tokens are signed with (SIGNING_JWK, a secret: a private JWK with alg and kid), so
// anyone can check a token we issued. Only ever the public members: publicKey drops the private ones.
app.get("/.well-known/jwks.json", (context) => {
	context.header("cache-control", "public, max-age=300");

	return context.json({ "keys": [publicKey(JSON.parse(context.env.SIGNING_JWK))] });
});

app.notFound((context) => context.json({ "error": "not_found" }, 404));

// The error's name only: a message can quote whatever input caused it.
app.onError((error, context) => {
	context.get("span")?.error("request failed", { "error": error.name });

	return context.json({ "error": "internal" }, 500);
});

export default app;
