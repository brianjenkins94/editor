-- The editor's own errors (README.md, O6): reported by the shell, signed in or not. Signed out, the only
-- thing kept of who is the IP as the audit log's keyed hash, which changes daily (`ip_hash`); signed in, the user and
-- sign-in, as the API's own errors have. `breadcrumbs`: the last few things that happened before it, by event name only
-- (the session timeline's vocabulary), as a comma list.
ALTER TABLE error_occurrences ADD COLUMN ip_hash TEXT;

ALTER TABLE error_occurrences ADD COLUMN breadcrumbs TEXT;
