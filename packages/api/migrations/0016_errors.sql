-- Errors (OPERATIONS.md, "Errors"; O4): every uncaught error, grouped by its fingerprint (its name and top stack frames,
-- function names only, so a release's new line numbers don't split a group), and each occurrence under the id the
-- person was shown (`E-ABCD-EFGH`). Messages and stacks are redacted (util/redact, and email addresses) before they're
-- stored. `source` is "api" now, "editor" when the editor reports its own (O6). Occurrences are kept 30 days, groups
-- until 90 days after they were last seen (the daily cron); a purged account's occurrences lose their user.
CREATE TABLE errors (
	fingerprint TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	name TEXT NOT NULL,
	message TEXT,
	route TEXT,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	count INTEGER NOT NULL,
	releases TEXT NOT NULL
);

CREATE INDEX errors_by_last_seen ON errors (last_seen);

CREATE TABLE error_occurrences (
	id TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL REFERENCES errors (fingerprint),
	at INTEGER NOT NULL,
	route TEXT,
	release TEXT,
	trace_id TEXT,
	grant_id TEXT,
	user_id TEXT,
	message TEXT,
	stack TEXT
);

CREATE INDEX error_occurrences_by_fingerprint ON error_occurrences (fingerprint, at);

CREATE INDEX error_occurrences_by_grant ON error_occurrences (grant_id, at);
