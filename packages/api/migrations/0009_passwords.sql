-- Passwords (SIGN-IN.md, "Passwords"; C3). A user's password as its Argon2id hash (a PHC string: the parameters, the
-- salt and the hash, so stronger parameters later still verify the old), when it was set, and the bucket of tries at
-- it (5, one back a minute: no lockouts).
CREATE TABLE passwords (
	user_id TEXT PRIMARY KEY REFERENCES users (id),
	hash TEXT NOT NULL,
	set_at INTEGER NOT NULL,
	tries REAL NOT NULL,
	tries_at INTEGER NOT NULL
);

-- A code for one action of a signed-in user (setting a password: SIGN-IN.md, an action-specific check), emailed to
-- their address: its HMAC, until it's used or its 10 minutes are up, and the tries at it.
CREATE TABLE action_codes (
	user_id TEXT NOT NULL REFERENCES users (id),
	action TEXT NOT NULL,
	code_hash TEXT NOT NULL,
	expires INTEGER NOT NULL,
	tries REAL NOT NULL,
	tries_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, action)
);
