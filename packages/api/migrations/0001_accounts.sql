-- Accounts (README.md, "Identity and the data we keep"): the least we can run on. No login, avatar, email or raw IP.

-- A user: our id, which everything else keys on, and the GitHub account it signs in with (by GitHub's numeric id, since
-- logins can be renamed).
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	github_id INTEGER NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

-- A sign-in, one per Grant Durable Object (its id): for "your sessions" and signing out everywhere. Its tokens live in
-- the Grant, not here.
CREATE TABLE grants (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL,
	revoked_at INTEGER
);

CREATE INDEX grants_by_user ON grants (user_id);

-- The security record: append-only, a user can see their own. Country from Cloudflare; the IP only as an HMAC under a
-- key that changes daily (AUDIT_KEY + the date), so abuse can be spotted within a day and no address recovered.
CREATE TABLE audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	event TEXT NOT NULL,
	user_id TEXT,
	grant_id TEXT,
	country TEXT,
	ip_hash TEXT
);

CREATE INDEX audit_by_user ON audit (user_id, at);
