# Admin

Status: **design, 2026-10-17; B1–B4 built.** Decisions are in "Decisions", what's built in "Steps", what's still open at the
end.

The admin app is where accounts and their roles are managed: today, the platform owner (one person) looking after users,
sign-ins, the audit log and traffic; later, customers' organization admins managing their own members. It's part of the
product, not an ops tool bolted on, so it signs in with the product's own identity (packages/api) and every permission
comes from one role model.

## Why not something off the shelf

- **Cloudflare's dashboard** already charts traffic, Workers and logs, and runs SQL on D1. It stays the place for raw
  infrastructure. But it can't show our domain (who a user is, their sign-ins, the audit timeline, the tamper check), and
  it can never be opened to a customer.
- **Hosted identity with an admin console** (Clerk, WorkOS, Auth0, Logto; Better Auth as a library) would bring users,
  roles and a console, but means giving up DPoP-bound tokens and the audit log we built, or running two identity systems.
- **Authorization engines** (OpenFGA and SpiceDB, after Google's Zanzibar; Cerbos; Oso) answer "may X do Y to Z" for
  fine-grained sharing. A role table answers everything we need now. If permissions grow per-repo or per-team, one of
  these replaces `rbac.ts`, behind the same `requires()` call.
- **Admin UI frameworks** (react-admin, Refine) earn their keep on many create-and-edit screens over an API, and are
  React. Web Awesome, already the shell's UI, has the shapes an admin needs (see "The UI").

## Decisions

### One identity, one role model, two kinds of admin

- **The platform owner** (you): operations across every account.
- **Organization admins** (later): their own organization's members and roles, nothing else.

Both are roles in the same model, granted to users of the same identity. The admin app shows each person what their
roles allow.

### Roles and permissions

- **Permissions** are fixed strings in code (`src/rbac.ts` in packages/api): `users:read`, `sessions:read`,
  `sessions:revoke`, `audit:read`, `audit:verify`, `traffic:read`, and later `org:members:read`, `org:members:write`,
  `org:roles:write`.
- **Roles** map to permissions, also in code, so what a role can do is reviewed like any other change:
  - `owner`: every platform permission.
  - Later, per organization: `org_admin`, `org_member`.
- **Who has a role:**
  - `owner` comes from config, not the database: `OWNERS` in wrangler.jsonc, a list of GitHub user ids (not secret). It
    can't be granted or revoked through the API, so a compromised admin session or a bad database write can't create
    another owner. Adding one is a reviewed commit.
  - Organization roles (later) are rows: `organizations`, and `memberships (org_id, user_id, role, granted_by,
    granted_at)`, every change audited.
- **Checked on every request,** from D1 and config, never from claims in the token, so a role taken away is gone at once.
  The API already reads D1 on every request (`grantOf`), so this is one more lookup.

### Admin sessions are separate from editor sessions

- The admin app is its own OAuth client, `client_id: admin`, next to the editor's `editor`. Access tokens already carry
  their client id (RFC 9068), and each sign-in's Grant will remember which client began it.
- **`/admin/*` accepts only `admin` tokens,** and `/github/*` only `editor` ones. Code running on the editor's origin
  (the Cloudflare beacon today, previews later) can use an editor session, but it can never use it to reach admin data,
  even when the person signed in is the owner.
- **Each client has its own redirect pages:** `REDIRECT_URIS` becomes per client, so a sign-in for one can't land on the
  other's origin.
- Sign-in itself is unchanged: the same GitHub App and the same `/auth/github/start`, PKCE and DPoP flow as the shell.

### Its own origin

- `admin.unusuallygood.dev`, static files on Workers static assets like the editor (no Worker runs for page loads).
  Locally, a dev server against the dev API.
- **Strict headers:** a CSP allowing scripts from its own origin and Cloudflare's Web Analytics beacon only (injected
  zone-wide; allowed by choice, 2026-10-17: Cloudflare serves the page anyway), `frame-ancestors 'none'`.

### The admin API

On `editor-api`, under `/admin/*`: each route names the permission it requires (`requires("audit:read")`), so the
route table doubles as the access-control table.

| Route | Permission | What |
|---|---|---|
| `GET /admin/me` | (any admin token) | your user, roles and permissions, for the app to draw itself |
| `GET /admin/users` | `users:read` | users: id, GitHub id, created, live sign-ins, last seen |
| `GET /admin/users/:id` | `users:read` | one user: their sign-ins and recent audit rows |
| `GET /admin/sessions` | `sessions:read` | live sign-ins across users |
| `POST /admin/sessions/:id/revoke` | `sessions:revoke` | end one (later; the first write action) |
| `GET /admin/audit` | `audit:read` | the timeline, with the filters `npm run audit` has |
| `GET /admin/audit/verify` | `audit:verify` | D1 against the R2 copies, run by the Worker (see below) |
| `GET /admin/traffic` | `traffic:read` | Cloudflare's analytics, through the API's own read-only token |

- **Every admin request is audited** (`admin_access`: route, and whose data), kept 365 days. Who looked at a user's data
  is itself part of the security record.
- **The Worker's verify is a convenience, not the check.** A compromised Worker could lie about itself. The independent
  check stays `npm run audit -- --verify` on your machine.
- **Cloudflare data** comes from a new secret, `ANALYTICS_TOKEN`: read-only (Account Analytics Read, Zone Analytics
  Read), used only by `/admin/traffic`. The browser never holds a Cloudflare credential.
- **GitHub logins aren't stored** (README.md in packages/api, "Identity and the data we keep"). *Decided 2026-10-17:* the
  admin app looks each login up live from GitHub by id, and stores nothing. GitHub allows 60 unauthenticated lookups an
  hour, so the app looks up what's on screen and keeps the answers for the session.

### The UI: Web Awesome, from its own recipes

Decided 2026-10-17. Web Awesome's patterns site has a login and an app dashboard, but its pattern library is part of
Web Awesome Pro (paid). The free package ships the same shapes as recipes, in its design skill
(`node_modules/@awesome.me/webawesome/dist/skills/webawesome-design/references/patterns.md`, with component APIs in
`dist/llms.txt` and `dist/skills/webawesome/`):

- **App shell:** `<wa-page>`, with the navigation in `slot="navigation"` once (it becomes the mobile drawer by itself)
  and a header with the signed-in user and Sign out. Pages: Overview, Users, Sessions, Audit, Traffic.
- **Sign-in:** the login card recipe (a centered `<wa-card>`), with one action, "Sign in with GitHub": no email or
  password fields, since GitHub does the authenticating.
- **Overview:** the dashboard card grid recipe: users, live sign-ins, audit rows today, suspicious rows today, requests,
  Worker errors.
- **Lists:** native `<table>` with Web Awesome's native styles (`wa-zebra-rows wa-hover-rows`), `<wa-relative-time>`
  for times, `<wa-badge>` for event classes and roles, `<wa-dialog>` for the confirm step of write actions.
- Preact for rendering, as in the shell. The design skill's rule applies: build with the system (tokens, utilities,
  components), not around it.

### Shared sign-in code

The shell's `session.ts` (oauth4webapi, the non-extractable DPoP key, refresh) is what the admin app needs too. *Decided
2026-10-17:* it moves to `@brianjenkins94/util/auth` (lib), parameterized by client id and API, next to the DPoP code
the API already uses from there, and both apps import it.

## Steps

Each lands green and is useful on its own.

- **B1 · roles in the API.** *Built 2026-10-17:*
  - `src/rbac.ts`: `PERMISSIONS`, `ROLES` (`owner`), `rolesOf` (owner from `OWNERS`, GitHub ids, in wrangler.jsonc),
    `permissionsOf`, and `requires(permission)`, which refuses with a 403 and an `auth_refused` row ("lacks …"). No
    route uses `requires` yet; B2's do, and its tests cover it.
  - `REDIRECT_URIS` is per client: `{ "editor": [...], "admin": [...] }`. Locally and in dev, the admin app's page is
    `http://localhost:5174/`; production's is `https://admin.unusuallygood.dev/` (B5).
  - The `admin` client: `/auth/github/start` takes any client in `REDIRECT_URIS`, only to that client's pages; the
    Grant stores its client (a new column, added in place to existing Grants, whose missing value means `editor`);
    `/token` refuses a code or refresh token presented by another client ("another client").
  - `session` is per client (`session` for the editor's routes, `adminSession` for `/admin/*`): a token issued to the
    other client gets a 403 and an `auth_refused` row ("a token for another client").
  - `src/admin.ts`: the router at `/admin`, recording each answered request (`admin_access`, kept 365 days), and
    `GET /admin/me` (user, roles, permissions).
  - `test/admin.test.ts`, 10 tests in workerd; turning off either client check fails them.
- **B2 · read endpoints.** *Built 2026-10-17* (src/admin.ts): `GET /admin/users`, `/admin/users/:id` (their
  sign-ins with each one's client, and their latest 100 audit rows), `/admin/sessions` (live ones), `/admin/audit`
  (`event`, `user`, `grant`, `ip`, `suspicious`, `since`, `before` for paging, newest first). `grants.client` is new
  (migrations/0004). "Suspicious" leaves out admins reading (`admin_access`, kept a year but expected), here and in
  `npm run audit -- --suspicious`. Tested for each permission (14 tests in test/admin.test.ts).
- **B3 · the admin app.** *Built 2026-10-17* (this package): Vite + Preact + Web Awesome, `npm run dev` on 5174.
  - Sign-in: util/auth/client as the `admin` client with `par` (lib 022052c, 9fddbfd: PAR, and plain HTTP allowed for
    a localhost API only), through the API's sign-in page. Signed in with no role: a "No access" card.
  - Pages (src/views.tsx): Overview (card grid), Users, a user (sign-ins and audit rows), Sign-ins, Audit log
    (filters in the address, older rows a page at a time). GitHub logins looked up live by id (src/logins.ts).
  - Its API: production's on `admin.unusuallygood.dev`, otherwise the harness's (`http://localhost:8787`), or
    `VITE_API`.
  - Tried locally, 2026-10-17: `npm run harness` in packages/api (its GitHub stand-in, harness/github.ts, offers
    "the owner" or "someone else"), `npm run dev` here, and a real browser: PAR, the sign-in page, the stand-in, the
    overview, users, a user, sign-ins, the audit log, sign out, then someone without a role (No access). The harness
    showed every row and copy each step wrote.
- **B4 · traffic.** *Built 2026-10-17:* `GET /admin/traffic?window=1h|6h|24h` (packages/api/src/traffic.ts, behind
  `traffic:read`): one GraphQL request to Cloudflare with `ANALYTICS_TOKEN`, a read-only Account API token
  (`editor-analytics`: Account Analytics Read, and Analytics Read on unusuallygood.dev), set in dev, production and the
  harness's `.dev.vars`; `ANALYTICS_ACCOUNT` and `ANALYTICS_ZONE` are ids in wrangler.jsonc. It answers requests by host
  and status, top paths, agents and countries, requests by hour and host, and each Worker's requests, errors and CPU; a
  missing token is a 503, Cloudflare's refusal a 502 with Cloudflare's message. The app's Traffic page shows it all
  (tables; the Free plan has no ASN or security-event breakdowns). 4 tests in test/traffic.test.ts against a stand-in
  Cloudflare; tried in the browser through the harness with the real token.
- **B5 · production.** *Built 2026-10-17:* `admin.unusuallygood.dev`, the app's build as static assets only
  (packages/site/admin.jsonc, a custom domain; no Worker runs on it), deployed by production.yml after the editor.
  Production's API has its origin in `ALLOWED_ORIGINS` and its page (`https://admin.unusuallygood.dev/`) in
  `REDIRECT_URIS.admin`. Its `_headers` (public/) hold a CSP that allows only its own files, the API, GitHub's API
  (for logins) and Cloudflare's Web Analytics (its beacon, allowed since 2026-10-17); Web Awesome works under
  `style-src 'self'` (checked with `wrangler dev`: no violations). The page itself is never cached.
- **Architecture page.** A live diagram of the system (Workers, Durable Objects, D1, R2, the static hosts, GitHub,
  Cloudflare's analytics), *derived from code*: the wrangler configs, the routes and the bindings, read at build time,
  never drawn by hand. *Zero-knowledge*: it shows the shape and its live counts, never a user's data. Its own renderer,
  not the editor's.
- **B6 · first write.** End a sign-in from the admin app (`sessions:revoke`), with a confirm step, audited.
- **Later:** organizations, memberships and their roles; organization admins in the same app; billing (Stripe).

## Open questions

- **Cloudflare Access in front of the owner's routes** as well, as a second, independent gate. Not needed for B1–B5;
  worth it once customers' admins share the app.
