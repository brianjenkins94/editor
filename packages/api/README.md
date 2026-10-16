# Log in with GitHub: design

Status: **approved 2026-10-15**. A1 (this package's skeleton) is built; A0 (accounts) is pending. This replaces the pasted PAT (`packages/editor/shell/github-auth.ts`) with a
real sign-in, and lays down the account backbone that paid tiers (Stripe) will hang off later. Stripe is out of
scope here, but nothing in this design should have to change when it arrives.

This is the part we can't get wrong, so the doc leads with what's at stake and states each guarantee so it can be
checked.

## Where we are today, and why it's not OK to keep it

- **The PAT is in `localStorage["shell:githubPat"]` on `brianjenkins94.github.io`.** Every GitHub Pages site under
  that account shares the origin (`/lib`, `/games`, …), so a bug or third-party script in any of them can read it.
- **Everything in the editor shares that origin, unsandboxed.** The app iframe, the workbench iframe, preview
  iframes running *repo code*, and extensions loaded by `?extension=<url>` are all same-origin with the shell
  (the editor's `ARCHITECTURE.md` already says previews are "not a security boundary"). "The token stays in the shell" is a
  convention, not a guarantee.
- **The clone sends the PAT through a third party.** `packages/editor/shell/git-clone.ts` uses `cors.isomorphic-git.org`, which
  sees the token on every clone.

The design follows from these three facts: **the GitHub token never comes to the browser**, the browser holds only
a credential that's useless if it's stolen, and anything that runs repo code is moved off the origin that holds it.

## The shape

```
 browser (shell realm)                    Cloudflare Worker (packages/api, Hono)               GitHub
 ─────────────────────                    ──────────────────────────────────────              ──────
 non-extractable ES256 key (IndexedDB)    OAuth 2.1 authorization server (ours)
 DPoP-bound access + refresh token  ───▶  verifies DPoP on every request          ──────▶   OAuth (GitHub App)
                                          Grant Durable Object (one per sign-in):            api.github.com
                                            GitHub tokens, encrypted                          github.com git
                                            our refresh family + jti cache                    smart-HTTP
                                          D1: users, grants index, audit log
                                          allowlisting proxy for the GitHub API + git
```

**Our Worker is an OAuth 2.1 authorization server that federates to GitHub.** GitHub signs the user in, but the
tokens the browser holds are *ours*: short-lived, DPoP-bound (RFC 9449), and only good at our Worker. The Worker
keeps the GitHub user token and spends it on the user's behalf through a proxy that allows only the GitHub calls
the editor makes.

Why not hand the GitHub token to the browser and use the Worker only for the code exchange? Because GitHub doesn't
do DPoP. Once a GitHub token is in the browser, anything on the origin can copy it out and use it anywhere for 8
hours. "Full DPoP" only means something if the thing DPoP protects is the only credential the browser has.

### What DPoP does and doesn't buy (be honest about this)

- **It does:** a stolen access or refresh token (logs, a leaked trace, a copied IndexedDB dump, a malicious
  extension reading storage) is worthless without the private key, and the key is created `extractable: false`, so
  no script can export it.
- **It does not:** stop code running *on our origin* from using the key in place, because same-origin script can
  open the same IndexedDB and sign proofs. That's why the proxy allowlist exists (a hijacked session can only do
  what the editor does) and why **moving previews and `?extension=` code to a separate origin is a prerequisite
  for production** (step A6).

## Decisions

### Platform: Cloudflare Workers + Durable Objects + D1, with Hono

Workers is the right call, and not only because it's cheap:

- **Durable Objects give us serialized, strongly consistent state per sign-in**, which is exactly what this flow
  needs. GitHub refresh tokens are single-use, so two concurrent refreshes would log the user out; our own refresh
  rotation needs reuse detection; DPoP `jti` replay checking needs read-then-write without a race. One Grant DO per
  sign-in handles all three by construction. KV is eventually consistent and wrong for every one of them (this is
  also why we don't use `@cloudflare/workers-oauth-provider`: it's KV-backed and has no DPoP).
- **The same platform can host production.** Workers static assets serve the built site and set COOP/COEP as real
  response headers, so production doesn't need the `coi-serviceworker` reload trick at all.
- **Cost:** the free plan covers development (100k requests/day, SQLite-backed DOs, D1). Once the git proxy carries
  clones, the $5/month paid plan (10M requests) is the realistic floor.
- **Hono** is Workers-native, tiny, and has the CORS/secure-headers middleware we'd otherwise write. The
  sms-reference-app is Express on Node and doesn't port as a server; its *logic* does (below).

Alternatives considered: Deno Deploy (no equivalent of DOs' per-key serialization), Vercel/Netlify functions (same,
plus cold starts), Fly.io (a real server to run and patch). None beats Workers here.

### GitHub side: a GitHub App, not an OAuth App

- An OAuth App's `repo` scope is read/write on *every* private repo the user can reach. A GitHub App asks for
  fine-grained permissions and the user picks which repos it's installed on.
- GitHub App user tokens expire after 8 hours with a 6-month refresh token, so a leaked server-side token has a
  short life too.
- GitHub supports PKCE (S256) since 2025-07, but **the token exchange still requires the client secret** and the
  endpoint has no CORS, so a server is mandatory regardless of what else we decide.
- Permissions we'd ask for: Metadata (read, mandatory), Contents (read/write, for commit-back), Pages (write, for
  `enablePages`). **No email permission**: we don't need an email address to run an editor, and not having it is
  the cheapest privacy measure there is. Repo creation needs Administration (write); decide when we wire it.
- **Two GitHub Apps**: one for development (callbacks on `workers.dev` and `localhost`), one for production.
  Separate secrets, separate blast radius.

### Identity and the data we keep

| Data | Where | Why | Retention |
|---|---|---|---|
| GitHub numeric user id | D1 `users` | stable identity (logins can be renamed) | until account deletion |
| our user id (random) | D1 `users` | what everything else (grants, later Stripe) keys on | until account deletion |
| GitHub user access + refresh token | Grant DO, **AES-GCM encrypted** with a key from a Worker secret (with a key id, so it can rotate) | to call GitHub for the user | until sign-out, refresh expiry, or deletion |
| our refresh-token family, hashed | Grant DO | rotation + reuse detection | lifetime of the grant |
| grants index (grant id, user id, created, last used, coarse device label) | D1 `grants` | "your sessions", sign out everywhere | lifetime of the grant |
| audit events | D1 `audit` | the security record: what was refused, and what went through | 90 days; refusals and alerts a year |

We **don't** store login name, avatar, email, or raw IPs. Login and avatar are fetched live through the proxy.
Audit rows carry country (from Cloudflare) and an IP hash salted per day, which is enough to spot abuse but can't
be reversed into an address.

**Account deletion** (required before production): revoke every grant, revoke the GitHub App's authorization for
the user (`DELETE /applications/{client_id}/grant`), delete the D1 rows, and keep only anonymized audit aggregates.

### Tokens and the flow

Ported from the sms-reference-app, which already has spec-faithful pieces: `app/auth/dpop.ts` (proof verifier),
`token.ts` / `resource.ts` (binding checks, rotation), and `app/src/oauth-client.ts` (the oauth4webapi browser
client with a non-extractable key in IndexedDB, nonce retry, and single-flight refresh). What needs changing: swap
`Buffer` for `jose`'s base64url, replace the in-memory Maps with the Grant DO, and move the hard-coded HS256 secret
to asymmetric signing.

1. **Start.** The shell makes (or loads) its DPoP key pair and a PKCE verifier, then does a top-level navigation
   to `GET /auth/github/start?code_challenge=…&dpop_jkt=…&state=…&redirect_uri=…`. The `redirect_uri` must
   exactly match an allowlisted app origin. The Worker makes its *own* PKCE pair for GitHub and packs everything
   into an encrypted, 10-minute `state` (JWE) that it sends to GitHub, so this step needs no storage. (Full-page
   redirect, not a popup: the shell is `COOP: same-origin`, which severs a popup's opener anyway.)
2. **GitHub callback.** `GET /auth/github/callback` decrypts the state, exchanges GitHub's code (client secret plus
   GitHub PKCE verifier), reads `GET /user` for the numeric id, upserts the user, and creates a Grant DO holding
   the encrypted GitHub tokens and a **single-use, 60-second authorization code** bound to the browser's
   `code_challenge` and `dpop_jkt`. It then redirects to the app's `redirect_uri` with `code` and `state`.
3. **Token.** The shell checks `state`, strips the query with `history.replaceState`, and `POST /token` with
   `code` + `code_verifier` + a DPoP proof. The Worker checks PKCE, checks that the proof's key thumbprint equals
   the `dpop_jkt` from step 1 (so a stolen code is useless to anyone without the key), burns the code, and issues:
   - **an access token**: a 5-minute ES256 JWT (`typ: at+jwt`) with `cnf.jkt`, `sub` (our user id) and `grant`
     (the DO id), signed with a key whose public half is published at `/.well-known/jwks.json`;
   - **a refresh token**: opaque, DPoP-bound, rotated on every use. Presenting an already-used one revokes the
     whole grant (reuse detection).
4. **Every API request** carries `Authorization: DPoP <at>` and a `DPoP` proof. The Worker verifies the JWT, then
   the proof (`typ`, an asymmetric alg from an allowlist, no private key material in the header, `htm`, `htu`,
   `iat` within 60 s, `ath` = hash of the access token, the server nonce), then routes to the Grant DO. The DO
   checks the `jti` hasn't been seen, rejects the request if the grant is revoked, and refreshes the GitHub token
   if it's within a few minutes of expiry, serialized so it happens exactly once.
5. **Nonces** (`DPoP-Nonce`) are stateless: an HMAC over a 5-minute time window, so issuing and checking them needs
   no storage, and old proofs can't be pre-computed.
6. **Sign-out** revokes the grant (DO + D1) and deletes the browser's key. "Sign out everywhere" revokes every grant
   for the user.

The shell gets a `dpopProvider` that replaces `patProvider`. It's still `typeof fetch`, so `github.ts` and fido
don't change; only its base URL moves from `api.github.com` to the Worker's `/github/api/`.

### The proxy

- `/github/api/*` → `api.github.com`, **allowlisted** by method + path pattern to what `packages/editor/shell/github.ts` calls
  (`/user`, repos, git trees/blobs/commits/refs, pages). Anything else gets a 403 and an audit row.
- `/github/git/*` → `github.com` git smart-HTTP (`info/refs`, `git-upload-pack`) for isomorphic-git, streamed, not
  buffered. This **retires `cors.isomorphic-git.org`**. Push (`git-receive-pack`) is added only when commit-back
  moves to git.
- The proxy never forwards our `Authorization`/`DPoP` headers upstream and never returns GitHub's token-bearing
  headers.

### Hosts and origins

| Environment | App | Worker | GitHub App |
|---|---|---|---|
| local | `editor.localhost:5173` | `wrangler dev` (`localhost:8787`) | dev |
| development | `brianjenkins94.github.io/editor/` (unchanged) | `editor-api-dev.<account>.workers.dev` | dev |
| production | a domain of ours, served by the Worker's static assets | same origin as the app (`/api`) | prod |

The dev split is cross-origin, and that's fine *because* of DPoP: the credential is an `Authorization` header, not
a cookie, so third-party-cookie blocking doesn't affect us and there's no CSRF surface. CORS is an explicit origin
allowlist, never `*`, never reflected.

**editor-contrib forks** (`<owner>.github.io/<repo>/`) are not on the allowlist. A fork that wants sign-in brings
its own Worker and GitHub App; the README says so.

**Production needs its own domain** (about $10/year, bought through Cloudflare). It gets the editor off the shared
`github.io` origin, puts the app and API on one origin (no CORS at all), and gives us real COOP/COEP headers.

## Hardening: floods, abuse and sizes

Cloudflare absorbs volumetric DDoS (layers 3, 4 and 7) in front of every Worker, `workers.dev` included. What's left is
ours: the cost of each request (the paid plan bills per request; the free plan just stops at 100k a day, which costs
availability instead of money), anyone probing for a weak spot, and anyone sending something huge.

**In place (2026-10-15):**
- **Sizes**, checked before anything is parsed or verified:
  - Bodies: 4 KB for `/token` and `/revoke`, 1 MB for a clone's request, 32 MB for the API proxy (a commit's
    blobs). They're counted as the body streams, so a missing or false `Content-Length` doesn't get past them.
  - `DPoP` and `Authorization` headers over 8 KB get a 431.
- **No unauthenticated request creates storage.** A Grant exists only after GitHub has signed someone in, and a
  code or refresh token is checked against D1 before its Durable Object is addressed.
- **The proxy allows only the editor's calls.** Each refusal is a `proxy_denied` row in the audit log.

**Detection: knowing at once when someone does something abnormal through us (2026-10-15).** Decided as the
priority: whatever abuse gets past every limit should still be seen, and immediately.
- **The audit log records every refusal, with its reason.** That covers a refused token or proof (`auth_refused`), a
  refused code or refresh token (`token_rejected`, saying whether it was expired, unknown, the wrong PKCE verifier,
  or **another key**), a refused sign-in, a rate-limit trip and an oversized request. The one exception is the
  routine nonce challenge.
- **Every call through the proxy is recorded** (`proxy_call`), reads as much as writes: the call (with its query),
  GitHub's status, and the bytes it carried back. If something ever uses a session it shouldn't have, what it read is
  what matters, and Workers Logs keep requests only 3 days on Free. The row is written before the answer streams, so a
  dropped connection still leaves it; the bytes are added once they've streamed.
- **What it's for:** not watching users, but knowing, if something gets through, what it tried and what it did.
- **Retention**, applied daily by a cron trigger (`expire` in `audit.ts`): routine rows (sign-ins and what they did)
  are kept 90 days, and refusals and alerts a year.
- **Reading it:** `npm run audit` prints a timeline, oldest first, each row with its trace id. It can be filtered by
  `--grant`, `--user`, `--ip <hash>` or `--event`, with `--suspicious` (refusals, limits and alerts only) and
  `--since 24h`.
- **Every row carries its request's trace id**, so it joins to the full logs and spans in Cloudflare's dashboard
  (`migrations/0002_audit_detail.sql` adds `reason`, `detail` and `trace_id`).
- **Some events raise an alert at once** (`audit.ts`):
  - **token theft:** a refresh token reused; a token presented with **another key's** proof; a replayed proof;
  - **probing:** `proxy_denied`, and a grant ended for it (`proxy_abuse`);
  - **flooding:** a rate-limit trip.

  Alerts go to `ALERT_WEBHOOK` (a secret: ntfy, Discord or Slack), at most one a minute per event and subject. They
  say what the audit row says (ids, reason, country, IP hash, trace id) and never a token or an address.
- **A sign-in that probes is ended:** 5 `proxy_denied` in 10 minutes revokes the grant.
- **At most 8 proxied requests in flight per sign-in.** The Grant hands out leases (`lease()`, exact, since it handles
  one call at a time), returned when GitHub's answer has finished streaming or after 2 minutes if the connection
  dropped. GitHub's secondary rate limits punish a token's concurrent requests, and a burst of large clones is what a
  scripted session looks like. Over the cap, the request gets a 429 and a `rate_limited` row with reason
  `PROXY_CONCURRENCY`, which alerts.
- **Rate limits** (`src/limits.ts`; the numbers are in `wrangler.jsonc`, per environment):
  - sign-in at 20 a minute per IP;
  - `/token` and `/revoke` at 30 a minute per IP **and** 10 a minute per grant named;
  - the proxy at 300 a minute per user.

  A trip is a 429 with `Retry-After: 60`, recorded, and alerted.
- **Tests** (`test/detection.test.ts`): each limit; a stolen access token and a stolen refresh token, each alerting
  once (the second within the minute is recorded but not alerted, and neither alert carries the token); writes
  recorded and reads not; refusals and oversized requests recorded with why. Each of the 12 guards, disabled in
  turn, fails a test.

**Decided 2026-10-15:**
- **Stay on Workers Free for now.** A flood that uses up the 100k daily requests takes the API down until midnight UTC.
  Workers Paid ($5/month) would keep it up at a small cost; revisit before real users.
- **Preview isolation is deferred.** Code running on the editor's origin (previews, `?extension=`, almostnode) can use
  the signed-in session in place. DPoP keeps the token from being used anywhere else, and the allowlist keeps it to
  the editor's calls, but neither stops code already on our origin; only a separate origin does, which needs our
  own domain. Detection is the mitigation meanwhile: any such misuse shows up as proxy writes and, past the
  allowlist, as alerts.

**Still to do, in the order to reach for them:**
1. **A WAF rate-limiting rule, once we have our own domain (A7).** It blocks before the Worker runs, so blocked
   requests cost nothing, and it's the only layer that protects the daily request budget. The free plan includes one
   rule. Bot Fight Mode and the managed DDoS rules come with the zone too.
2. **Durable Object IP bans** (fail2ban semantics) only if repeat offenders get past the limits. KV is never the
   counter: it's eventually consistent.
3. **On Paid,** `limits.cpu_ms`. Free already caps CPU at 10 ms a request.

Turnstile doesn't apply: there's no password or signup form here. GitHub takes the credentials, and has its own
brute-force protection, and every input our endpoints take is unguessable (a code, a token, a signed proof).

Cloudflare's volumetric DDoS protection catches floods, not low-rate abuse: a few requests a second at an expensive
route looks like a user. That's what the binding limits are for.

GitHub's own limit (5,000 requests an hour per user) comes back through the proxy's rate-limit headers, and fido backs
off on them.

## Visibility: tracing the whole flow

There are three separate streams with three different audiences. Keeping them separate is what lets us trace
everything without leaking anything.

1. **Traces (for us, to debug).** Workers' automatic OpenTelemetry tracing (open beta since 2025-11) traces every
   request, including each `fetch` to GitHub and each DO and D1 call, with no code. We add a few spans of our own
   around the steps that matter (`auth.start`, `auth.callback`, `auth.token`, `grant.refresh_github`,
   `proxy.request`). These land in **Cloudflare's own Observability dashboard** (logs, traces, metrics, and a query
   builder), with no third-party vendor. It's private to the account even though the code is public. Each sign-in
   gets a `login.id` attribute carried from start to callback to token, so the funnel is one query: how many starts
   never came back from GitHub, how many callbacks never redeemed, and why.
   - **Its limits:** retention is 3 days on Free and 7 days on Paid, which is fine for debugging. Anything we need
     longer is the audit log's job (below), which was always going to be ours. Tracing is still in beta. Logs are
     included up to 200k events/day on Free and 20M/month on Paid, with pricing moving to "Cloudflare
     Observability" on 2026-12-01.
   - **The way out, if we outgrow it:** OTLP export to an outside backend (Honeycomb, Grafana Cloud) is a
     destination set in the dashboard, not code. Adding one later changes nothing in the Worker.
   - **Across the browser boundary:** the shell's spans already use W3C-shaped ids (`util/logger`). The
     `dpopProvider` sends a `traceparent` header so a sign-in is one trace from the shell's click to GitHub and
     back. Browser spans themselves stay on-device (debug-mcp) for now. Shipping end-user browser telemetry off the
     device is a privacy decision of its own, and it's deferred.
   - *To verify on the first deploy (it needs A0):* whether automatic tracing adopts an incoming `traceparent` as
     the parent, or whether we link it as an attribute, and **what the automatic spans record about a request**.
     If they keep query strings or `Authorization` headers, the redaction rule needs an answer for traces too.
2. **The audit log (for security, and for the user).** These are append-only D1 rows: `login`, `token_issued`,
   `refresh`, `refresh_reuse_detected`, `grant_revoked`, `proxy_denied`, `account_deleted`. It's not sampled and
   doesn't depend on a vendor, and a user can see their own (their sessions, recent sign-ins).
3. **Workers Logs (for the operator).** These are structured `console.log` objects, kept by Cloudflare. They're
   correlated with traces by trace id. Cloudflare's own *invocation logs* are **off** (`invocation_logs: false`):
   they record each request's URL, the docs don't say what else, and they can't be redacted. The Worker writes its
   own span per request instead (`src/log.ts`: method, path without the query, status, duration).

**The redaction rule, enforced in code rather than by convention:** spans, logs and audit rows are built from an
*allowlist* of attribute names. Nothing ever records tokens, codes, verifiers, DPoP proofs, `Authorization`
headers, `state`, emails, or raw IPs. A test pushes a full sign-in through the Worker with a capturing exporter and
fails if any secret value appears anywhere in the output.

## Building it in the open

Public code is fine for an auth server. Its security has to hold with the code visible (that's the standard), and
public code means anyone can review it. The limits are operational:

- **Secrets live only in Cloudflare** (`wrangler secret put`): `GITHUB_CLIENT_SECRET`, `TOKEN_KEK` (encrypts GitHub
  tokens), `SIGNING_JWK` (access tokens), `NONCE_KEY`, `AUDIT_KEY` (the audit log's IP hashes), `STATE_KEY`. The
  account id and binding names in `wrangler.jsonc` aren't secret.
- **Deploys use a scoped Cloudflare API token** (Workers edit on this account only) stored as a GitHub *Environment*
  secret. The `production` environment requires your approval for every deploy, so a merge to main can't ship an
  auth change by itself. `development` deploys automatically after CI.
- **No `pull_request_target`**, and nothing that hands secrets to fork PRs. PRs get tests, never deploys.
- **Telemetry is private.** It lives in the Cloudflare account, not in public view, even though the code that emits it
  is public.
- **Dependencies:** `hono`, `jose`, and `oauth4webapi` in the browser. That's all; each is small, widely audited,
  and has no runtime dependencies. Pin exact versions, at least a week old (CI already enforces that).

## Steps

Each step lands green and is useful on its own.

- **A0 · accounts (you).** A Cloudflare account and the dev GitHub App. Nothing in this step is code, and none of
  the secrets ever go into the repo or this chat. *Done for dev 2026-10-15:* the GitHub App
  `editor-dev-brianjenkins94`; the Worker at `https://editor-api-dev.brianjenkins94.workers.dev`, with its D1 database
  migrated and all six secrets set; CI deploying it through the `development` environment's scoped account token. Two
  things GitHub renamed: the callback URL is "Redirect URI" ("Add redirect URI"), and token expiry is under "Optional
  features" (on by default; the page offers only "Opt-out"). The runbook, in order (production repeats it in A7, with its own
  app, database and secrets). Commands run in `packages/api`:
  1. **Cloudflare account**, and its `workers.dev` subdomain. It belongs to the account, not to a Worker, so none has to
     exist yet: Workers & Pages shows it in the account details beside the list (Subdomain, with Change), and if none
     is set, that's where to choose one (the first `wrangler deploy` would ask for one too). The dev Worker will be
     `https://editor-api-dev.<subdomain>.workers.dev`. Then `npx wrangler login`.
  2. **D1:** `npx wrangler d1 create editor-api-dev`. Its `database_id` isn't secret; it goes in `wrangler.jsonc`'s
     `env.dev` (binding `DB`, whatever binding name wrangler's snippet suggests). Done for dev, 2026-10-15.
  3. **The dev GitHub App** (GitHub → Settings → Developer settings → GitHub Apps → New GitHub App):
     - Name: anything unique, e.g. `editor-dev-<you>`. Homepage: `https://brianjenkins94.github.io/editor/`.
     - Callback URLs, under "Identifying and authorizing users" on the app's settings page (General → Edit, for an app
       that already exists): `https://editor-api-dev.<subdomain>.workers.dev/auth/github/callback`, then "Add Callback
       URL" for `http://localhost:8787/auth/github/callback` (`wrangler dev`). The same section has the token-expiry,
       authorize-during-installation and device-flow settings.
     - **Expire user authorization tokens: on.** Request user authorization during installation: off. Device flow:
       off. Setup URL: empty. Webhook: **Active off**.
     - Permissions:
       - Repository: Contents (read and write), Metadata (read; it's required), Pages (read and write).
       - Account: none. In particular, no email addresses.
     - Where it can be installed: **only on this account**, while it's the dev app.
     - After creating it:
       - Keep the **Client ID** (`Iv23…`). It isn't secret; it goes in `wrangler.jsonc`.
       - **Generate a client secret** and paste it only into `npx wrangler secret put GITHUB_CLIENT_SECRET --env dev`.
       - Don't generate a private key: signing in uses user tokens, which need none.
  4. **Secrets**, made without being printed. Each one goes to `npx wrangler secret put <NAME> --env dev`:
     - `SIGNING_JWK`: the jose one-liner in A2.
     - `NONCE_KEY`, `TOKEN_KEK`, `AUDIT_KEY` and `STATE_KEY`:
       `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'`.
     - `GITHUB_CLIENT_SECRET`: step 3.
  5. **A Cloudflare API token for CI:** My Profile → API Tokens → Create Token. Start from the "Edit Cloudflare
     Workers" template, add Account → D1 → Edit, and limit Account Resources to this account. Then, in this repo:
     - Settings → Environments → New environment `development`. Limit its deployment branches to `main`, and add
       the secret `CLOUDFLARE_API_TOKEN`.
     - Settings → Secrets and variables → Actions → Variables: `CLOUDFLARE_ACCOUNT_ID` (on the Workers overview).
       It isn't secret, and setting it turns on cd's `api-dev` job.
- **A1 · `packages/api` skeleton.** Hono on Workers, `wrangler.jsonc` with `dev`/`production` environments,
  `/health`, `observability` (logs + traces) on, tests running in workerd, and CI deploying `dev` to workers.dev.
  Verify the `traceparent` question, and that a request shows up as one trace in the dashboard.
  *Built 2026-10-15:* `src/index.ts` (Hono, secure headers, JSON 404/500, one span per request), `src/log.ts`
  (util's logger, with every record gated to an allowlist of fields before any output), and `test/api.test.ts`
  (wrangler's `createTestHarness`: the Worker in workerd, including a test that a request's query string and
  `Authorization` never reach the logs). Spans come from `@brianjenkins94/util/logger`. On Workers it logs JSON
  objects at their own console level, and with `setTracer(tracing)` every span has a counterpart in Cloudflare's
  traces (the native custom-spans API, `cloudflare:workers`). The request span is opened with a function
  (`log.span("request", attrs, async (span) => …)`), which makes it the runtime's active span for the whole request,
  so the runtime's own `fetch`, D1 and Durable Object spans nest under it. The allowlist gates both outputs: log
  records, and every attribute set on a trace span. A span's util ids ride along as `logger.trace_id` /
  `logger.span_id`. That's how a trace continued from the browser will be found in the dashboard, since Cloudflare
  exposes no span context of its own yet. The `api-dev` job in `.github/workflows/cd.yml` deploys `--env dev` once
  the repository variable `CLOUDFLARE_ACCOUNT_ID` and the `development` environment's `CLOUDFLARE_API_TOKEN` secret
  exist. Until then it's skipped. Still open: both verifications above, which need the first deploy.
- **A2 · DPoP core.** Port `dpop.ts`, add stateless nonces and the access-token signer with JWKS. Test against
  RFC 9449's examples, plus a negative test for every check: a wrong `htu`/`htm`, a stale `iat`, a replayed `jti`, a
  missing or wrong `ath`, a private JWK in the header, `alg: none`/HS256, and a mismatched `cnf.jkt`.
  - **Where it lives: `lib/util/auth/dpop.ts`** (decided 2026-10-15). Verifying a proof is RFC 9449 with nothing of
    the editor in it, so it's util's, beside the logger the Worker already uses. The contract keeps it free of
    storage and frameworks:
    - It takes the request's method and URL, the `DPoP` header, and the access token if there is one.
    - The caller supplies two things: whether a `jti` has been seen (the API answers from the Grant DO), and the
      current nonce.
    - It returns the key's thumbprint (RFC 7638) or a typed failure that names the check that failed.
  - The stateless nonce (an HMAC over a time window) goes there too. So, later, may the `at+jwt` access-token
    signer and verifier with `cnf.jkt`, since they're RFC 9068 plus a binding, also generic.
  - What stays in `packages/api`: which origins and methods are allowed, where `jti`s are stored, and the HTTP
    responses (`use_dpop_nonce`, `WWW-Authenticate`).
  - `jose` does the JWS work (it's audited, and it supports workerd), so it becomes one more util peer. Tests are
    the module's own `isEntry` self-test, as everywhere in util.
  - *Built 2026-10-15:* `@brianjenkins94/util/auth/dpop` has the following.
    - `verifyProof(request, { seen, nonce?, maxAge?, now? })` returns `{ ok, jkt, jti }` or `{ ok: false, error, reason }`.
      `error` is `invalid_dpop_proof` or `use_dpop_nonce`. `reason` is a fixed string that names the failed check and
      never quotes the proof.
    - `thumbprint` (RFC 7638) and `accessTokenHash` (`ath`).
    - `nonces(secret)` has `issue` and `check`: an HMAC of a 5-minute window, good for that window and the next.
    - `signAccessToken` and `verifyAccessToken`: `at+jwt`, with `cnf.jkt`, `iss`, `aud`, `exp` and `jti`. `publicKey`
      gives a key's public half, for the JWKS.
    - The self-test verifies RFC 9449's own example proofs (Figures 2 and 13). The key's thumbprint equals the RFC's
      example `cnf.jkt`. The test also fails a proof for each check: missing, malformed, wrong `typ`, private key, HS256,
      `none`, wrong key, too old, in the future, `htm`, `htu`, `jti`, `ath`, bound key, replay, nonce. A proof that's
      rejected records no `jti`.
    - Disabling any one check in turn (8 mutations) makes the self-test fail.
  - The Worker serves `/.well-known/jwks.json` from the `SIGNING_JWK` secret (tested: the public half, never `d`). To
    make that key, without it ever being printed:

    ```sh
    node -e 'import("jose").then(async ({ exportJWK, generateKeyPair }) => { const { privateKey } = await generateKeyPair("ES256", { extractable: true }); process.stdout.write(JSON.stringify({ ...await exportJWK(privateKey), alg: "ES256", kid: new Date().toISOString().slice(0, 10) })); })' | npx wrangler secret put SIGNING_JWK --env dev
    ```

  - Left for A3: the `seen` store (the Grant DO), issuing nonces in `DPoP-Nonce` headers, and the middleware that puts
    `verifyAccessToken` and `verifyProof` in front of a route.
- **A3 · sign-in.** The Grant DO, D1 schema and migrations, start/callback/token/refresh/revoke, token encryption,
  the audit log, and the redaction test. End-to-end against the dev GitHub App.
  - *Built 2026-10-15, everything but GitHub's round trip (that waits for A0):*
    - **`migrations/0001_accounts.sql`** (D1): `users` (our id, GitHub's numeric id), `grants` (one row per sign-in)
      and `audit`.
    - **`src/grant.ts`**, the Grant Durable Object, one per sign-in.
      - `begin` is the one call the GitHub callback will make. It creates the user on their first sign-in, seals
        GitHub's tokens (`src/seal.ts`: AES-GCM under `TOKEN_KEK`, bound to the grant's id), and returns a 60-second
        code.
      - `redeem` spends the code on any attempt, and needs the PKCE verifier and the key the sign-in started with.
      - `rotate` replaces the refresh token. If an old refresh token is presented again, it revokes the grant.
      - `use` records a proof's `jti` and reports whether the grant is live. `revokeWith` and `revoke` end it.
      - Codes and refresh tokens are `<grant id>.<secret>`, and only their hashes are stored.
    - **`src/tokens.ts`**: `POST /token` (authorization_code, refresh_token), `POST /revoke` (RFC 7009), and the
      `session` middleware.
      - Every request needs a DPoP proof with a server nonce. A `use_dpop_nonce` answer brings a fresh one.
      - A code or refresh token is checked against D1's `grants` before its Durable Object is addressed, since
        addressing one creates it. A token for a revoked grant is still audited.
      - `session` checks our access token, a proof from its key carrying its hash, a new `jti`, and a live grant.
        `GET /me` returns the user id behind it.
    - **`src/audit.ts`**: `login`, `token_issued`, `refreshed`, `token_rejected`, `refresh_reuse_detected` and
      `grant_revoked`, each with Cloudflare's country and an IP hash (an HMAC keyed by `AUDIT_KEY` and the date).
    - **CORS:** only the origins in `ALLOWED_ORIGINS`. `DPoP-Nonce` and `WWW-Authenticate` are exposed to the browser.
    - **Tests** (`test/sessions.test.ts`, workerd, 12 of them) cover:
      - the whole flow, and the same GitHub user signing in twice;
      - a code used with the wrong verifier, used twice, or with another key;
      - refresh-token reuse, which revokes the grant;
      - a refresh with another key's proof, which is refused while the grant lives on;
      - `/me` refusing a missing token, `Bearer`, another key, a proof without `ath`, a replayed proof, or a token we
        didn't sign;
      - revocation;
      - a forged grant id, which creates no Durable Object;
      - sealing at rest, and the sealed tokens gone after revocation;
      - IP hashing, and CORS;
      - last, a test that none of the 50+ secret values the run handled (codes, verifiers, our tokens, proofs,
        GitHub's tokens) appears in the logs.
    - **Mutation check:** disabling each guard in turn (9 mutations) makes a test fail. The first run found the
      unchecked `ath` gap, now covered.
    - **Secrets for A0**, made without being printed, each piped to `npx wrangler secret put <NAME> --env dev`:
      - `NONCE_KEY` and `AUDIT_KEY`: `node -e 'process.stdout.write(crypto.randomBytes(32).toString("base64url"))'`
      - `TOKEN_KEK`: the same command; it must be exactly 32 bytes.
      - `SIGNING_JWK`: see A2.
    - **GitHub's round trip** (`src/github.ts`, built 2026-10-15):
      - `/auth/github/start` takes the app's `redirect_uri` (an exact match against `REDIRECT_URIS`; otherwise a 400
        and no redirect), its S256 challenge, its key's `dpop_jkt` and its `state`. It sends the browser to GitHub
        with a PKCE pair of our own, and seals the rest into GitHub's `state` under `STATE_KEY` for 10 minutes.
      - `/auth/github/callback` exchanges GitHub's code (client secret plus our verifier), reads `/user` for the
        numeric id only, starts the Grant, and returns to the app with our code, its `state`, and `iss` (RFC 9207).
        A refusal at GitHub comes back as `access_denied`, and a failure as `server_error`.
      - `/.well-known/oauth-authorization-server` (RFC 8414) lets the shell's client find everything.
      - **Tests** (`test/github.test.ts`, 10) run against a mock GitHub. They check what GitHub is sent (our secret,
        the verifier matching the challenge GitHub saw, our callback), and that no login or email is kept. Each of
        the 9 guards, disabled in turn, fails a test.
    - **A real sign-in, against the deployed dev Worker (2026-10-15):** start → GitHub (authorized in Chrome) → callback
      → the app's page with its state and `iss` → `/token` 200 DPoP → `/me` 200 → refresh 200 (new refresh token) →
      `/me` 200 → `/revoke` 200 → `/me` 401. The live audit log shows one user for three sign-ins. A code that
      arrived after it expired was refused (`token_rejected`).
    - **Abandoned sign-ins end.** That first live run showed that a code never redeemed left its Grant holding
      GitHub's tokens indefinitely. Now `begin` sets an alarm for the code's expiry, and `abandon()` revokes a Grant
      that never got its first refresh token. Live: `login@+0s grant_revoked@+60s`.
    - **Still to do:**
      - Refreshing GitHub's token inside the Grant (A5 uses it).
      - Revoking GitHub's token at GitHub when we revoke a grant (`DELETE /applications/{client_id}/token`). Ours is
        wiped, so nothing can use it, but it stays valid at GitHub until it expires.
      - A sessions list with "sign out everywhere".
- **A4 · the shell.** Port `oauth-client.ts` into `packages/editor/shell/`, add `dpopProvider`, and swap the "Connect GitHub"
  popover for "Sign in with GitHub" plus a sessions list. **Remove the PAT path** once this works: keeping a token
  in `localStorage` as a fallback keeps the problem.
- **A5 · the proxy.** Allowlisted API and git smart-HTTP; retire `cors.isomorphic-git.org`; update
  `architecture-model.ts` (network nodes) and `ARCHITECTURE.md` (the shell row: it no longer holds a GitHub token).
  - *A4 and A5 built together, 2026-10-15* (the PAT could only go once GitHub was reachable through the proxy):
    - **Worker:**
      - `src/proxy.ts` allows exactly `shell/github.ts`'s calls, plus a clone's git reads, never a push.
      - `Link` headers are rewritten to point back at the proxy, and rate-limit headers are exposed.
      - The Grant refreshes GitHub's token one refresh at a time, and revokes it at GitHub on sign-out.
    - **Shell:**
      - `shell/session.ts` is the oauth4webapi client: a non-extractable key in IndexedDB, a full-page sign-in, the
        landing checked for its state and `iss`, a nonce retry, and one refresh at a time.
      - `dpopFetch` is the AuthProvider. `github.ts` maps fido's GitHub origin onto the proxy, and the clone gets a
        DPoP `http` client.
      - The popover reads "Sign in with GitHub", then "Signed in as …" with a "Choose repositories" link to the app's
        installation page and sign-out.
      - Signed out, public repos still load, from GitHub directly and through isomorphic-git's proxy, with no
        credential.
      - The PAT is gone, and a stored one is deleted on load.
    - **Verified in Chrome against the dev Worker:** sign-in, "Signed in as brianjenkins94" (GitHub's `/user` through
      the proxy), two public repos loaded through the proxied API and clone (all 200), then sign-out (`/revoke` 200,
      `grant_revoked` in the audit log).
    - **Tests:** 11 proxy tests in workerd (9 guards, each failing a test when disabled), and the shell's GitHub client
      test. The editor's full architecture suite passes, apart from one test that fails only under 5-way load and passes
      alone.
- **A6 · hardening, before any real user.** Previews and `?extension=` code on a separate origin; rate limits on
  `/auth/*` (Workers rate-limiting binding); account deletion; a privacy page that says what's in the table above;
  a security review of the whole flow (`/security-review` plus a manual walk through RFC 9449 §11 and the OAuth 2.0
  Security BCP, RFC 9700).
- **A7 · production.** The domain, the static-assets deploy with COOP/COEP headers, the prod GitHub App, and the
  deploy approval gate.

Then Stripe: customers keyed by our user id, webhooks verified by signature and processed idempotently (a D1 table
of seen event ids), and entitlements read by the Worker, never trusted from the client.

## Open questions

- Production domain name.
- Whether signed-out users keep cloning public repos through our proxy (costs requests) or straight from GitHub's
  API (no auth needed for public repos, but no git clone without a CORS proxy).
