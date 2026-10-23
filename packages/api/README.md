# The API, and the admin app

The editor's API Worker: our own OAuth 2.1 authorization server, signing people in (GitHub, an emailed code, a password,
a passkey) and spending their GitHub token for them through a proxy; and the admin app (packages/admin). What they do is
in the code. This keeps what isn't: why, what was decided and rejected, what isn't built, and how to run it. Step ids
(A0–A7 sign-in with GitHub, B1–B9 the admin app and behavior, C0–C7 sign-in methods, O1–O8 operations) are what the code
cites; each is in the section about it.

## Why: the threat model

The editor used to hold a pasted GitHub PAT in `localStorage` on `brianjenkins94.github.io`, an origin every Pages site
under that account shares; everything in the editor (previews running repo code, `?extension=` code) ran on that origin
unsandboxed; and clones sent the PAT through `cors.isomorphic-git.org`. So: **the GitHub token never comes to the
browser**, the browser holds only a credential that's useless if stolen, and whatever runs repo code should move off
the origin that holds it.

**Federated, because GitHub doesn't do DPoP.** A GitHub token in the browser can be copied out by anything on the origin
and used anywhere for 8 hours. The browser's tokens are ours: short-lived, DPoP-bound (RFC 9449) to a non-extractable
key, good only at our Worker, which keeps GitHub's token and spends it through a proxy allowing only the editor's calls.
- **DPoP does** make a stolen access or refresh token (logs, a trace, a copied IndexedDB) worthless without the key,
  and no script can export the key.
- **It doesn't** stop code running *on our origin* from using the key in place. Hence the proxy's allowlist (a hijacked
  session can only do what the editor does), and why previews and `?extension=` code belong on another origin.
  *Deferred (2026-10-15):* that isolation isn't built; detection is the mitigation meanwhile.

## Decisions

### Platform: Workers, Durable Objects, D1, Hono

- **Durable Objects give serialized, strongly consistent state per sign-in,** which the flow needs three times: GitHub
  refresh tokens are single-use (two refreshes at once log the user out), our refresh rotation needs reuse detection,
  and DPoP `jti` replay checks need read-then-write without a race. One Grant per sign-in does all three. **KV is
  eventually consistent and wrong for each,** which is also why not `@cloudflare/workers-oauth-provider` (KV-backed, no
  DPoP), and why KV is never a counter here.
- **Hono:** Workers-native, small, with the CORS and secure-headers middleware we'd otherwise write. The sms-reference-app
  (PartsTech's, unmaintained: read, never depended on) supplied the DPoP verifier, rotation and browser client as logic.
- Rejected: Deno Deploy (nothing like DOs' per-key serialization), Vercel or Netlify functions (the same, plus cold
  starts), Fly.io (a real server to run and patch).
- **Workers Paid since 2026-10-17:** Argon2id's CPU and email to any address need it, and a flood no longer takes the
  API down for the day at Free's 100k requests.

### A GitHub App, not an OAuth App

- An OAuth App's `repo` scope is read/write on every private repo the user can reach; a GitHub App gets fine-grained
  permissions on the repos the user picks, and its user tokens expire after 8 hours (6-month refresh token).
- Its token exchange needs the client secret even with PKCE, and has no CORS: a server was never optional.
- **No email permission:** an editor doesn't need an address, and not having one is the cheapest privacy measure there
  is. It's also why accounts are never linked by email. Creating repos would need Administration (write): decide when.
- **Two Apps,** dev and production: separate secrets, separate blast radius.

### Hosts and origins

| | App | API | GitHub App |
|---|---|---|---|
| local | `editor.localhost:5173`, admin `localhost:5174` | `localhost:8787` (`npm run harness`, `wrangler dev`) | dev |
| dev | `brianjenkins94.github.io/editor/` | `editor-api-dev.brianjenkins94.workers.dev` | `unusually-good-editor-dev` |
| production | `editor.` and `admin.unusuallygood.dev` | `api.unusuallygood.dev` | `unusually-good-editor` (App ID 5339846) |

- The credential is a header, not a cookie, so cross-origin is fine: no third-party-cookie blocking, no CSRF surface.
  CORS is the clients' own origins (src/clients.ts), never `*` or reflected.
- **unusuallygood.dev** (bought through Cloudflare, 2026-10-15) gets production off the shared `github.io` origin. The
  API is its own origin rather than under the app's path, so the editor's origin serves only static files and none of
  its requests count against the Worker. The apex 302s to the editor (browsers keep a 301 forever) until there's a
  landing page; `/tools/` and `/log/` aren't built.
- **editor-contrib forks** aren't allowed origins: a fork that wants sign-in brings its own Worker and GitHub App.

### Building in the open

The code is public, so its security has to hold with the code visible. Secrets live only in Cloudflare (ids and binding
names in wrangler.jsonc aren't secret); telemetry is private to the account; PRs get tests, never deploys (no
`pull_request_target`); dependencies are few, pinned exactly, at least a week old. Deploys use scoped Cloudflare tokens
held as GitHub Environment secrets. *Decided 2026-10-16, while this is early:* production promotes itself after cd, with
no required reviewer (one run left unapproved blocked every run behind it). Ticking Required reviewers on the
`production` environment restores the gate.

## Identity and the data we keep

| Data | Where | Why | Retention |
|---|---|---|---|
| our user id (random) | D1 `users` | what everything keys on | 30 days after account deletion |
| GitHub numeric id; email as typed (for those who use one) | D1 `identities` | stable identity; emailed codes | the same |
| passkeys: public key, sign count, transports, AAGUID, whether it syncs | D1 `passkeys` | signing in | until removed, or the account's |
| each sign-in: method (`github`, `email`, `passkey`, `password+totp`…), created, last used, a coarse device label | D1 `grants` | roles go by method; your sign-ins | the grant's |
| GitHub access and refresh token | the Grant, AES-GCM under `TOKEN_KEK` (with a key id, to rotate) | calling GitHub for the user | until sign-out, expiry or deletion |
| our refresh-token family, hashed | the Grant | rotation, reuse detection | the grant's |
| each request through a sign-in: action (route template), status, duration, trace id (O5) | the Grant | the admin app's timeline | 30 days, and 30 after the sign-in ends |
| what the editor reports: page shown, repo loaded (its keyed tag), command or pane (id), run, error id; never code, keystrokes or file contents (O6) | the Grant | the same | the same |
| errors: name, message and stack (secrets and addresses masked), route, release, the editor's last event names; the sign-in and user, or signed out only the IP's daily keyed hash (O4, O6) | D1 `errors`, `error_occurrences` | the id a person quotes finds the cause | occurrences 30 days; groups 90 after last seen |
| audit events | D1 `audit`, locked copies in R2 | the security record | 90 days; refusals and alerts a year |

- **Not stored:** login or avatar (fetched live through the proxy), raw IPs, and for GitHub users any email. Emailed codes
  only as an HMAC, for 10 minutes; the audit log has an address's keyed hash, never the address. Audit rows carry
  Cloudflare's country and an IP hash keyed per day: enough to spot abuse, not reversible.
- **Only account deletion is soft** (2026-10-17): everything stops at once (GitHub's authorization revoked, every grant
  ended), signing in within 30 days restores it, then the daily cron purges it. The audit log keeps its rows without
  the user's id: what happened stays on record, not whom it happened to. Everything else expires; nothing else is
  deleted.

## Tokens and the flow

Every client pushes its request first and signs in on our page (*Sign-in methods*); GitHub's leg is steps 1–2. What
isn't evident from the code is why each step is shaped so:
1. **Start:** the Worker makes its own PKCE pair for GitHub and seals everything into GitHub's 10-minute `state`, so the
   step needs no storage. A full-page redirect, since the shell's `COOP: same-origin` severs a popup's opener anyway.
2. **Callback:** only `/user`'s numeric id is read. The Grant's code is single-use, 60 seconds, bound to the client's
   challenge and key, so a stolen code is useless without the key. A code never redeemed ends its Grant at expiry (the
   first live run left one holding GitHub's tokens indefinitely).
3. **Token:** a 5-minute `at+jwt` with `cnf.jkt`, and a refresh token rotated on every use; a used one revokes the grant.
4. **Every request:** the Grant checks the `jti` once and refreshes GitHub's token once, serialized.
5. **Nonces** are an HMAC over a 5-minute window: no storage, and proofs can't be pre-computed.

The DPoP verifier, nonces and token signer are `@brianjenkins94/util/auth/dpop` (A2, decided 2026-10-15): RFC 9449 with
nothing of the editor in it, free of storage and frameworks, the caller supplying `seen` and the nonce.

### The proxy

Exactly the editor's API calls (src/behavior.ts) and a clone's git reads, never a push (`git-receive-pack` waits for
commit-back to move to git). It retired `cors.isomorphic-git.org` for signed-in clones. It never forwards our
`Authorization` or `DPoP` upstream, nor GitHub's token-bearing headers back.

## Sign-in methods

Built ourselves (C0–C7, 2026-10-17; linking and passkeys 2026-10-18). Better Auth's plugins and Pilcrow's auth book
(auth.pilcrowonpaper.com) were the references, for their edge cases. Trialed on the admin app first; both clients now
offer all four methods (src/clients.ts). Every method ends in `Grant.begin`: it only answers "which user is this".

- **The sign-in page is the API's** (static, CSP-locked): credentials are typed there, never on a client's page, so no
  app, nor code running on its origin, sees one. The hosted-login pattern; it's why the editor took the methods
  without changing.
- **PAR (RFC 9126, C1):** the browser carries only an opaque, single-use `request_uri`, so nothing in the redirect can be
  read or changed, and the DPoP key is proven at the push rather than named in the URL.
- **An attempt** (a Durable Object, 15 minutes, single-use) holds a sign-in that takes steps, by a `__Host-` cookie, so a
  code typed into another browser doesn't complete it (Pilcrow: bind the code to the session that started it).
- **Sensitive actions after sign-in** need their own check, never the sign-in's. *Departure:* that check is a sign-in in
  the last 10 minutes, not an emailed code, because a GitHub-only account has no email.
- **No lockouts anywhere** (an attacker could use them to lock someone out): token buckets instead.

### Email (C2)

- Addresses kept as typed, not lowercased, nothing stripped (Pilcrow: don't silently change input); matched
  case-insensitively.
- The email carries a link with the code, but the link signs in only in the browser that started; elsewhere it shows
  the code. Mail scanners open links.
- *Departure:* codes are stored as an HMAC under `CODE_KEY`, not Argon2 as Pilcrow suggests: Argon2 would double every
  check's CPU, and a key the database never holds means a leaked database can't be brute-forced offline. The HMAC
  includes the attempt, so checking is limited per attempt only: guessing in another attempt can't reach a code.

### Passwords and reset (C3, C4)

- Pilcrow's rules (printable ASCII, 10 to 100, no space at either end, no complexity rules), and known breaches refused
  through Have I Been Pwned's range API (k-anonymity; refused if it can't be asked).
- Errors say what's wrong (Pilcrow argues against "invalid email or password"): a hash's timing already says whether an
  account exists. A password account starts as an email account.
- A reset with two-factor on needs the second factor too. Ending other sign-ins is asked, not forced. A reset starts no
  session.
- *Departure:* **Argon2id at OWASP's baseline** (19 MiB, 2 passes, 1 lane), not Pilcrow's floor (16 MiB, 3): similar
  cost, more widely cited. A PHC string, so stronger costs later still verify the old.
- **The library:** `@noble/hashes` 2.4.0, pinned: audited, plain JavaScript, about 82 ms a hash. It replaced
  `@hallaxius/argon2w` (WebAssembly, about 13 ms) on 2026-10-21. That was chosen 2026-10-17 knowing it was two weeks old
  with one maintainer; it was then removed from npm with its author's account, breaking every install. Its hashes still
  verify (test/password.test.ts keeps one). Should speed matter, the tested faster one is `argon2-wasm-edge` (~21 ms;
  unmaintained since 2024).

### Two-factor (C5, C6)

- An authenticator app (RFC 6238), or email after a password. A GitHub sign-in isn't asked: it carries GitHub's 2FA.
- **Email as a second factor has a caveat, shown where it's turned on:** it stops someone with only your password, not
  someone with your inbox, which can reset the password (Pilcrow: don't use the reset channel as the second factor).
  The app is offered first, and wins when both are on.
- *Decided 2026-10-17:* no MFA requirement for owners for now; GitHub's 2FA covers their GitHub sign-ins.

### Linking accounts, and roles

- **Linked identities** (*decided 2026-10-18: the generally accepted shape,* as Auth.js's `accounts` and Supabase's
  `auth.identities`), one of each kind per account for now (a unique index, easy to drop).
- **Never linked automatically by email:** the GitHub App has no email permission, and matching by address is how
  accounts get taken over. A way in is linked only while signed in, finished through the sign-in that asked.
- Another account's way in merges only if that account holds nothing else (no other way in, password, two-factor,
  passkey or role), and the page asks first. Unlinking isn't built: it would have to say what happens to sign-ins made
  with the way removed. *Waiting:* the owner's own duplicate (bc2bc582…, email only): sign in to the admin app with
  GitHub, add that address from Your account, and merge it.
- **Roles follow how you signed in** (`canHoldRoles`, src/rbac.ts): GitHub, a passkey, or an authenticator app as the
  second step. Not an emailed code, a password, or both: with an email linked to the owner's account, each would make
  the inbox (which can reset the password) a key to it.

### Passkeys

- **The relying party is the API's own host only** (`api.unusuallygood.dev`, the dev worker's, `localhost`), not the
  site: only our pages can ask for a passkey, never an app's or a preview running someone's code on a subdomain.
- No second step after one: a passkey is a device and its PIN or face already. Supported, not pushed.
- **Later:** a passkey as a second step after a password; naming passkeys; conditional UI (passkeys in the email
  field's autofill).

### The editor (C7)

**Signing in stays optional:** the editor is whole signed out, no account exists until someone signs in, and nothing
asks them to. Signed in without GitHub, the shell reaches GitHub as signed out (public repos), and the proxy answers
`403 no_github`, not a 401 that would read as signed out. The legacy `/auth/github/start` stays for tabs left open from
before C7.

### The local harness (C0)

`npm run harness`, then `http://localhost:8787/__harness`: the API in Wrangler's test harness, an app in an iframe, and
everything stored, live, with what changed highlighted. It adds no routes, so none of it can deploy. Secrets are made
fresh each run, but `.dev.vars` (gitignored) can hold `GITHUB_CLIENT_SECRET` (the real dev App; without it, a GitHub
stand-in asks whom to be) and `ANALYTICS_TOKEN`. **WebKit can't sign in to it:** it drops the `Secure` `__Host-signin`
cookie over `http://localhost`. Production is https.

## Hardening

Cloudflare absorbs volumetric DDoS. What's left is ours: each request's cost, anyone probing, anyone sending something
huge, and low-rate abuse at an expensive route, which looks like a user. Hence the limits (src/limits.ts,
wrangler.jsonc), sizes checked before parsing, and no unauthenticated request creating storage.

### Detection

*Decided 2026-10-15 as the priority:* whatever gets past every limit should still be seen, at once. Not to watch users,
but to know what something tried and did if it gets through.
- The audit log has every refusal with its reason, and **every proxied call, reads as much as writes:** if a session is
  misused, what it read is what matters. The row is written before the answer streams.
- At most 8 proxied requests in flight per sign-in: GitHub's secondary limits punish concurrent requests, and a burst of
  clones is what a scripted session looks like.
- Token theft, probing and flooding raise alerts. *Decided 2026-10-15: no alert channel:* `ALERT_WEBHOOK` (ntfy, Discord
  or Slack) is unset, so they're only recorded; setting it turns them on. What must reach the owner goes by email (O1).
- `npm run audit` reads it (`--grant`, `--user`, `--ip <hash>`, `--event`, `--suspicious`, `--since 24h`).

### A tamper-evident audit log

Each D1 row is written once to R2 too (`editor-api-audit`, `editor-api-audit-dev`), under `routine/` or `suspicious/`.
- **Write-once twice over:** the Worker writes with `if-none-match: *`, and bucket locks refuse overwrites or deletes
  until the row's retention ends (expiry a day later, so R2 keeps nothing longer than D1).
- **D1's ids are AUTOINCREMENT, never reused,** so the id sequence is the chain: no hash chain, no single writer.
- `npm run audit -- --verify [--env production]` lists rows edited, deleted early, not copied, or missing (exit 1). It
  runs on your machine; the admin app's verify is a convenience, since a compromised Worker could lie about itself.
- **Protects against** a compromised Worker or someone with D1 access rewriting history. **Not** a compromised
  Cloudflare account (it can remove locks), nor a compromised Worker from then on (it could stop copying: "not copied").

### Still to do

1. **A WAF rate-limiting rule** on unusuallygood.dev: it blocks before the Worker runs, so blocked requests cost
   nothing. The zone's Free plan includes one rule.
2. **Durable Object IP bans** (fail2ban semantics), only if repeat offenders get past the limits.
3. **`limits.cpu_ms`,** now that we're on Paid.

Turnstile was ruled out when GitHub took every credential. Passwords and codes are typed on our page now, against
per-IP and per-user buckets; whether that's enough is open.

## Behavior (B7–B9)

What a sign-in usually does, and the ones that don't. **Zero-knowledge:** route templates, header names, counts and keyed
hashes only, never a path's values, a repository's name, a header's value, an IP in clear, or anything tying a model
count to a person. A flag points at a grant; the audit log says whose. Rules act at once; statistics refine them.

- **A script can't borrow the editor's sign-in:** DPoP binds it to the browser profile that began it, so a script signs
  in as its own client. "Signed in, then called the API directly" shows as a sign-in that never looked like the editor.
- **Actions come from the router and the proxy's allowlist,** so **new features are tolerated by construction:** a route
  that ships is in the vocabulary from that deploy, never a probe.
- **The client fingerprint** is taken at the first token and compared on every request. **Node's own `fetch` sends
  `sec-fetch-mode: cors` too, so `Origin` is what gives a script away.** A client that starts as `other` is recorded and
  alerted, not refused.
- **Tolerated:** a header *added* (a new editor or browser release sending something new) and the major version going up
  (an update). Strong: `origin` or `sec-fetch-*` omitted, browser family or OS changed, the version going down. Medium:
  `accept-language` or `accept-encoding` changed. A refresh takes tolerated changes in (it needs the sign-in's key).
- **The model** (B8): an action first seen in the last 7 days scores at most 4 bits, so a feature that just shipped
  doesn't make everyone look unusual; each flush scores before it learns, so a sign-in never explains itself. The counts
  start from a prior of the apps' own flows, since few use the editor yet; our end-to-end runs as a second source
  aren't wired. **Measured:** in tests, the editor's flow about 2.2 bits a step, an order the editor never uses about
  6.1, the next one alike about 5.2; a real admin sign-in, 3.1 bits over 8 steps.
- **Open:** how many probes, and how much change, before a sign-in is ended rather than flagged; whether scores alert.

## Visibility, and the redaction rule

1. **Traces, for debugging:** Cloudflare's Observability dashboard (Workers → editor-api → Observability), 7 days on
   Paid; the way out is an OTLP destination set in the dashboard, not code. Browser telemetry stays on-device
   (debug-mcp): shipping it off is a privacy decision of its own, deferred. *Still to verify:* whether tracing
   adopts an incoming `traceparent`, and what automatic spans record (query strings or `Authorization` would need it).
2. **The audit log, for security and the user:** not sampled, not a vendor's.
3. **Workers Logs, for the operator.** Cloudflare's invocation logs are off: they record each URL, the docs don't say
   what else, and they can't be redacted. The Worker writes its own request line.

**The redaction rule is code:** spans, logs and audit rows are built from an allowlist of fields (src/log.ts); anything
else is dropped, not masked. A test pushes a whole sign-in through and fails if any secret value reaches the output.

## Operations (O1–O8)

**The owner's decisions (2026-10-19):** a **$20 a day** budget; spend priced at **overage rates, ignoring the plan's
included amounts, so it overestimates** (a runaway shows early, never late); runaway costs email the owner and trip the
switch automatically; the switch takes down **the API only** (the sites are static and the editor works signed out);
"session replay" is an **event timeline** (no screen, code, keystrokes or file contents; signed-in people only); and
every switch **fails open** (one that can't be read mustn't turn every request into an error).

### The kill switch (O1) and narrower switches (O8)

- One D1 row, read at most every 10 seconds per isolate: on everywhere within seconds, no deploy. On, the API answers
  `503` before other work, except **the owner's way back in:** the admin app's sign-in by GitHub or a passkey (the
  methods that can hold a role), and `/admin/*` for the owner only.
- **Break glass,** when even the admin app can't be reached: `npm run maintenance -- off --env production` in
  packages/api, `wrangler d1 execute` with your own Cloudflare login (no secret endpoint to protect). The first Worker
  to read any flip audits and emails it, so break-glass flips are recorded like the rest.
- **Every flip emails the owner** (`ALERT_EMAIL`), reversing "alerts are log-only" for what must reach you: switches,
  the cost guard, the tripwire, new errors. At most five in fifteen minutes (asked for 2026-10-19); the rest are held
  and listed on the Mail page, which has **Send a test alert**.
- **Narrower switches** (O8, on the owner's ask for LaunchDarkly-like ones): `sign-ups` (by email, said only after the
  code, so asking reveals nothing about whose addresses have accounts), `email-codes` (two-factor by email can't finish
  meanwhile: the price of the switch), `github-proxy`. Not yet: audiences, editor features behind switches, the cost
  guard or tripwire pausing a part rather than the whole API.

### The cost guard (O2)

- Hourly, the account's last 24 hours from Cloudflare's GraphQL Analytics, priced from src/spend.ts (Cloudflare's
  pricing pages on 2026-10-19). The account's, both deployments: it's the account that's billed.
- Half the budget: an email, once a day. The budget: the switch on. After a person turns it off, the trailing 24 hours
  stay high, so for a day it trips only at double. Three hours blind: an email; blind isn't a trip.
- **Backstop:** Cloudflare's own billing notification (dashboard → Notifications → Usage Based Billing), your click, for
  when our check itself fails. First reading in production: $0.0015 a day.

### The tripwire (O3)

Defence in depth for "should they figure out how": it checks what a request read, not what the handler meant.
- A row naming a user other than the signed-in one, or the **canary account** (ids derived from `AUDIT_KEY`, so the
  public repo doesn't name them; no false positives by construction), is a breach: 500, the user's sign-ins ended, the
  switch on, the owner emailed. Admin permissions lift the watch; a deliberate cross-account read is marked
  `crossUser(…)` and reviewed like roles (one today, linking's in src/identities.ts).
- **Report-only for its first week:** another user's row only reports until `ENFORCE_FROM` (2026-10-26), so a missed
  legitimate read can't take the API down; the canary trips from the start. Tests always enforce and drive every
  watched route: **a new watched route needs a test.** Reviewed 2026-10-19: no reports, every `user_id` query read.
- Failed attempts are refused and audited as probes (*Behavior*); the tripwire is for a read that **succeeded**.

### Errors and timelines (O4–O7)

- **Errors get an id the person can quote,** so "it broke" is one click from their words to the cause. Signed-out
  editor errors are taken too, anonymously: worth knowing from everyone, recording no one. The shell reports (it holds
  the sign-in), never under automation. The owner is emailed for a new group (at most hourly) and a surge.
- Trace ids are shown, not linked: the dashboard finds them.
- **Readable stacks (O7):** production's hidden source maps go to R2 (`editor-source-maps`, one bucket for dev and
  production, since a release is a commit), never served by the site. About 90 maps and 28 MB a release; with a 45-day
  lifecycle, ~13 GB at ten deploys a day, cents a month. Not fatal if the step fails.

### Open questions

- The price table's rates, and whether to subtract the plan's included amounts (more accurate, less early).
- Whether the tripwire should watch the Grant's and Attempt's own reads (by their own id, so a breach there needs a wrong
  id passed in, which the D1 watch would see first).
- Error and timeline retention beyond 30 days, if investigations need it.
- Editor error groups: minified names change each release, so one error can make a new group each time. Mapping the top
  frames when it's recorded would fix that; worth it if the Errors page gets noisy.
- Whether signed-out users clone public repos through our proxy (costs requests) or keep going to GitHub directly (no
  clone without a CORS proxy).

## Runbooks

Commands run in packages/api. Nothing goes into the repo or a chat but ids.

### A0 · dev accounts

Done 2026-10-15; A7 repeats it for production.
1. **Cloudflare account,** and its `workers.dev` subdomain (the account's, in Workers & Pages' account details). Then
   `npx wrangler login`.
2. **D1:** `npx wrangler d1 create editor-api-dev`; its `database_id` goes in `env.dev`.
3. **The dev GitHub App** (Settings → Developer settings → GitHub Apps → New): made as `editor-dev-brianjenkins94`,
   renamed `unusually-good-editor-dev` to pair with production's. Homepage `https://brianjenkins94.github.io/editor/`.
   - Under "Identifying and authorizing users" (General → Edit), "Add redirect URI":
     `https://editor-api-dev.<subdomain>.workers.dev/auth/github/callback` and `http://localhost:8787/auth/github/callback`.
   - **Expire user authorization tokens: on** (under "Optional features", on by default; it offers only "Opt-out").
     Authorization during installation, device flow: off. Setup URL empty. Webhook **Active off**.
   - Repository permissions: Contents and Pages (read and write), Metadata (read). Account: none, in particular no email
     addresses. Installable only on this account.
   - The Client ID (`Iv23…`) goes in wrangler.jsonc's `GITHUB_CLIENT_ID`. Generate a client secret straight into
     `npx wrangler secret put GITHUB_CLIENT_SECRET --env dev`. No private key: user tokens need none.
4. **Secrets,** below, each with `--env dev`.
5. **CI's token:** My Profile → API Tokens, the "Edit Cloudflare Workers" template plus Account → D1 → Edit, this account
   only. In the repo: environment `dev` (branches `main`) with the secret `CLOUDFLARE_API_TOKEN`, and the Actions
   variable `CLOUDFLARE_ACCOUNT_ID`, which turns on cd's `dev` job.

### A7 · production

Live since 2026-10-15; `.github/workflows/production.yml` deploys the API, the editor, the admin app and the apex.
1. **The GitHub App,** as A0's step 3 except: named `Unusually Good Editor` (slug `unusually-good-editor`, which
   packages/editor/shell/address.ts names; change it there if GitHub gives another); homepage
   `https://editor.unusuallygood.dev/`; one redirect URI, `https://api.unusuallygood.dev/auth/github/callback`;
   installable on **any account**.
2. **D1:** `npx wrangler d1 create editor-api`.
3. **Secrets:** every one fresh, `--env production`, none shared with dev.
4. **Its own Cloudflare token:** Account → Workers Scripts, D1 and Workers R2 Storage (O7's maps) → Edit; on the zone
   unusuallygood.dev, Workers Routes → Edit, DNS → Edit, Zone → Read (custom domains are made on deploy).
5. **GitHub:** environment `production`, branches `main`, secret `CLOUDFLARE_API_TOKEN`, no required reviewer. Commit the
   ids, then set the repository variable `PRODUCTION_DEPLOYS` to `on`.
6. Then the WAF rule (*Still to do*).

### Secrets

Made without being printed, each piped to `npx wrangler secret put <NAME> --env <dev|production>`:
- `NONCE_KEY`, `TOKEN_KEK` (exactly 32 bytes), `AUDIT_KEY`, `STATE_KEY`, `CODE_KEY` (emailed and recovery codes' HMAC),
  `TOTP_KEK` (authenticator secrets): `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'`
- `SIGNING_JWK` (access tokens; `/.well-known/jwks.json` publishes its public half):

  ```sh
  node -e 'import("jose").then(async ({ exportJWK, generateKeyPair }) => { const { privateKey } = await generateKeyPair("ES256", { extractable: true }); process.stdout.write(JSON.stringify({ ...await exportJWK(privateKey), alg: "ES256", kid: new Date().toISOString().slice(0, 10) })); })' | npx wrangler secret put SIGNING_JWK --env dev
  ```

- `GITHUB_CLIENT_SECRET`, from the GitHub App. `ALERT_EMAIL`, your address, typed by you (without it, owner alerts are
  only logged). `ALERT_WEBHOOK`, unset by decision.
- `ANALYTICS_TOKEN`: the `editor-analytics` Account API token, read-only (Account Analytics Read, and Analytics Read on
  unusuallygood.dev). In dev, production and the harness's `.dev.vars`.

### R2

- Each audit-copies bucket: `npx wrangler r2 bucket create <bucket>`;
  `npx wrangler r2 bucket lock add <bucket> routine-90d routine/ --retention-days 90` and
  `… suspicious-365d suspicious/ --retention-days 365`;
  `npx wrangler r2 bucket lifecycle add <bucket> routine-expire routine/ --expire-days 91` and
  `… suspicious-expire suspicious/ --expire-days 366`.
- `editor-source-maps`: a lifecycle rule forgetting objects after 45 days.

### Email

- **Done 2026-10-17:** Workers Paid (email to any address needs it; 3,000 a month included, then $0.35 per 1,000), and
  unusuallygood.dev onboarded in Compute → Email Service → Email Sending, which adds the SPF, DKIM, DMARC and bounce
  (`cf-bounce`) records. Mail goes from `no-reply@unusuallygood.dev` only.
- **Our inbox:** Email Routing sends `smoke-test@unusuallygood.dev` (production) and `smoke-test-dev@` (dev), `INBOX` in
  wrangler.jsonc, to the Worker's `email` handler. The daily smoke test signs in by email through it: real delivery and
  our DNS, with no one's mailbox.
- The suppression list needs an Email Sending Edit token to read, so the Mail page doesn't show it.

## Steps

- **A1** the Worker; **A2** DPoP in util; **A3** sign-in, the Grant, the audit log; **A4** the shell's client, the PAT
  gone; **A5** the proxy: built 2026-10-15.
- **A6 · before real users:** rate limits and account deletion built; preview isolation deferred (*Why*); still to do: a privacy page
  of *Identity and the data we keep*, and a security review (RFC 9449 §11, RFC 9700).
- **Then Stripe:** customers keyed by our user id, webhooks verified by signature and processed idempotently,
  entitlements read by the Worker, never trusted from the client.

## Admin app

packages/admin, at `admin.unusuallygood.dev` (B5). Today the platform owner looks after users, sign-ins, the audit log,
traffic, mail and errors there; later, customers' organization admins manage their own members. Part of the product,
not an ops tool: it signs in with the product's identity, and every permission comes from one role model. `npm run dev`
there (5174) against `npm run harness` here, or `VITE_API`. Built 2026-10-17: B1 roles and the `admin` client, B2 the
read endpoints, B3 the app, B4 traffic, B5 production, B6 the first write (ending a sign-in), B7–B9 *Behavior*.

### Why not something off the shelf

- **Cloudflare's dashboard** stays the place for raw infrastructure, but can't show our domain (a user, their sign-ins,
  the audit timeline, the tamper check), and can never be opened to a customer.
- **Hosted identity with a console** (Clerk, WorkOS, Auth0, Logto; Better Auth as a library) means giving up DPoP-bound
  tokens and the audit log, or running two identity systems.
- **Authorization engines** (OpenFGA, SpiceDB, Cerbos, Oso) answer fine-grained sharing. A role table answers
  everything now; if permissions grow per repo or team, one replaces src/rbac.ts behind the same `requires()`.
- **Admin UI frameworks** (react-admin, Refine) earn their keep on many create-and-edit screens, and are React. Web
  Awesome, already the shell's, has the shapes an admin needs.

### Roles and permissions

- Permissions and roles are in code (src/rbac.ts), reviewed like any change; each admin route names its permission
  (src/admin.ts), so the route table is the access-control table. `viewer` is what only reads; a permission named
  `…:read` added later is a viewer's too.
- **Owners and viewers live in config, not the database:** `OWNERS` and `VIEWERS` in wrangler.jsonc, GitHub ids (not
  addresses, so the public repo names no one's email). Nothing through the API can grant one, so a compromised admin
  session or a bad database write can't make another; adding one is a reviewed commit. Both need a sign-in that can
  hold a role (*Linking accounts, and roles*).
- Checked on every request, never from token claims, so a role taken away is gone at once.
- Later, organization roles as rows (`organizations`, `memberships`), every change audited.

### Admin sessions are separate from editor sessions

The admin app is its own OAuth client, `admin`, beside `editor`, with its own pages. `/admin/*` takes only `admin`
tokens and `/github/*` only `editor` ones, so code on the editor's origin (the analytics beacon today, previews later)
can never use an editor session to reach admin data, even the owner's. It signs in as the editor does: PAR through the
API's sign-in page (`util/auth/client`, shared with the shell; decided 2026-10-17).

### Its own origin

Static assets only (packages/site/admin.jsonc). A CSP of its own files, the API and GitHub's API (logins),
`frame-ancestors 'none'`, and Cloudflare's Web Analytics beacon, **allowed by choice** (2026-10-17: Cloudflare injects it
zone-wide and serves the page anyway).

### The admin API

- Every admin request is audited (`admin_access`, 365 days): who looked at a user's data is part of the record.
- Cloudflare's data comes through `ANALYTICS_TOKEN`; the browser never holds a Cloudflare credential.
- **GitHub logins are looked up live, never stored** (*decided 2026-10-17*): GitHub allows 60 unauthenticated lookups
  an hour, so the app looks up what's on screen and keeps the answers for the session.

### The UI

Web Awesome's pattern library is Pro (paid); the free package ships the same shapes as recipes in its design skill
(`dist/skills/webawesome-design/references/patterns.md`), so the app is built from those (*decided 2026-10-17*). Preact,
as in the shell.

### The Mail page

Our audit log and Cloudflare's Email Service analytics side by side, counts only, never an address. Cloudflare's
records are the zone's, dev's and production's together; a local API has none. Writing to users isn't planned.

### The architecture page

Derived from code, each half from what's authoritative for it: the deployment as configured (every wrangler config,
read at build, deployment.ts) and the API as it runs (`GET /admin/architecture`). Its own renderer, not the editor's.
Names and counts, never a row. `#/architecture?as=production` draws production's deployment around a local API.

### Open

- **Cloudflare Access in front of the owner's routes,** a second, independent gate: worth it once customers' admins
  share the app.
- Later: organizations and their admins in the same app; billing.
