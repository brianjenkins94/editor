-- The queue (src/queue.ts): what was found that someone should look into, so it isn't left unnoticed — a new error
-- group, as it's first recorded; the weekly review of agents' tool use, from the daily cron. Each stays open until it's
-- closed with what was done about it (`outcome`, by `closed_by`). The admin app's Queue page shows them; asked to
-- address the queue, an agent reads and closes them (scripts/queue.ts). Closed items kept a year (the daily cron).
CREATE TABLE queue (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,
	ref TEXT,
	title TEXT NOT NULL,
	detail TEXT,
	closed_at INTEGER,
	closed_by TEXT,
	outcome TEXT
);

CREATE INDEX queue_open ON queue (closed_at, at);
