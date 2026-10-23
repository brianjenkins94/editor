-- The narrower switches (README.md O8): one row per switch once it's first flipped; no row is on. `paused` says
-- that part of the API refuses (src/maintenance.ts, SWITCHES); `reason`, `by` and `at` as for the kill switch, and
-- `noticed` the same: 0 until a Worker has audited the flip and emailed the owner.
CREATE TABLE switches (
	name TEXT PRIMARY KEY,
	paused INTEGER NOT NULL,
	reason TEXT,
	by TEXT,
	at INTEGER NOT NULL,
	noticed INTEGER NOT NULL DEFAULT 0
);
