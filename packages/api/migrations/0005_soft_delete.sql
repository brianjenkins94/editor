-- Soft account deletion (README.md, "Identity and the data we keep"): a deleted account is marked, every sign-in
-- ended at once, and kept 30 days, when signing in again restores it; after that the daily cron purges it for good.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;
