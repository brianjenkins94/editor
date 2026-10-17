# Admin

Status: **design, 2026-10-17.** Nothing here is built yet. The decision so far is in "Decisions"; what's still open is at
the end.

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
- **Strict headers:** a CSP allowing scripts from its own origin only, `frame-ancestors 'none'`, no third-party scripts.
- **Before it's deployed,** Cloudflare's Web Analytics beacon must be excluded from this host; it's injected zone-wide
  today.

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
- **GitHub logins aren't stored** (README.md in packages/api, "Identity and the data we keep"). The admin app shows the
  GitHub id and looks the login up when asked (see "Open questions").

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

The shell's `session.ts` (oauth4webapi, the non-extractable DPoP key, refresh) is what the admin app needs too. It moves
somewhere both can import, parameterized by client id and API, rather than being copied.

## Steps

Each lands green and is useful on its own.

- **B1 · roles in the API.** `src/rbac.ts` (permissions, roles, `requires()`), `OWNERS`, per-client redirect pages,
  the `admin` client, the Grant remembering its client, `/admin/*` refusing editor tokens, `GET /admin/me`. Tested in
  workerd: an editor token is refused, a non-owner is refused, the owner gets their permissions.
- **B2 · read endpoints.** users, a user, sessions, audit (with filters), `admin_access` audit rows. Tested for each
  permission.
- **B3 · the admin app.** `packages/admin`: Preact + Web Awesome (the app shell, sign-in card and card grid recipes),
  the shared sign-in, and views for the overview, users, a user, sessions and the audit timeline. Verified in the
  browser against the dev API, with screenshots.
- **B4 · traffic.** `ANALYTICS_TOKEN`, `GET /admin/traffic`, and a traffic view: requests by host and status, top
  paths, agents, countries, Worker errors and CPU.
- **B5 · production.** `admin.unusuallygood.dev` (static assets, custom domain), its redirect page and origin in
  production's config, the beacon excluded from the host, deployed by production.yml.
- **B6 · first write.** End a sign-in from the admin app (`sessions:revoke`), with a confirm step, audited.
- **Later:** organizations, memberships and their roles; organization admins in the same app; billing (Stripe).

## Open questions

- **Where the shared sign-in code lives:** a small package in this repo, or `@brianjenkins94/util/auth`.
- **GitHub logins in the admin app:** look each up live from GitHub by id (nothing stored; GitHub's unauthenticated
  limit is 60 lookups an hour), or store the login (one more field we'd hold about every user).
- **Cloudflare Access in front of the owner's routes** as well, as a second, independent gate. Not needed for B1–B5;
  worth it once customers' admins share the app.
