-- The likely next action (BEHAVIOR.md, B8). The model: how often each action followed each other one, by the gap between
-- them, across every sign-in. Counts only, no user or sign-in in them; decayed daily, so they follow the product.
CREATE TABLE transitions (
	from_action TEXT NOT NULL,
	to_action TEXT NOT NULL,
	gap INTEGER NOT NULL,
	count REAL NOT NULL,
	PRIMARY KEY (from_action, to_action, gap)
);

-- When each action was first seen: a transition into one that's new is counted as new, not unlikely.
CREATE TABLE actions (
	action TEXT PRIMARY KEY,
	first_seen INTEGER NOT NULL
);

-- Each sign-in's score: how many of its transitions were scored, their surprisal in total (bits), and the most
-- surprising ones (templates only). What B9's Unusual page lists.
CREATE TABLE scores (
	grant_id TEXT PRIMARY KEY REFERENCES grants (id),
	steps INTEGER NOT NULL,
	bits REAL NOT NULL,
	top TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
