-- Which OAuth client a sign-in is for (README.md, B1): `editor` or `admin`, so the admin app can tell its
-- own sessions from the editor's. The Grant holds it too; grants from before have none, and are the editor's.
ALTER TABLE grants ADD COLUMN client TEXT;
