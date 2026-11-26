-- The error groups recorded before the queue (0019) was there, queued once each as a new group is now (src/errors.ts):
-- they'd gone uninvestigated (the user, 2026-11-26), and an item each is how they get looked into.
INSERT INTO queue (at, kind, ref, title, detail)
SELECT first_seen, 'error', fingerprint, 'Error: ' || substr(name, 1, 100),
	(CASE source WHEN 'api' THEN 'The API' ELSE 'The editor' END) || ' · ' || coalesce(route, '') || ' · releases ' || releases || char(10)
		|| coalesce(message, '') || char(10) || char(10)
		|| 'Recorded before the queue: ' || count || ' times. Its group: the admin app''s #/errors/' || fingerprint || '.'
FROM errors
WHERE NOT EXISTS (SELECT 1 FROM queue WHERE kind = 'error' AND ref = errors.fingerprint);
