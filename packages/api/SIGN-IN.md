# Sign-in methods

Status: **design, 2026-10-17; C0 to C6 built,** C2 sending for real in dev and production since 2026-10-17. Decided: build it ourselves, trial it on the admin app, move to
**Workers Paid** (for Argon2id's CPU and email sending), add a local debug harness first (C0), and push authorization
requests (PAR) in C1. Still open: "Open questions".

Today GitHub authenticates everyone and the API only issues tokens (README.md, "Tokens and the flow"). This adds methods
of our own: an emailed code or link, passwords with reset, and optional MFA by authenticator app or email. They're built
here, not pulled in. Better Auth's plugins (magic link, email OTP, two-factor, password reset) and Pilcrow's auth book
(auth.pilcrowonpaper.com) are the references, read for their edge cases. **They're trialed on the admin app first**
(packages/admin); the editor keeps GitHub-only sign-in until the trial is done.

## What stays the same

Every method ends where GitHub's does: once we know who someone is, `Grant.begin` starts the sign-in, and everything
after it is unchanged: DPoP-bound tokens, refresh, the audit log, roles, the admin client. A method only answers
"which user is this", and records how (`login` rows gain the method).

## The shape

### The sign-in page lives on the API's origin

- An OAuth client (the admin app, later the editor) sends the browser to `/auth/start` (today's `/auth/github/start`,
  generalized), as now. Instead of going straight to GitHub, the API shows **its own sign-in page**: GitHub, email,
  password, as the client allows.
- Passwords and codes are typed into the API's page, never the client's: no client app (and no code running on its
  origin) ever sees a credential. It's the hosted-login pattern every identity provider uses, and the reason the
  methods can roll out to the editor later without the editor changing.
- The page is static (Workers static assets beside the API Worker, Web Awesome's login card recipe), posting to the
  API's endpoints.
- **Methods are per client:** `admin` gets GitHub, email and password during the trial; `editor` stays GitHub-only.

### Clients push their requests first (PAR, RFC 9126)

- The client POSTs its authorization request (redirect page, PKCE challenge, state) to `/auth/par` with a **DPoP
  proof**, and gets an opaque, single-use `request_uri` that expires in minutes. The browser then goes to `/auth/start`
  with only `client_id` and `request_uri`: nothing in the redirect can be read or changed, and the DPoP key is proven at
  the first request rather than named by a thumbprint in the URL.
- The push is what creates the attempt (below). oauth4webapi, which the clients already use, does PAR.
- Modeled on sms-reference-app's `app/auth/par.ts` and `authorize.ts` (PartsTech's reference app, unmaintained; read,
  not depended on).
- PKCE is unchanged: S256, required, checked by the Grant.

### An attempt holds a sign-in in progress

- A sign-in that takes steps (email, then code; password, then second factor) is an **attempt**: its own Durable Object,
  like a Grant, holding the client's PKCE challenge, DPoP thumbprint, redirect page and state, the user once known, and
  which steps are done. It expires after 15 minutes and is single-use: once it ends in `Grant.begin`, it's spent.
- The browser holds it by an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookie on the API's origin, so a code typed
  into another browser doesn't complete it (Pilcrow: bind the code to the session that started it).
- An attempt is for one authentication only. Sensitive actions after sign-in (change password, set up or remove MFA,
  change email, delete account) need a fresh, **action-specific** check, single-use, never the sign-in's.

### Email

- **Sending:** Cloudflare Email Service (`send_email` binding), from `no-reply@unusuallygood.dev`, with SPF, DKIM and
  DMARC set on the zone. Sending to any address needs the Workers Paid plan (3,000 a month included). See "Open
  questions".
- **Stored** in a new `emails` table (user, address, verified_at), as typed: not lowercased, no aliases stripped
  (Pilcrow: don't silently change input). Unique per address. This reverses "we keep no email" for users who choose
  email; GitHub-only users still have none. The README's "Identity and the data we keep" changes with it.
- **Codes:** 8 characters from 32 (uppercase and digits, no I, O, 0 or 1), at least 40 bits. Valid 10 minutes, spent on
  use, replaced by a new one per attempt. Stored as an HMAC under a secret key, not plain SHA-256 (see "Departures").
- **Links:** the same email carries the code and a link holding it. The link completes the sign-in only in the browser
  that started it (the attempt cookie); anywhere else it shows the code to type. Pilcrow prefers codes; mail scanners
  that open links are why the link alone never signs anyone in.
- **Rate limits:** sending, 1 a minute and 5 an hour per address; checking, a token bucket of 5 refilling 1 a minute
  per attempt and per user. No lockouts (an attacker could use them to lock someone out).

### Passwords

- **Rules (Pilcrow):** printable ASCII, 10 to 100 characters, no leading or trailing space, no complexity rules, nothing
  changed silently, explicit errors.
- **Breached passwords refused,** via Have I Been Pwned's range API (k-anonymity: only the first 5 characters of the
  SHA-1 leave us).
- **Hashing:** Argon2id, 19 MiB memory, 2 iterations, parallelism 1 (OWASP's current Argon2id baseline; Pilcrow's floor
  is 16 MiB, 3 iterations), 16-byte random salt, 32-byte hash, verified in constant time. That's tens of milliseconds of
  CPU: more than the Free plan's 10 ms (see "Open questions").
- **Rate limits:** a token bucket per user, 5 refilling 1 a minute (Pilcrow), and per IP, loosely. No lockouts.
- **Errors say what's wrong** (Pilcrow argues against "invalid email or password"); the timing of a hash already tells
  anyone who asks whether an account exists.
- A password is set while signed in (an action-specific check first), never at account creation by email alone: a
  password account starts as an email account.

### Password reset

- From the sign-in page: a code to the account's verified email, then a new password.
- **If MFA is on, the second factor is required too** (Pilcrow: email alone isn't enough to reset). Recovery codes count.
- After a reset: offer to end every other sign-in (Pilcrow: ask, don't force), always audited. The reset's own attempt is
  spent; it starts no session by itself, the user signs in with the new password.

### MFA, optional

- **Authenticator app (TOTP, RFC 6238):** SHA-1, 6 digits, 30 seconds, one step either side, each code accepted once.
  Enrolled by scanning an `otpauth://` QR code and confirming a code. The secret is sealed under a key of its own, like
  GitHub's tokens.
- **Recovery codes:** 10, shown once at enrollment, stored hashed, each single-use; regenerating replaces them all.
- **Email as a second factor,** as asked, with a caveat that belongs in the UI: if the same inbox can also reset the
  password, email MFA stops a stolen password but not a stolen inbox (Pilcrow: don't use the reset channel as the second
  factor). An authenticator app is the stronger choice and the one offered first.
- **When it's asked:** after the first factor, before `Grant.begin`. It applies to password and email sign-ins;
  a GitHub sign-in already carries GitHub's own 2FA.
- **Per-role policy:** a role can require MFA. Proposed (not adopted for now, 2026-10-17: C5): `owner` must pass an authenticator code (or recovery code) to
  open the admin app, however they signed in, GitHub included.
- Turning MFA off needs a fresh second factor and is audited.

### Accounts and linking

- A user can have GitHub, an email, or both, linked **only while signed in** (prove the second while holding the
  first). Never automatically: the GitHub App has no email permission, and matching by address is how accounts get
  taken over.
- An email sign-in for an address we don't know creates a user once the code is confirmed (admin trial: anyone can
  have an account; the admin app shows nothing without a role).

### Audit

Every step is an audit row: codes sent and checked, passwords set and refused (with reason), resets, MFA enrolled,
used, refused and removed, recovery codes used, links made. All of them alarm-worthy when refused repeatedly, as
`auth_refused` already is.

## Departures from the references

- **Codes are stored as an HMAC under a secret key,** not with Argon2 as Pilcrow suggests. Argon2 would double the CPU
  of every code check; an HMAC with a key the database never holds means a leaked database can't be brute-forced
  offline, and codes live 10 minutes.
- **Argon2id parameters follow OWASP (19 MiB, 2 iterations)** rather than Pilcrow's floor (16 MiB, 3): similar cost,
  the more widely cited baseline.

## Steps

Each lands green, tested in workerd, and is tried on the admin app before the next.

- **C0 · a local debug harness.** *Built 2026-10-17* (`harness/`): `npm run harness`, then
  `http://localhost:8787/__harness`; `recorded()` in `harness/state.ts`, first used by `test/harness.test.ts`. GitHub
  sign-in through it goes to a GitHub stand-in (harness/github.ts: sign in as the owner or someone new) unless
  `.dev.vars` (gitignored) has the dev app's `GITHUB_CLIENT_SECRET`.
  Modeled on sms-reference-app's: `npm run harness` in packages/api runs the API in
  Wrangler's test harness and serves a page with an app in an iframe beside a live, redacted view of everything stored:
  D1's tables, each Durable Object's storage (Grants, attempts), the R2 audit copies, the audit log's tail, with what
  changed since the last look highlighted. It adds no routes to the Worker, so nothing of it can be deployed. The same
  reading code gives tests `recorded(action)`: exactly what an action wrote, to assert on.
- **C1 · PAR, the sign-in page and attempts.** *Built 2026-10-17:*
  - `POST /auth/par` (src/signin.ts): the same checks as the legacy start, plus a DPoP proof with our nonce; makes an
    `Attempt` (src/attempt.ts, binding `ATTEMPTS`) and answers `201 { request_uri, expires_in: 120 }`.
  - `GET /auth/start?client_id&request_uri`: opens the attempt once, within 2 minutes, for its own client; sets
    `__Host-signin` (`HttpOnly; Secure; SameSite=Lax`, 15 minutes) and goes to `/sign-in`.
  - `/sign-in` (public/: static assets beside the Worker): our own files and Cloudflare's Web Analytics beacon only
    (CSP `script-src 'self' https://static.cloudflareinsights.com`, `frame-ancestors 'none'`); it asks `GET /auth/attempt` what
    the attempt's client offers (`SIGN_IN_METHODS` in wrangler.jsonc: GitHub, email and a password for both clients
    since C7).
  - `GET /auth/github`: on to GitHub with the attempt's id sealed in the state; the callback finishes the attempt only
    in the browser holding its cookie, before GitHub's code is exchanged, and clears the cookie. An attempt is spent
    either way; it's deleted when its 15 minutes are up.
  - Every refusal is a `sign_in_refused` row with its reason. The legacy `/auth/github/start` stays for editor builds
    from before C7 (a tab left open); nothing current uses it.
  - `test/signin.test.ts`, 7 tests in workerd; turning off the secret or single-use checks fails them. The admin app
    (B3) is the first real client.
- **C2 · email.** *Built 2026-10-17* (src/email.ts, src/mail.ts; the Attempt's `email_step`; migrations/0007):
  - `POST /auth/email` (`address`): checked as typed (no trimming, at most 254 characters), sending limited per
    address, one a minute and five an hour (by the address's own `email_code_sent` rows: a keyed hash, never the
    address), then a code (8 symbols of 32, 40 bits) and a link holding it sent; the attempt keeps the code's HMAC
    under `CODE_KEY` (a new secret), bound to the attempt, for 10 minutes. A new code replaces the last, not the tries.
  - `POST /auth/email/verify` (`code`, case and dashes ignored): 5 tries a bucket, one back a minute; a match ends the
    attempt and finds the address's user, case-insensitively (`emails`, unique on `lower(address)`, stored as typed),
    or makes one, and starts the sign-in (`Grant.begin`, generalized: a user found by another method; the `login` row
    says which). The page goes on to the app's redirect page, as GitHub's callback sends it.
  - The link is `/sign-in#code=…`: the page sends it as if typed, in the browser that started; elsewhere it shows the
    code to type there. A mail scanner opening it does nothing.
  - `users.github_id` may be null (migrations/0007 rebuilds `users`, rows kept; checked against existing rows).
  - Sending: src/mail.ts, Cloudflare Email Service's `send_email` binding (`EMAIL`), from `no-reply@unusuallygood.dev`;
    in the harness and tests, an outbox stand-in (`EMAIL_OUTBOX`): the harness page's Outbox shows every code and link.
    `/auth/attempt` offers email only where it can be sent and `CODE_KEY` is set; `SIGN_IN_METHODS` offers it to the
    admin app everywhere, so it appears once an environment is set up.
  - The email's bodies are src/email-code.txt and .html (`{{placeholders}}`, escaped in the HTML).
  - The admin app shows a user without a GitHub account as "by email", not their address.
  - 7 tests in test/email.test.ts, in workerd, against an outbox of the test's own: the whole flow and a new user by
    email alone, the same user whatever the case, a code only in its own browser, the tries, the sending limit, what's
    stored (never the code, the address only hashed in the log). Tried with the harness: a wrong code, the link in
    the browser that started (signed in, a new account with no roles: "No access"), the link elsewhere (the code to
    type).
  - **Departure:** checking is limited per attempt only, not per user as well: a code is bound to its attempt (its
    HMAC includes the attempt's id), so guessing in another attempt can't reach it.
- **Email in production** (*done 2026-10-17*): the account on **Workers Paid**
  (sending to any address needs it; 3,000 emails a month included, then $0.35 per 1,000), and unusuallygood.dev
  **onboarded** in Compute → Email Service → Email Sending (it adds the SPF, DKIM, DMARC and bounce records on
  `cf-bounce`); then the `send_email` binding in dev's and production's configs (from `no-reply@unusuallygood.dev`
  only), and `CODE_KEY` generated and put in both.
- **Linking accounts.** *Built 2026-10-18* (src/identities.ts, src/link.ts; migrations/0012). Before it, an email
  sign-in for someone who also had GitHub made a second, separate account (the owner's own email sign-in did).
  - **Linked identities** (*decided 2026-10-18: the generally accepted shape*): each way of proving who you are is a row
    in `identities` (`provider`, `subject`, `user_id`, `verified_at`), as Auth.js's `accounts` and Supabase's
    `auth.identities` keep them: `github` (GitHub's numeric id, as text) and `email` (the address as typed, unique
    whatever its case). `users.github_id` and `emails` moved there; `users` keeps our id. One of each per account, for
    now (a unique index, easy to drop). Only src/identities.ts reads or writes the table; a first sign-in makes its user
    and identity in one batch, so two at once make one user.
  - **Connect GitHub** (an account without it): `POST /account/github` (`return`: one of the app's own pages, by
    prefix) answers GitHub's authorize page; GitHub's callback hands its answer (whose account, its tokens) to the sign-in
    that asked, for 2 minutes, and goes back to the page with `link`; the app finishes with `POST /account/github/finish`
    through that sign-in, so a link started in one browser and answered at GitHub in another attaches nothing. GitHub's
    tokens become that sign-in's: the editor reaches private repos at once.
  - **Add an email** (an account without one): `POST /account/email/code` (`address`) sends a code bound to the user and
    the address; `POST /account/email` (`address`, `code`) attaches it. The code is spent once it's attached.
  - **Each needs a sign-in in the last 10 minutes** (the action's own check, as two-factor's changes): a stolen session
    can't quietly add its own way in.
  - **A way in that's another account's:** if that account holds nothing but it (no other way in, no password or
    two-factor, no role), the answer is `409 {error: "taken", account, mergeable: true}`, and the same request with
    `merge=1` moves it over: that account's sign-ins end and it's deleted as account deletion does (purged after 30
    days); `account_merged` on it, `identity_linked` on this one. Otherwise `mergeable: false`, saying whose. The page
    asks before merging.
  - **Roles follow how you signed in** (`grants.method`, the `login` row's, backfilled for earlier sign-ins): only a
    GitHub sign-in or one with an authenticator app as its second step (`…+totp`, `…+recovery`) holds a role
    (`canHoldRoles`, src/rbac.ts). An emailed code, a password, or a password and an emailed code don't: with an email
    linked to the owner's account, each would make the inbox a key to it. The admin app's No access card says so.
  - **On the page** (packages/account, both apps): "Ways to sign in", with Connect GitHub and Add an email while the
    account lacks one; coming back from GitHub, the page finishes the link (the admin app opens Your account at
    `#/account`, the editor its dialog). Unlinking isn't built (it would need to say what happens to sign-ins made with
    the way removed).
  - 6 tests in test/link.test.ts (connecting GitHub, then its sign-in the same account and the proxy working; only the
    app's pages, only the sign-in that started it, once, a recent sign-in; adding an email; merging an empty duplicate
    and refusing one with a password, from either side; an emailed sign-in to the owner's account holding no role). The
    migration tried on production-shaped rows (identities filled, methods backfilled, foreign keys clean). Tried in the
    harness: connecting GitHub from an email account, adding an email to the owner's, and a refusal.
  - The owner's duplicate (bc2bc582…, email only) is the first real case: sign in to the admin app with GitHub, add that
    address from Your account, and merge it.
- **C3 · passwords.** *Built 2026-10-17* (src/password.ts, src/password-hash.ts; migrations/0009):
  - **Setting one,** signed in, from the admin app's Your account page (reachable from the No access card too):
    `POST /admin/account/password/code` emails a code to the account's address (the action's own check, its HMAC in
    `action_codes`, bound to the user and the action; the address's sending limits shared with sign-in codes), then
    `POST /admin/account/password` takes the code (5 tries a bucket) and the password: Pilcrow's rules (10 to 100
    printable ASCII characters, no space at either end), then Have I Been Pwned's range API (k-anonymity; if it can't be
    asked, refused: "try again"). A refused password doesn't spend the code. `password_set` is audited.
  - **Signing in,** from the sign-in page ("Use a password instead"): `POST /auth/password` with the address and the
    password; errors say what's wrong ("no account with that email", "that account has no password: sign in with a
    code", "wrong password"); 5 tries a bucket per user, one back a minute, and the sign-in limit per IP; no lockouts.
    The `login` row says "password".
  - **Hashing:** Argon2id at OWASP's baseline (19 MiB, 2 passes, 1 lane, a 16-byte salt, a 32-byte hash) as a PHC
    string, so stronger costs later still verify the old; compared in constant time by us. The Argon2 itself is
    **@hallaxius/argon2w** (0.0.2, pinned exactly): Argon2's reference code as WebAssembly, its module imported (the
    runtime refuses to compile any at runtime, which is why hash-wasm can't be used as published), about 13 ms a hash
    in workerd. **Watch it** (chosen 2026-10-17 knowing it was two weeks old, one maintainer): read the diff before any
    upgrade; test/password.test.ts checks its output against Node's own Argon2id. Tested alternatives, should it need
    replacing: argon2-wasm-edge (hash-wasm's Argon2 for Workers, ~21 ms; its own verify compares with ===) and
    @noble/hashes' pure-JavaScript Argon2id (~82 ms).
  - 6 tests in test/password.test.ts (the hash against Node's, the rules, setting and signing in, breached and rule-
    breaking passwords and the breach check failing, the tries). Tried with the harness against the real Have I Been
    Pwned: an email account set a password ("password1234" refused: in 443,397 breaches), signed out, and signed in
    with it.
- **C4 · password reset.** *Built 2026-10-17* (src/password.ts): from the sign-in page, "Forgot your password?" in
  password mode. `POST /auth/reset` (`address`) emails a code ("to reset your password"), its HMAC bound to this
  browser's attempt, the account and the action, so it works only where it was asked for; `POST /auth/reset/password`
  (`address`, `code`, `password`, `end`) checks the code and the password as setting one does (the rules, known
  breaches; a refused password doesn't spend the code), stores it, and, when asked (a checkbox, on by default: asked, not
  forced), ends every sign-in of the account. The attempt is spent and no session starts: the page says to go back to
  the app and sign in with the new password. `password_reset` is audited with what was ended. With MFA on (C5), the
  second factor too (`second`: the app's code or a recovery code). 3 tests in test/password.test.ts (the whole reset with sign-ins ended and signing in
  again, sign-ins kept and the code bound to its browser, nothing to reset); the screens looked at in the harness.
- **C5 · authenticator-app MFA.** *Built 2026-10-17* (src/totp.ts, src/mfa.ts; migrations/0010; the Attempt's
  `first_factor`):
  - **TOTP** (src/totp.ts): RFC 6238 (its SHA-1 test vectors pass), HMAC-SHA-1, 6 digits, 30-second steps, one step
    either side, each step good once (the newest used is kept; taking it is conditional, so two requests can't both).
  - **Setting it up,** from Your account: `POST /admin/account/mfa/start` makes a secret (20 bytes), sealed under
    `TOTP_KEK` (a key of its own, set in dev and production) and bound to the user, pending; the page shows its QR code
    (uqr, as an image) and the key to type; `POST /admin/account/mfa/confirm` with the app's code turns it on and returns
    ten recovery codes (10 symbols of 32, 50 bits each), shown once, kept as HMACs under `CODE_KEY`, each good once.
    `mfa_enrolled`.
  - **At sign-in:** after an emailed code or a password, for an account with MFA, the attempt remembers whom it found and
    how (`first_factor`) and the page asks for the second (`POST /auth/second`): the app's code or a recovery code, 5
    tries a bucket. The `login` row says both ("email+totp", "password+recovery"). A GitHub sign-in isn't asked: it
    carries GitHub's own 2FA.
  - **Turning it off** (`mfa/off`) needs the app's code or a recovery code; **new recovery codes** (`mfa/recovery`) the
    app's code. `mfa_removed`, `mfa_recovery_codes`.
  - **The action's own check:** each of these needs a sign-in in the last 10 minutes. **Departure:** not an emailed
    code, because a GitHub-only account has no email; a recent sign-in is the check every account can pass.
  - 7 tests in test/password.test.ts (the RFC's vectors; setting up, its QR URI, the secret sealed; signing in with the
    app's code, each step once; a recovery code once, the second step needing a first, a password sign-in asked too; a
    reset needing it, turning it off needing a recent sign-in; off). Tried with the harness: set up from the QR page,
    the recovery codes shown, then an email sign-in with the app's code ("email+totp").
  - **The owner's policy** (*decided 2026-10-17*): not now. MFA stays optional for owners; GitHub's own 2FA covers
    their GitHub sign-ins.
- **C6 · email as a second factor.** *Built 2026-10-17* (src/mfa.ts, src/mfa-state.ts, src/action-codes.ts;
  migrations/0011):
  - **Asked for after a password only:** an emailed sign-in code already proves the inbox, so asking it again adds
    nothing. After a password, the account's email gets a code ("to finish signing in"), kept in the attempt's email
    step (its tries, once, this browser), and `POST /auth/second` takes it; the `login` row says "password+email".
  - **The app wins:** with an authenticator app on too, the app is what's asked for. A password reset with only email
    two-factor on asks nothing more (its code already went to the inbox).
  - **On and off** from Your account, each with an emailed code (`POST /admin/account/mfa/email/code`, then
    `POST /admin/account/mfa/email`, `turn` "on" or "off") and a recent sign-in. `mfa_enrolled`/`mfa_removed` "email".
  - **The caveat, shown where it's turned on:** it stops someone with only your password, not someone with your inbox
    (which can reset the password); an authenticator app, offered first, protects against both.
  - The action codes (setting a password, resetting it, email two-factor) now share src/action-codes.ts; whether a user
    has two-factor, and how, is src/mfa-state.ts (read by the sign-ins; changed only in src/mfa.ts).
  - 3 tests in test/password.test.ts (on, then a password sign-in asking for the emailed code; not asked after an
    emailed sign-in code, and off; the app asked for when both are on). The page looked at in the harness.
- **C7 · the editor.** *Built 2026-10-17.* **Signing in stays optional:** the editor is whole signed out (samples,
  public repos, everything local), no account is made until someone signs in, and nothing asks them to.
  - The editor's client pushes its request (`par: true`, packages/editor/shell/session.ts) and signs in through our
    page, which offers it GitHub, an emailed code and a password (`SIGN_IN_METHODS.editor`), two-factor as set up. The
    shell's button says "Sign in", with the optional said beside it.
  - **GitHub only for GitHub's sign-ins:** signed in by email or a password, the shell calls GitHub as it does signed
    out (public repos, anonymously); private repos and commits need a GitHub sign-in, and say so. The shell asks
    `GET /account` whose account it is (`githubId`), once a page (`connectGitHub`, shell/github.ts). The proxy answers
    such a sign-in `403 {"error":"no_github"}`, not the 401 that would read as signed out (`Grant.githubToken` is null
    for a sign-in that never had GitHub, undefined for one that's over).
  - **Your account, in the editor:** the account routes behind the editor's session too (`GET /account`, and
    `POST /account/password/code`, `/account/password`, `/account/mfa/{start,confirm,off,recovery}`,
    `/account/mfa/email/code`, `/account/mfa/email`): the admin app's handlers, client-agnostic. The page itself is
    packages/account, shared: the admin app's Your account and the editor's dialog ("Your account…" in the GitHub
    popover, loaded when opened), each passing how it reaches the routes.
  - Deleting an account without GitHub says nothing of GitHub's app.
  - 1 test in test/password.test.ts (an editor account by email alone; `GET /account`; the proxy's 403; a password set
    from the editor's routes, then a password sign-in back to the editor's page). Tried signed out in the browser: the
    popover, and a public repo loaded.
  - Linking (one account for GitHub and an email) is still pinned: an email sign-in and a GitHub one are two accounts.
- **Later:** passkeys (Pilcrow's recommendation for high-security accounts, and a way to drop passwords).

## Open questions

- ~~Argon2id's implementation.~~ Decided 2026-10-17: @hallaxius/argon2w (C3).
- ~~Email MFA as specified, or authenticator app only.~~ Decided 2026-10-17: as specified, with the caveat shown (C6).
- ~~The owner's MFA policy.~~ Decided 2026-10-17: not for now; optional for owners, GitHub's 2FA covering GitHub
  sign-ins (C5).
