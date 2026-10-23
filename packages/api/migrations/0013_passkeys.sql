-- Passkeys (README.md, "Passkeys"): WebAuthn credentials, a user's own (an account can have several), each the
-- authenticator's public key and what checking a sign-in with it needs. Never a private key: that stays on the device.
-- `id` is the credential's id (base64url), `public_key` its COSE key (base64url), `counter` the authenticator's sign count
-- (0 for those that keep none, synced passkeys mostly), `backed_up` whether it syncs (a passkey manager) or lives on one
-- device. Bound to the API's own host (its relying party id), so only our sign-in page can use them.
CREATE TABLE passkeys (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	public_key TEXT NOT NULL,
	counter INTEGER NOT NULL,
	transports TEXT,
	aaguid TEXT,
	backed_up INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

CREATE INDEX passkeys_by_user ON passkeys (user_id);
