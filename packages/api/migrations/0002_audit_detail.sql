-- The audit log, told fully (README.md, "Hardening"): why a request was refused, what a proxied write touched, and the
-- trace the row came from — so any row joins to that request's logs and spans in Cloudflare's dashboard.

-- A refusal's reason: one of the fixed strings util/auth/dpop and src/*.ts give, never anything a request carried.
ALTER TABLE audit ADD COLUMN reason TEXT;

-- What a proxied call was (`POST /repos/<owner>/<repo>/git/commits`, `GET /user/emails`): method and path, no query.
ALTER TABLE audit ADD COLUMN detail TEXT;

-- The request's trace id (util/logger's `logger.trace_id`, a span attribute in Cloudflare's traces).
ALTER TABLE audit ADD COLUMN trace_id TEXT;

CREATE INDEX audit_by_event ON audit (event, at);
