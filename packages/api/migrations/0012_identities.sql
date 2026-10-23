-- Linked identities (README.md, "Linking accounts, and roles"): each way of proving who you are is a row pointing at its user, as
-- Auth.js's `accounts` and Supabase's `auth.identities` keep them. `provider` is "github" (`subject`: GitHub's numeric
-- id, as text, since logins can be renamed) or "email" (`subject`: the address as typed, one account per address
-- whatever its case). An account has at most one of each, for now. `users.github_id` and `emails` move here; `users`
-- keeps our id only. SQLite can't drop a UNIQUE column, so `users` is rebuilt, its rows copied; the foreign keys that
-- point at it are checked at the end, once the new table has the old one's name.
PRAGMA defer_foreign_keys = on;

CREATE TABLE identities (
	provider TEXT NOT NULL,
	subject TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL,
	verified_at INTEGER
);

CREATE UNIQUE INDEX identities_by_subject ON identities (provider, lower(subject));

CREATE UNIQUE INDEX identities_by_user ON identities (user_id, provider);

INSERT INTO identities (provider, subject, user_id, created_at, verified_at) SELECT 'github', CAST(github_id AS TEXT), id, created_at, created_at FROM users WHERE github_id IS NOT NULL;

INSERT INTO identities (provider, subject, user_id, created_at, verified_at) SELECT 'email', address, user_id, created_at, verified_at FROM emails;

DROP TABLE emails;

CREATE TABLE users_new (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
);

INSERT INTO users_new (id, created_at, deleted_at) SELECT id, created_at, deleted_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- How each sign-in was made (the `login` row's method: "github", "email", "password+totp"…), which admin roles go by
-- (src/rbac.ts). Sign-ins from before are given their login row's.
ALTER TABLE grants ADD COLUMN method TEXT;

UPDATE grants SET method = (SELECT reason FROM audit WHERE audit.event = 'login' AND audit.grant_id = grants.id ORDER BY audit.id LIMIT 1);

PRAGMA defer_foreign_keys = off;
