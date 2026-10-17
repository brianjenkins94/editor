# Behavior

What a sign-in usually does, and the sign-ins that don't: scripts calling the API directly with a sign-in of their own,
an MCP server guessing at endpoints, a sign-in whose client changes under it. Zero-knowledge: everything here is kept as
route templates, header names, counts and keyed hashes, never a path's values, a repository's name or a header's value.
The rules come first and act at once; the statistics come later and refine them (heuristic floor, runtime ceiling).

Shown in the admin app (packages/admin/README.md, B7–B9).

## What exists

- The proxy allows only the GitHub calls the editor makes (src/proxy.ts). Anything else is `proxy_denied`, and a few
  in a short while end the sign-in (`Grant.denied`).
- Access tokens are DPoP-bound to a key the browser can't export, so every request of a sign-in comes from the browser
  profile that began it. A script can't borrow the editor's sign-in: it has to run the sign-in flow itself, as its own
  client, from the start. So "logged in, then made direct API calls" shows as a sign-in that never looked like the
  editor, more than as one that changed.
- Since B7, the rules below: probes, templated proxy rows, and each sign-in's client fingerprint. Not yet: anything
  that looks at order or timing (B8).

## Actions: a vocabulary derived from code

- Each request is an **action**: its method and route template, never the values in it. `GET /sessions`,
  `GET /github/api/repos/:owner/:repo/git/trees/:ref`. Our routes come from the router itself (Hono's `app.routes`), the
  proxy's from its allowlist (each entry named), so there's no list to keep.
- A signed-in request that matches no route is a `probe`, recorded with its method only (the path is what's being
  guessed, so it's kept as a keyed hash, enough to tell one guess from a repeat). A few probes in a short while end the
  sign-in, as proxy denials do.
- **New features are tolerated by construction:** a route that ships is in the vocabulary from that deploy on, so it's
  never a probe. The model also notes when each action was first seen, so the statistics below treat a new one as new
  rather than unlikely.
- `proxy_call` keeps the template, the repository's tag (`repo#` and a keyed hash of `owner/name`, lowercased) and a
  keyed hash of its other values (HMAC under AUDIT_KEY, as IPs are). "Was it repository X?" is the admin audit log's
  `repo` filter, which hashes X the same way; the log itself doesn't say which it was. A refused call (`proxy_denied`)
  and every other row about a proxied path (refusals, rate limits) keep only the method and a hash of the path.
- In src/behavior.ts: `PROXIED` (the templates, which the proxy allows and nothing else), `proxied`, `described`.

## Headers: a sign-in's fingerprint

- **Taken when the tokens are first issued** (`/token`, the code redeemed): which of a fixed set of headers the client
  sent, and a keyed hash of each value. The set: `origin`, `sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`,
  `user-agent`, `sec-ch-ua`, `sec-ch-ua-platform`, `sec-ch-ua-mobile`, `accept-language`, `accept-encoding`. The hashes
  are keyed per sign-in (AUDIT_KEY and the grant), so they compare within a sign-in and can't be matched across them.
  The browser family, its major version and the OS are kept in clear (the device label already says "Chrome on macOS").
- **Client kind** from the same headers: the editor's requests carry `Origin: https://editor.unusuallygood.dev` and
  Fetch Metadata (`sec-fetch-mode: cors`, `sec-fetch-site: same-site`). A script usually sends no Origin; Node's own
  `fetch` does send `sec-fetch-mode: cors`, so the Origin is what gives it away. A sign-in that starts as `other` is the
  direct-API case above: recorded at once (`client_unusual`, by which headers were missing) and alerted; it isn't
  refused.
- **Compared on every request** in `Grant.use` (every request already checks its DPoP proof there, so this costs no
  extra call). Each header of the set is `same`, `changed`, `omitted` (sent at first, missing now) or `added` (missing
  at first, sent now). The Grant keeps counts per header and outcome, not the requests. The first time a header changes
  in a way that matters, an audit row says so (`client_changed`, the header's name and how), once per header and way
  per sign-in (counted by how much it matters, so a tolerated change doesn't hide a later one that does). A strong one
  alerts.
- **What matters, and what's tolerated:**
  - Strong: `origin` or `sec-fetch-*` omitted (a browser became something else); the browser family or OS changed; the
    major version went down.
  - Medium: `accept-language` or `accept-encoding` changed.
  - Tolerated: a header `added` (a new release of the editor, or of the browser, sending something new); the major
    version going up (the browser updated). A refresh whose only differences are tolerated ones takes them into the
    fingerprint (refreshing needs the sign-in's key, so it's still the same client).

## The likely next action

- **Actions:** every signed-in request names its action as it reaches the Grant (`Grant.use`, from `signedIn`): the
  matched route's template (Hono's `routePath(c, -1)`, so a route added to the router is named the day it ships), the
  proxy's template for a proxied call, `(refused)` for a call the proxy refuses, `(no such route)` for a probe. The
  token endpoint's are `POST /token` (a sign-in's first action, then each refresh) and `POST /revoke`.
- A sign-in's actions in order, each with a coarse gap since the last (under 100 ms, under 1 s, under 10 s, longer),
  are a chain, starting from `(start)`. The model is how often each action follows each other one, by gap, across
  every sign-in: counts only, with no user or sign-in in them (D1 `transitions`, migrations/0006).
- **Where the counts live:** the Grant keeps its last action and its transitions since its last flush (its `walk` and
  `pending` tables), and adds them to the shared counts on an alarm an hour after its first unflushed step (`flush`,
  batched; also when the code-expiry alarm fires). The daily cron decays the shared counts (×0.97 a day, a half-life
  of about three weeks) and drops what has faded below 0.05, so the model follows the product as it changes.
- **The score** (`surprisal` in src/behavior.ts): each transition's surprise in bits, −log₂ of its probability: the
  next action's count out of the last one plus the prior, smoothed toward how common the next action is anywhere (so a
  common action that never followed this one isn't impossible), times the gap's (add-one over its four buckets). A
  transition is scored only once its starting action has 20 counts behind it (real and prior). A transition into an
  action first seen in the last 7 days is new, and scores at most 4 bits: a feature that just shipped doesn't make
  everyone who uses it look unusual. Each flush scores its transitions against the model as it was, before adding
  them, so a sign-in never explains itself. A sign-in's score (D1 `scores`) is its scored steps, their bits in total
  (the mean is the score) and its five most surprising transitions, as templates.
- **A prior from code:** few people use the editor yet, so the counts start from what the editor and the admin app do
  (`FLOWS`: signing in, opening a repository by clone or by the API, committing, a new repository published, your
  sign-ins and account, the admin app's pages), each step counted 20 times, which is enough for every action in a flow
  to be scored from the first day. The runs of our own end-to-end tests as a second source: not yet.
- In the tests (workerd), the editor's flow scores about 2.2 bits a step and a sign-in jumping between calls the editor
  makes but never in that order about 6.1; the next one to jump the same way, after the model has learned from the
  first, about 5.2.
- **Shown:** the sign-ins with the highest scores, each with the transitions that made it so, as templates, on the
  admin app's Unusual page (B9). Ending one is B6's End.
- **Kept and erased with the account:** a purged account's scores go with its grants.

## Never kept

Repository names, paths' values, file contents, header values, IPs in clear, or anything that ties a model count to a
person. A flag points at a sign-in (a grant id); the audit log already says whose it is.

## Steps

- **B7 · the rules.** *Built 2026-10-17* (src/behavior.ts; `signedIn` in src/tokens.ts; `app.notFound` in
  src/index.ts; the Grant's `fingerprint` and `differences` tables): probes recorded and counted with the proxy's
  refusals (five in ten minutes end the sign-in); `proxy_call` templated with `repo#` tags and keyed hashes, and
  `?repo=` on /admin/audit (the admin app's Repository filter); the header fingerprint at `/token`, client kind,
  comparison in `Grant.use`, `client_unusual` and `client_changed`. 9 tests in test/behavior.test.ts and one in
  test/admin.test.ts, in workerd: a route the router has is never a probe (even its own 404), a header added and a
  browser update are tolerated, a downgrade after a refresh isn't. The tests' clients send a browser's headers
  (test/browser.ts). Tried with a real Chromium sign-in through the harness: no `client_unusual`, no `client_changed`.
- **B8 · the model.** *Built 2026-10-17* (src/behavior.ts: `actionOf`, `FLOWS`, `surprisal`, `learn`, `decay`; the
  Grant's `walk`, `pending` and `flush`; migrations/0006): transitions in the Grant, flushed hourly into D1, decayed
  daily, seeded from the editor's and the admin app's flows; each sign-in's score. 6 tests in test/behavior.test.ts:
  actions named by template (ours, the admin's, the proxy's), every flow a call the proxy allows, the score's
  arithmetic, flushing, scoring and learning, and the decay.
- **B9 · the Unusual page.** *Built 2026-10-17:* `GET /admin/unusual` (`behavior:read`, the owner's like every
  permission; `min` scored steps, default 3, and `limit`): sign-ins by mean surprise, highest first, each with its most
  surprising steps and its B7 flags counted (`probe`, `proxy_denied`, `client_unusual`, `client_changed`). The admin
  app's Unusual page draws it in the sign-in table (End included), the proxy's prefix trimmed off each call. A test in
  test/admin.test.ts (order, flags, the `min` filter) and the permission in the refusal test. Tried with the harness: a
  real admin sign-in clicking through the app scored 3.1 bits over 8 steps, the overview's parallel reads its most
  surprising.

## Open questions

- How many probes, and how much change, before a sign-in is ended rather than flagged.
- Whether the scores should alert (`ALERT_WEBHOOK`) or only show.
