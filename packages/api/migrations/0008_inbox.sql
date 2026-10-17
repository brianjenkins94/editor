-- Our own inbox (packages/admin/README.md, the Mail page): email to a few addresses of ours on the zone (INBOX in
-- wrangler.jsonc: the smoke test's), routed by Email Routing to this Worker's `email` handler. Who sent it, its subject
-- and size; never its body. Kept a day (the daily cron), long enough for the smoke test and a look.
CREATE TABLE inbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	address TEXT NOT NULL,
	sender TEXT NOT NULL,
	subject TEXT NOT NULL,
	size INTEGER NOT NULL
);

CREATE INDEX inbox_by_address ON inbox (address, at);
