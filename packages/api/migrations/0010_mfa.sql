-- Authenticator-app MFA (README.md, C5). A user's TOTP secret, sealed under TOTP_KEK (a key of its own),
-- pending until a code from the app confirms it (`enrolled_at`); the newest 30-second step a code was used for (each
-- step is good once); and the bucket of tries at it (5, one back a minute).
CREATE TABLE totp (
	user_id TEXT PRIMARY KEY REFERENCES users (id),
	secret TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	enrolled_at INTEGER,
	last_step INTEGER NOT NULL,
	tries REAL NOT NULL,
	tries_at INTEGER NOT NULL
);

-- Recovery codes: ten, shown once at enrollment, each kept as an HMAC under CODE_KEY and good once; making new ones
-- replaces them all.
CREATE TABLE recovery_codes (
	user_id TEXT NOT NULL REFERENCES users (id),
	code_hash TEXT NOT NULL,
	used_at INTEGER,
	PRIMARY KEY (user_id, code_hash)
);
