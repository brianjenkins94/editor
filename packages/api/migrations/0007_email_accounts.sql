-- Email sign-in (README.md, C2). A user may have no GitHub account now, so `github_id` may be null (still unique when
-- it's set). SQLite can't drop a NOT NULL, so `users` is rebuilt, its rows copied; the foreign keys that point at it
-- (grants, and emails below) are checked at the end, once the new table has the old one's name.
PRAGMA defer_foreign_keys = on;

CREATE TABLE users_new (
	id TEXT PRIMARY KEY,
	github_id INTEGER UNIQUE,
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
);

INSERT INTO users_new (id, github_id, created_at, deleted_at) SELECT id, github_id, created_at, deleted_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- A user's email, for those who sign in with one: as typed (not lowercased, nothing stripped: README.md, C2), one account
-- per address whatever its case, and when it was last proven theirs (a code confirmed). GitHub-only users have none.
CREATE TABLE emails (
	address TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL,
	verified_at INTEGER
);

CREATE UNIQUE INDEX emails_by_address ON emails (lower(address));

CREATE INDEX emails_by_user ON emails (user_id);

PRAGMA defer_foreign_keys = off;
