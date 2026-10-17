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
  never a probe. Each action also notes the deploy it was first seen in (the Worker's version metadata), so the
  statistics below treat it as new rather than unlikely.
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

- A sign-in's actions in order, each with a coarse gap since the last (under 100 ms, under 1 s, under 10 s, longer),
  are a chain. The model is how often each action follows each other one, across every sign-in: counts only, with no
  user or sign-in in them.
- **Where the counts live:** the Grant keeps its own sign-in's transitions (it sees every request already) and adds them
  to the shared counts in D1 on an hourly alarm, batched. The daily cron decays the shared counts (×0.97 a day, a
  half-life of about three weeks), so the model follows the product as it changes.
- **The score:** how surprising a sign-in's transitions were, on average (−log of each one's probability, smoothed,
  falling back to how common the next action is on its own). A transition is scored only once its starting action has
  enough observations, and a transition into an action first seen in the last few deploys is counted as new, capped:
  so a feature that just shipped doesn't make everyone who uses it look unusual.
- **A prior from code:** few people use the editor yet, so the counts start from what the editor does: its flows
  (opening a repository is a ref, a commit, a tree and its blobs; a commit is blobs, a tree, a commit and a ref) and the
  runs of our own end-to-end tests.
- **Shown:** the sign-ins with the highest scores, each with the transitions that made it so, as templates, on the
  admin app's Unusual page. Ending one is B6's End.

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
- **B8 · the model.** Transitions in the Grant, flushed hourly into D1 (a migration), decayed daily, seeded from the
  editor's flows; the score.
- **B9 · the Unusual page.** `GET /admin/unusual` (a new permission, `behavior:read`) and the admin app's page.

## Open questions

- How many probes, and how much change, before a sign-in is ended rather than flagged.
- Whether the scores should alert (`ALERT_WEBHOOK`) or only show.
