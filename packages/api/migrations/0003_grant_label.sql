-- "Your sessions" (README.md): a coarse label for each sign-in — the browser and the OS, "Chrome on macOS" — made from
-- the User-Agent when it starts. The User-Agent itself isn't kept.
ALTER TABLE grants ADD COLUMN label TEXT;
