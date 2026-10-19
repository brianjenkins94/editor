import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { publicKey } from "@brianjenkins94/util/auth/dpop";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { callbackEndpoint, metadataEndpoint, startEndpoint } from "./github.ts";
import { deleteAccountEndpoint, purge, revokeAllEndpoint, revokeSessionEndpoint, sessionsEndpoint } from "./account.ts";
import { accountRoutes } from "./account-routes.ts";
import { admin } from "./admin.ts";
import { ROUTES } from "./architecture.ts";
import { audit, expire, origin } from "./audit.ts";
import { decay, keyed } from "./behavior.ts";
import { emailEndpoint, verifyEndpoint } from "./email.ts";
import { expireInbox, receive } from "./inbox.ts";
import { secondStepEndpoint } from "./mfa.ts";
import { passwordSignInEndpoint, resetCodeEndpoint, resetPasswordEndpoint } from "./password.ts";
import { ROUTER, smokeTest } from "./smoke.ts";
import { byGrant, byIp, byUser, limit as rateLimit } from "./limits.ts";
import { log } from "./log.ts";
import { passkeyOptionsEndpoint, passkeyRegisterEndpoint, passkeySignInEndpoint } from "./passkeys.ts";
import { githubApi, githubGit } from "./proxy.ts";
import { attemptEndpoint, githubEndpoint, parEndpoint, startEndpoint as signInStart } from "./signin.ts";
import { revokeEndpoint, session, signedIn, tokenEndpoint } from "./tokens.ts";
import { allowedOrigins } from "./clients.ts";
import { maintenance, maintenanceGate, pausable, switches } from "./maintenance.ts";
import { checkSpend } from "./spend.ts";
import { Breach, ensureCanary, unwatched } from "./tripwire.ts";
import { expireErrors, recordError } from "./errors.ts";
import { editorErrorEndpoint, sessionEventsEndpoint } from "./session-events.ts";

export { Attempt } from "./attempt.ts";
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
		await audit(context.env, "oversized", {}, await origin(context), { "reason": "header too large", "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });

		return context.json({ "error": "request_header_fields_too_large" }, 431);
	}

	await next();
});

/** A route's body limit: counted as it streams, so a body without (or lying about) Content-Length can't get past it. */
const limit = (maxSize: number): ReturnType<typeof bodyLimit> => bodyLimit({
	"maxSize": maxSize,
	"onError": async (context) => {
		(context.get("span") as AppEnv["Variables"]["span"] | undefined)?.info("request refused", { "reason": "body too large" });
		await audit(context.env as AppEnv["Bindings"], "oversized", {}, await origin(context as Context<AppEnv>), { "reason": "body too large", "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });

		return context.json({ "error": "payload_too_large" }, 413);
	}
});

// OAuth forms are a few hundred bytes; a commit's blobs can be large (GitHub takes up to 100 MB a blob, the Worker 100
// MB a request); a clone's upload-pack request is its wants and haves.
app.use("/token", limit(4 * 1024));
app.use("/auth/par", limit(4 * 1024));
app.use("/auth/email/*", limit(4 * 1024));
app.use("/auth/email", limit(4 * 1024));
app.use("/auth/password", limit(4 * 1024));
app.use("/auth/reset", limit(4 * 1024));
app.use("/auth/reset/*", limit(4 * 1024));
app.use("/auth/second", limit(4 * 1024));
app.use("/auth/passkey", limit(8 * 1024));
app.use("/auth/passkey/*", limit(4 * 1024));
app.use("/passkey/register", limit(16 * 1024));
app.use("/session/events", limit(16 * 1024));
app.use("/errors", limit(32 * 1024));
app.use("/revoke", limit(4 * 1024));
app.use("/sessions/*", limit(4 * 1024));
app.use("/account/*", limit(4 * 1024));
app.use("/admin/*", limit(4 * 1024));
app.use("/github/api/*", limit(32 * 1024 * 1024));
app.use("/github/git/*", limit(1024 * 1024));

// The app calls from its own origin (GitHub Pages, in dev): its pages' (src/clients.ts), no others, and never
// with cookies — the credential is the DPoP-bound Authorization header.
app.use(cors({
	"origin": (requested, context) => (allowedOrigins(context.env).includes(requested) ? requested : null),
	"allowMethods": ["GET", "POST", "PATCH"],
	"allowHeaders": ["authorization", "content-type", "dpop", "accept", "x-github-api-version"],
	// And GitHub's, through the proxy: what fido paginates (link) and backs off by (retry-after, x-ratelimit-*).
	"exposeHeaders": ["dpop-nonce", "www-authenticate", "link", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used"],
	"maxAge": 600
}));

// The kill switch (src/maintenance.ts, OPERATIONS.md): while it's on, everything but the owner's way back in is "Down for
// maintenance", before any other work. After CORS, so a browser can read why.
app.use(maintenanceGate);

app.get("/health", (context) => context.json({ "ok": true, "environment": context.env.ENVIRONMENT }));

// Whether the API is down for maintenance, and which of its parts are paused (src/maintenance.ts): what the editor asks,
// to say so instead of offering what can't work, and to go to GitHub directly while the proxy is paused.
app.get("/status", async (context) => {
	context.header("cache-control", "no-store");

	return context.json({ "maintenance": (await maintenance(context.env)).on, "paused": Object.keys(await switches(context.env)) });
});

// The public half of the key access tokens are signed with (SIGNING_JWK, a secret: a private JWK with alg and kid), so
// anyone can check a token we issued. Only ever the public members: publicKey drops the private ones.
app.get("/.well-known/jwks.json", (context) => {
	context.header("cache-control", "public, max-age=300");

	return context.json({ "keys": [publicKey(JSON.parse(context.env.SIGNING_JWK))] });
});

app.get("/.well-known/oauth-authorization-server", metadataEndpoint);

// Rate limits (src/limits.ts; the numbers are wrangler.jsonc's): sign-in and the token endpoint by IP, the token endpoint
// by the grant a token names too, the proxy by the signed-in user.
app.get("/auth/github/start", rateLimit("SIGN_IN_BY_IP", byIp), startEndpoint);

app.get("/auth/github/callback", rateLimit("SIGN_IN_BY_IP", byIp), callbackEndpoint);

// Signing in through our own page (src/signin.ts, SIGN-IN.md): the client pushes its request, the browser opens it, the
// page offers the client's methods. The sign-in page itself is a static file (public/sign-in.html).
app.post("/auth/par", rateLimit("SIGN_IN_BY_IP", byIp), parEndpoint);

app.get("/auth/start", rateLimit("SIGN_IN_BY_IP", byIp), signInStart);

app.get("/auth/attempt", attemptEndpoint);

app.get("/auth/github", rateLimit("SIGN_IN_BY_IP", byIp), githubEndpoint);

// The page's email choice (src/email.ts, SIGN-IN.md C2): a code sent, then checked.
app.post("/auth/email", rateLimit("SIGN_IN_BY_IP", byIp), emailEndpoint);

app.post("/auth/email/verify", rateLimit("SIGN_IN_BY_IP", byIp), verifyEndpoint);

// The page's password choice (src/password.ts, SIGN-IN.md C3): an email and its password.
app.post("/auth/password", rateLimit("SIGN_IN_BY_IP", byIp), passwordSignInEndpoint);

// Resetting it from the sign-in page (src/password.ts, C4): a code to the account's email, then a new password.
app.post("/auth/reset", rateLimit("SIGN_IN_BY_IP", byIp), resetCodeEndpoint);

app.post("/auth/reset/password", rateLimit("SIGN_IN_BY_IP", byIp), resetPasswordEndpoint);

// The second factor, for an account with MFA (src/mfa.ts, C5): after an emailed code or a password.
app.post("/auth/second", rateLimit("SIGN_IN_BY_IP", byIp), secondStepEndpoint);

// Passkeys (src/passkeys.ts): signing in with one from the sign-in page, and our page that makes one for an account.
app.post("/auth/passkey/options", rateLimit("SIGN_IN_BY_IP", byIp), passkeyOptionsEndpoint);

app.post("/auth/passkey", rateLimit("SIGN_IN_BY_IP", byIp), passkeySignInEndpoint);

app.post("/passkey/register", rateLimit("SIGN_IN_BY_IP", byIp), passkeyRegisterEndpoint);

app.post("/token", rateLimit("TOKEN_BY_IP", byIp), rateLimit("TOKEN_BY_GRANT", byGrant), tokenEndpoint);

app.post("/revoke", rateLimit("TOKEN_BY_IP", byIp), rateLimit("TOKEN_BY_GRANT", byGrant), revokeEndpoint);

// Who the access token is for: our user id (README.md: GitHub's login and avatar are fetched live, never stored).
app.get("/me", session, (context) => context.json({ "user": context.get("user") }));

// Your sessions, and your account (src/account.ts).
app.get("/sessions", session, sessionsEndpoint);

app.post("/sessions/revoke-all", session, revokeAllEndpoint);

app.post("/sessions/:id/revoke", session, revokeSessionEndpoint);

app.post("/account/delete", session, deleteAccountEndpoint);

// What the editor reports (src/session-events.ts, OPERATIONS.md O6): signed in, its timeline's events; signed in or not,
// its uncaught errors (ten a minute an IP), under the id it shows.
app.post("/session/events", session, sessionEventsEndpoint);

app.post("/errors", rateLimit("ERRORS_BY_IP", byIp), editorErrorEndpoint);

// Your account (src/account-routes.ts): the same routes as the admin app's /admin/account, behind the editor's session.
app.route("/account", accountRoutes(session));

// The admin API (src/admin.ts): admin tokens only, each route behind its permission.
app.route("/admin", admin);

// GitHub, for a signed-in browser (src/proxy.ts): the API calls the editor makes, and a clone's fetch.
app.on(["GET", "POST", "PATCH"], "/github/api/*", pausable("github-proxy"), session, rateLimit("PROXY_BY_USER", byUser), githubApi);

app.on(["GET", "POST"], "/github/git/*", pausable("github-proxy"), session, rateLimit("PROXY_BY_USER", byUser), githubGit);

// The router's table, for the admin app's architecture page (src/architecture.ts): every route, by method and template;
// middleware (registered for every method) isn't a route.
// The router, for the smoke test, which signs in through it (src/smoke.ts).
ROUTER.app = app;

ROUTES.push(...[...new Map(app.routes.filter((route) => route.method !== "ALL").map((route) => [`${route.method} ${route.path}`, { "method": route.method, "path": route.path }])).values()]);

/**
 * A route that doesn't exist. Asked for by someone signed in, it's a probe (BEHAVIOR.md): something guessing at what the
 * API has, which the editor never does (every route it calls is one the router has, whichever release it is). Recorded
 * with its method and a keyed hash of the path (what was guessed), alerted, and counted with the proxy's refusals: a few
 * end the sign-in. A request with credentials is checked as any signed-in request is (a nonce challenge included), so a
 * probe is only ever pinned on a sign-in that made it. Without credentials it's the web's background noise: a 404, and
 * the Traffic page's to show.
 */
app.notFound(async (context) => {
	const signed = context.get("grant") !== undefined ? { "user": context.get("user"), "grant": context.get("grant") }
		: context.req.header("authorization") === undefined ? undefined : await signedIn(context);

	if (signed instanceof Response) {
		return signed;
	}

	if (signed !== undefined) {
		const from = await origin(context);
		const url = new URL(context.req.url);

		context.get("span").info("probe", { "method": context.req.method });
		await audit(context.env, "probe", { "userId": signed.user, "grantId": signed.grant }, from, { "detail": `${context.req.method} #${await keyed(context.env, "values", url.pathname + url.search)}` });
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(signed.grant)).denied({ "from": from });
	}

	return context.json({ "error": "not_found" }, 404);
});

// Every uncaught error recorded (src/errors.ts, OPERATIONS.md O4), redacted, under the id the person is shown, so "it
// broke" goes from their words to the stack in one search. The span has the name only: a message can quote whatever
// input caused it. A tripwire breach answers for itself (src/tripwire.ts).
app.onError(async (error, context) => {
	context.get("span")?.error("request failed", { "error": error.name });

	if (error instanceof Breach) {
		return context.json({ "error": "internal" }, 500);
	}

	const id = await recordError(unwatched(context.env), {
		"source": "api",
		"name": error.name,
		"message": error.message,
		"stack": error.stack,
		"route": `${context.req.method} ${routePath(context, -1)}`,
		"release": context.env.RELEASE ?? "local",
		"traceId": (context.get("span") as { "traceId"?: string } | undefined)?.traceId ?? null,
		"grantId": context.get("grant") ?? null,
		"userId": context.get("user") ?? null
	}).catch(() => undefined);

	return context.json({ "error": "internal", ...id === undefined ? {} : { "id": id } }, 500);
});

/** The cost guard's cron (wrangler.jsonc's triggers). */
const HOURLY = "7 * * * *";

export default {
	"fetch": app.fetch,
	// Hourly (wrangler.jsonc's second cron): the cost guard (spend.ts) and the tripwire's canary (tripwire.ts). Daily: the audit log's retention (audit.ts),
	// deleted accounts past their grace period purged (account.ts), the likely-next-action model's counts faded
	// (behavior.ts), our inbox's day kept (inbox.ts), and the email smoke test run (smoke.ts).
	"scheduled": async (controller, env, context) => {
		if (controller.cron === HOURLY) {
			context.waitUntil(log.span("spend.check", {}, async (span) => {
				span.info("spend checked", await checkSpend(env));
			}));
			// The tripwire's canary account, there within the hour of a first deploy (idempotent).
			context.waitUntil(log.span("tripwire.canary", {}, async () => {
				await ensureCanary(env);
			}));

			return;
		}

		context.waitUntil(log.span("audit.expire", {}, async () => {
			await expire(env.DB);
		}));
		context.waitUntil(log.span("account.purge", {}, async () => {
			await purge(env);
		}));
		context.waitUntil(log.span("behavior.decay", {}, async () => {
			await decay(env.DB);
		}));
		context.waitUntil(log.span("inbox.expire", {}, async () => {
			await expireInbox(env.DB);
			// Errors (src/errors.ts): occurrences 30 days, groups 90 after last seen.
			await expireErrors(env.DB);
			// Emails to the owner (src/mail.ts): kept 90 days.
			await env.DB.prepare("DELETE FROM alerts WHERE at < ?").bind(Date.now() - 90 * 86_400_000).run();
		}));
		// Not while the kill switch is on: the API is down on purpose, and a sign-in through it would only fail.
		context.waitUntil(log.span("smoke.email", {}, async () => {
			if (!(await maintenance(env)).on) {
				await smokeTest(env, context);
			}
		}));
	},
	// Email Routing's deliveries to our own addresses (src/inbox.ts).
	"email": async (message, env) => {
		await receive(message, env);
	}
} satisfies ExportedHandler<AppEnv["Bindings"]>;
