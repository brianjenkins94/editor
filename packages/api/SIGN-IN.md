# Sign-in methods

Status: **design, 2026-10-17.** Nothing here is built. Decided: build it ourselves, trial it on the admin app, move to
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
- **Per-role policy:** a role can require MFA. Proposed: `owner` must pass an authenticator code (or recovery code) to
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
  sign-in through it needs the dev app's `GITHUB_CLIENT_SECRET` in `.dev.vars` (gitignored).
  Modeled on sms-reference-app's: `npm run harness` in packages/api runs the API in
  Wrangler's test harness and serves a page with an app in an iframe beside a live, redacted view of everything stored:
  D1's tables, each Durable Object's storage (Grants, attempts), the R2 audit copies, the audit log's tail, with what
  changed since the last look highlighted. It adds no routes to the Worker, so nothing of it can be deployed. The same
  reading code gives tests `recorded(action)`: exactly what an action wrote, to assert on.
- **C1 · PAR, the sign-in page and attempts.** `/auth/par` and `/auth/start` (generalized); the attempt Durable Object
  and its cookie; the static sign-in page; GitHub behind a choice; methods per client.
- **C2 · email.** The email provider and DNS records; `emails`; sign-in by emailed code or link; new accounts by email.
- **C3 · passwords.** Set a password (signed in); sign in with one; the breach check; Argon2id; rate limits.
- **C4 · password reset.** By email code, plus the second factor when MFA is on.
- **C5 · authenticator-app MFA.** Enrollment, recovery codes, the step at sign-in, turning it off; the owner's policy.
- **C6 · email as a second factor.**
- **C7 · the editor.** Its client gets the methods, after the admin trial.
- **Later:** passkeys (Pilcrow's recommendation for high-security accounts, and a way to drop passwords).

## Open questions

- **Argon2id's implementation.** The Workers runtime has no Argon2. The choices: a small, focused WebAssembly build
  (`hash-wasm`, a hashing primitive, not an auth framework), or PBKDF2-SHA256 at 600,000 iterations through the
  built-in Web Crypto (no dependency; OWASP-acceptable, weaker against GPUs than Argon2id).
- **Email MFA** as specified, with the caveat shown, or authenticator app only.
- **The owner's MFA policy:** required for the admin app, as proposed?
