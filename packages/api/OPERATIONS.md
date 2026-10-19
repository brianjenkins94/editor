# Operations: cost guard, kill switch, tripwire, session timelines, errors

Status: **design, 2026-10-19; O1, O2 and O3 built.** Decided with the owner the same day: session replay is an **event timeline** (no
screen, no code, no keystrokes); the kill switch takes down **the API only**; runaway costs **email the owner and trip
the switch automatically**, against a **$20 a day** budget.

Five concerns, one theme: notice trouble before it's expensive or harmful, stop it with one switch, and make any one
person's problem easy to look into. Each step lands green, tested in workerd, as the sign-in steps did (SIGN-IN.md).

## The kill switch

- **One row, one meaning:** `maintenance` in D1 (`on`, `reason`, `by`, `at`). Every Worker isolate reads it at most
  every 10 seconds (kept in memory between), so turning it on takes effect everywhere within seconds, costs one D1 read
  per isolate per 10 seconds, and needs no deploy.
- **On:** the API answers everything `503 {"error": "maintenance", "reason": "Down for maintenance"}` with
  `Retry-After`, before any other work (no D1, Durable Object or GitHub call), **except** what the owner needs to look
  and turn it off: the admin app's sign-in by GitHub or a passkey (the methods that can hold a role), and `/admin/*` for
  the owner role only (not viewers).
- **The editor stays up:** it's static and works signed out. Signed in, it shows "Signing in is down for maintenance"
  and carries on as signed out (public repos). The admin app shows the reason and, for the owner, the switch.
- **Who flips it:** the owner from the admin app (a new `maintenance:switch` permission, owner only); the cost guard and
  the tripwire, automatically. **Break glass**, when even the admin app can't be reached:
  `npm run maintenance -- off --env production` in packages/api, which is `wrangler d1 execute` on that row with your own
  Cloudflare login (no secret endpoint to protect).
- **Every flip** is an audit row (`maintenance_on`, `maintenance_off`, with who or what and why) and an **email to the
  owner**: a new secret `ALERT_EMAIL` (your address stays out of the repo), sent through the `EMAIL` binding we already
  send codes with. This reverses "alerts are log-only" for these events only: the switch, the cost guard and the
  tripwire are what must reach you.
- **Not the sites:** the editor and admin sites are static assets, which cost nothing to serve; they stay up.

## The cost guard

- **What's billed:** the Workers Paid plan's usage, meter by meter: Worker requests and CPU time, D1 rows read and
  written, Durable Object requests and duration, R2 operations, emails sent. Static asset requests aren't billed.
- **Hourly** (a second cron), the Worker asks Cloudflare's GraphQL Analytics (the read-only token we already hold, see
  src/traffic.ts) for each meter's usage over the last 24 hours and **prices it at the overage rates** (a price table in
  code, checked against Cloudflare's pricing page when built). That ignores the plan's included amounts, so it
  overestimates: a runaway shows up early, never late.
- **Thresholds:** half the daily budget ($10): an email, once a day at most. The whole budget ($20): the kill switch
  on, reason "spend", and an email saying which meter. Both audited (`spend_warning`, `spend_tripped`).
- **The admin app** shows the estimate on the Traffic page: today's spend by meter, the budget, the last 14 days.
- **Cloudflare's own billing notification** is the backstop if our check itself fails: your click, in the dashboard
  (Notifications → Usage Based Billing). The check also emails if it couldn't read the analytics three hours running.
- **Floods** that never reach the Worker's logic are already capped by the per-IP and per-sign-in rate limits; the
  switch's early 503 keeps a flood that does reach it to the cheapest kind of request.

## The tripwire: no one reads another person's data

Defence in depth for "should they figure out how": every handler is meant to read only the signed-in user's rows; this
checks the result, not the intent, and treats a breach as an incident.

- **Ownership invariant.** For every request made with a user's sign-in (the editor's or the admin app's, but not
  admin routes with a permission that reads across users), the request's D1 binding is wrapped: any row it returns that
  names a user (`user_id`, or `users.id`) other than the signed-in one is a breach. The few reads that look at another
  account on purpose are named in code (`crossUser("link: whose is this address")`: linking's ownership check and
  `mergeable`, src/link.ts), reviewed like roles. Sign-in steps before anyone is signed in aren't checked: they find a
  user, they don't show one.
- **A canary account** per environment: a user with an identity and a grant that no real flow ever touches. Any
  request's results naming it, outside the owner's admin reads, is a breach: no false positives by construction.
- **A breach:** the request is answered 500 (nothing returned), the offending sign-in and all of its user's sign-ins
  end, the kill switch goes on (reason "tripwire"), the owner is emailed, and an audit row records the route, the query
  (its text, never its values) and both users.
- **Report only first:** for its first week in production the invariant emails and audits but doesn't trip, so a
  reviewed-but-missed legitimate read can't take the API down; the canary trips from day one. The test suite runs every
  route under the wrapper, so CI catches a handler that reads across users before it ships.
- Attempts that fail (another user's session id, a guessed path) are already refused and audited as probes
  (BEHAVIOR.md); the tripwire is for a read that **succeeded**.

## Session timelines

An event timeline per sign-in, for drilling into one person's session from the admin app. Only for signed-in people:
signed out, nothing is recorded (as now). No screen, no code, no keystrokes, no file contents.

- **Server side:** each request through a sign-in is an event (time, route template, status, duration, trace id), held
  in that sign-in's Grant Durable Object, which already sees every such request (BEHAVIOR.md). Audit rows and errors
  join by grant id and trace id. Kept for the sign-in's life plus 30 days, gone with the account.
- **Editor side:** a fixed vocabulary of events, batched every few seconds to `POST /session/events`: a repo loaded
  (its repository tag, the keyed hash the audit log uses, not its name), a pane opened, a command run (its id), a run
  started and ended, a page shown, an error (below). Anything outside the vocabulary is dropped by the API. Sizes are
  capped per batch and per sign-in per day.
- **The admin app:** a sign-in's page gets a **Timeline**: server requests, editor events, audit rows and errors, in
  order, each linking to its trace in Cloudflare's logs. Reading a timeline is itself audited (`admin_access`), as every
  admin read is. A permission of its own (`sessions:replay`), owner and viewer.
- **Privacy note** for the README's "data we keep": what's recorded, for whom (signed-in only), how long.

## Errors

Make "it broke" one click from the person's own words to the cause.

- **Every error gets an id** the person can quote: `E-7K2P-9QXM`, shown in the editor's error notice and in the API's
  500 answer.
- **Server:** `app.onError` records each uncaught error: fingerprint (its name and top stack frames, normalized),
  message (redacted by util/redact), route, release (the deployed commit), trace id, grant. Grouped by fingerprint in an
  `errors` table (first and last seen, count, releases); each occurrence also lands on the sign-in's timeline.
- **Editor:** the observability package already catches the shell's and workbench's errors (`tapConsoleAndErrors`) and
  keeps a recent-log ring (`logBacklog`). On an error the shell sends `POST /errors`: fingerprint, redacted message,
  stack, release, the last few breadcrumbs (event names only, as the timeline's). **Signed out too**, but anonymous: no
  user, no sign-in, the IP only as the audit log's daily keyed hash; errors are worth knowing about from everyone, and
  that records no one.
- **Readable stacks:** the editor's build keeps its source maps beside the release (not served to the public); the
  admin app maps a stack through them when it's shown.
- **The admin app:** an **Errors** page: groups by count and recency, new since a release highlighted; a group's
  occurrences; an occurrence's stack, breadcrumbs and, when signed in, its sign-in's timeline. Search by error id.
- Alerting: a new fingerprint, or one whose rate jumps, emails the owner (at most hourly), through the same channel.

## Steps

Each lands green and is tried before the next.

- **O1 · the kill switch.** *Built 2026-10-19* (src/maintenance.ts, migrations/0014, scripts/maintenance.ts; the admin
  app's src/maintenance.tsx):
  - The row has `noticed`: whoever flips it leaves it 0, and the first Worker to read it audits the flip and emails the
    owner, once (a conditional update). So the admin app's flips and break-glass ones are recorded alike; the script
    asks `/status` afterwards so a Worker notices at once.
  - Owner's way back in: `/health`, `/status`, `/.well-known/*`, `/revoke`, the attempt routes (only admin attempts can
    be opened while it's on: `/auth/par`, `/auth/start` and `/token` take the admin client only), and `/admin/*`, which
    lets only the owner role through. `/auth/attempt` offers GitHub and passkeys only.
  - Unreadable (D1 down): open, logged; a switch that can't be read mustn't turn every request into an error.
  - `GET /status` (`{ maintenance }`, no reason): what the editor asks before offering a sign-in, and when signed in; on
    it, it says "Signing in is down for maintenance" and works as signed out. The daily smoke test skips while it's on.
  - `tellOwner` (src/mail.ts, templates src/owner-alert.*) emails ALERT_EMAIL; set it in dev and production with
    `npx wrangler secret put ALERT_EMAIL --env <environment>` (your address, typed by you).
  - 2 tests in test/maintenance.test.ts (on by the owner, everyone else down, the owner's way back in, off, audited and
    emailed; a break-glass flip noticed by the next request, once). Tried in the harness: on from the Overview, the
    banner, `/status`, a refused route, off from the banner.
- **O2 · the cost guard.** *Built 2026-10-19* (src/spend.ts; the admin app's Traffic page):
  - One GraphQL query, by day: Worker requests and CPU (`workersInvocationsAdaptive`), D1 rows
    (`d1AnalyticsAdaptiveGroups`), Durable Object requests (`durableObjectsInvocationsAdaptiveGroups`) and duration in
    GB-s and rows (`durableObjectsPeriodicGroups`), R2 operations by action, classed A or B, deletes free
    (`r2OperationsAdaptiveGroups`), emails sent (`emailSendingAdaptiveGroups`). The account's, both deployments: it's
    the account that's billed, so each deployment guards itself against the whole.
  - `PRICES`: the overage rates from Cloudflare's pricing pages on 2026-10-19. `BUDGET` $20, `WARN_AT` $10.
  - Hourly at :07 (a second cron). Past half, `spend_warning` and an email, once a day. At the budget, `spend_tripped`,
    the switch on "by cost guard", and an email with the breakdown. **After a person turns the switch off,** the
    trailing 24 hours stay high a while, so for a day it trips only at double the budget.
  - Unreadable: `spend_unreadable` each hour; three in a row, `spend_blind` and an email (once a day). Blind isn't a
    trip.
  - `GET /admin/spend` (`traffic:read`): the last 24 hours by meter, the budget, 14 days by day; the Traffic page's
    Spend section. First reading in production's account: $0.0015 a day.
  - 3 tests in test/spend.test.ts, against a GraphQL stand-in, the cron triggered through the harness. Your click:
    Cloudflare's own billing notification (dashboard → Notifications → Usage Based Billing), the backstop.
- **O3 · the tripwire.** *Built 2026-10-19* (src/tripwire.ts):
  - **Watched:** every request through a user's sign-in, either client (the session middleware, src/tokens.ts, hands the
    rest of the request a watched D1 binding). A route's permission lifts the watch (`requires`, src/rbac.ts): reading
    across users is what admin permissions are for. `crossUser(db, why)` for a read that looks at another account on
    purpose: one today, linking's `ownerOf` (src/identities.ts). The editor's session revoke now asks only for the
    caller's own sign-in rather than reading any and comparing.
  - **Seen:** every row of `first`, `all`, `raw` and `batch`: a `user_id` that isn't the signed-in user's, or any value
    that's the canary's. Grant and Attempt Durable Objects' own reads aren't watched (open question below).
  - **The canary:** a user, an email identity and a live sign-in, ids derived from AUDIT_KEY (the public repo doesn't
    name them), made idempotently by the hourly cron.
  - **Enforcing** from `ENFORCE_FROM` (2026-10-26) for another user's row; the canary from the start; and always locally
    and in the tests (`TRIPWIRE: "enforce"`, wrangler.jsonc's local vars), so the whole suite (every route it drives)
    fails on a cross-user read instead of passing with a report. It passed: no route reads another user's row.
  - **A breach:** 500 `{ error: internal }`, the user's sign-ins revoked, the switch on "by tripwire", `tripwire` audited
    (route, query text, the value read), the owner emailed. **Reported** (before enforcing): `tripwire_report`, the owner
    emailed at most hourly.
  - 4 tests in test/tripwire.test.ts (the canary seeded; a request reading the canary's value end to end; the watched
    binding against a stand-in D1: another user's row trips or is reported, one's own doesn't, `crossUser` is
    unwatched; the canary in any column, a batch and raw rows).
- **O4 · server errors.** Error ids, `onError`, the `errors` table, the Errors page.
- **O5 · server timelines.** Request events in the Grant, the Timeline on a sign-in's page, `sessions:replay`.
- **O6 · editor events and errors.** The vocabulary, `POST /session/events`, `POST /errors` (signed in and anonymous),
  the editor's error notice with its id.
- **O7 · readable stacks.** Source maps kept per release, stacks mapped in the admin app.

## Open questions

- The price table's rates, and whether to subtract the plan's included amounts later (more accurate, less early).
- Whether the tripwire should also cover the Grant and Attempt Durable Objects' own reads (they read by their own id,
  so a breach there needs a wrong id passed in, which the invariant on D1 would see first).
- Error and timeline retention beyond 30 days, if investigations turn out to need it.
