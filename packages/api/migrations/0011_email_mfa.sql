-- Email as a second factor (README.md, C6): after a password, a code to the account's email too.
-- It stops a stolen password, not a stolen inbox (which can reset the password anyway); the app shows that, and offers
-- an authenticator app first. Who has it on, and since when.
CREATE TABLE email_mfa (
	user_id TEXT PRIMARY KEY REFERENCES users (id),
	enrolled_at INTEGER NOT NULL
);
