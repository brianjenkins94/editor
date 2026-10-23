-- Every email to the owner (README.md, O1: the kill switch, the cost guard, the tripwire, errors), what it said and
-- whether Email Service took it (`sent`, its `message_id`; or `reason`, why not), so the admin app's Mail page shows each
-- one with Cloudflare's own delivery status for it: no one has to ask whether an alert arrived. The owner's address
-- isn't kept: it's ALERT_EMAIL. Kept 90 days (the daily cron).
CREATE TABLE alerts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	subject TEXT NOT NULL,
	text TEXT NOT NULL,
	sent INTEGER NOT NULL,
	message_id TEXT,
	reason TEXT
);

CREATE INDEX alerts_by_at ON alerts (at);
